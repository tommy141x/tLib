/**
 * Stream Deck plugin packing, and the staleness gate that keeps it honest. Until this
 * existed, nothing built the three resources' packed `.streamDeckPlugin`: one committed
 * artifact held 29 files where a pack of the same tree produced 38, and nothing reported it.
 *
 * Output goes into the resource's own `docs/public/` — never `.build/dist/` (the plugin is a
 * Node program the customer installs, not resource runtime, and staging would route it
 * through `createZip`'s credential sanitizer) and never tWeb's tree (that's the website's own
 * sync step).
 *
 * The gate stamps content, not timestamps: git doesn't record mtimes, so a fresh clone's
 * checkout-time mtimes would make an mtime gate green on stale bytes and intermittently red
 * on fresh ones. It hashes the source set and the artifact's own sha256 (so a stale artifact
 * needs forging two hashes), reporting mtimes but never asserting on them. Re-packing and
 * comparing isn't an option either — a zip's per-entry timestamps differ between two packs of
 * an unchanged tree. `scanDeckSources` throws on an empty source set rather than returning
 * `[]`, since a renamed directory would otherwise hash the empty string and agree with itself
 * forever; `scripts/deck-stale-control.ts` plants that defect and requires it to go red.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { installDeps, run, step } from "./core.ts";

/** Where a resource's Stream Deck plugin lives and where its pack is published. */
export interface DeckPluginConfig {
  /** Resource root — the directory holding `client/`, `docs/`, `fxmanifest.lua`. */
  root: string;
  /** Plugin UUID, e.g. `com.timmyg-studios.tradio`. Names both the directory and the file. */
  pluginId: string;
  /** Plugin project directory, relative to `root`. */
  pluginDir?: string;
  /** Where the packed artifact is published, relative to `root`. */
  publicDir?: string;
}

export interface DeckPaths {
  /** Absolute path of the plugin project (`<root>/client/stream-deck`). */
  pluginRoot: string;
  /** Absolute path of the unpacked plugin (`…/<id>.sdPlugin`). */
  sdPlugin: string;
  /** Where `streamdeck pack` drops its output: the plugin project directory. */
  packed: string;
  /** The published copy, under `docs/public/`. */
  published: string;
  /** The content stamp, beside the plugin project. */
  stamp: string;
  /** `<id>.streamDeckPlugin`. */
  fileName: string;
}

export interface DeckSourceFile {
  /** POSIX, relative to `pluginRoot`. */
  rel: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface DeckSourceScan {
  files: DeckSourceFile[];
  /** sha256 over `<rel>\0<sha256>\n` for every file, in sorted order. */
  hash: string;
  /** Newest `mtimeMs` across the set, and the file it came from. Reported, never asserted. */
  newest: { rel: string; mtimeMs: number };
}

export interface DeckStamp {
  pluginId: string;
  /** Relative to the resource root, POSIX — which artifact this stamp is about. */
  artifact: string;
  artifactSha256: string;
  artifactBytes: number;
  sourceHash: string;
  sourceFiles: number;
  /** ISO 8601. Informational: the gate asserts on hashes, not on this. */
  packedAt: string;
}

export interface DeckCheckResult {
  ok: boolean;
  problems: string[];
  /** Lines worth printing even on a pass, so a green run shows what it measured. */
  notes: string[];
  scan: DeckSourceScan;
  stamp: DeckStamp | null;
}

const DEFAULT_PLUGIN_DIR = "client/stream-deck";
const DEFAULT_PUBLIC_DIR = "docs/public";

/**
 * Build output and host logs, not source.
 */
const SKIP_DIRS = new Set(["bin", "logs", "node_modules"]);

/**
 * The shared Windows launcher `CodePathWin` points at, and the files that decide its bytes.
 * Built here because the thing it replaces was built nowhere: Stream Deck starts a Node
 * plugin with `node.exe`, a console-subsystem binary, so Windows opens a blank terminal
 * window per plugin. The first fix, `bun build --compile --windows-hide-console`, embedded
 * 114 MB of Bun runtime per plugin (99.8% of the bundle, over Cloudflare Workers' 25 MiB
 * asset cap — it took deploys down twice in one day) with no notice file for any of Node,
 * V8, OpenSSL, libuv, ICU, zlib, llhttp, nghttp2 or brotli, built by a hand-typed command in
 * no script. `shared/rust/deck-launcher` is 0.2 MB, embeds nothing, and resolves the Node the
 * host would itself have used.
 */
const LAUNCHER_DIR = join(import.meta.dir, "../../rust/deck-launcher");
const LAUNCHER_SOURCES = ["Cargo.toml", "build.rs", "src/main.rs"];
/** Explicit, so the pack cannot depend on which host it ran on. */
const LAUNCHER_TRIPLE = "x86_64-pc-windows-msvc";
const LAUNCHER_BUILD_DIR = join(import.meta.dir, "../../../.build/deck-launcher");

interface DeckManifest {
  CodePathWin?: string;
  Nodejs?: { Version?: string };
}

function readManifest(paths: DeckPaths): DeckManifest | null {
  const path = join(paths.sdPlugin, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeckManifest;
  } catch (e) {
    throw new Error(`Stream Deck manifest is not readable JSON (${path}): ${String(e)}`);
  }
}

/**
 * `CodePathWin` when it names a native binary this build is responsible for
 * producing. A `.js` there means the host launches node itself, which is the
 * arrangement the launcher exists to replace — so there is nothing to build.
 */
function launcherTarget(manifest: DeckManifest | null): string | null {
  const path = manifest?.CodePathWin;
  return path?.toLowerCase().endsWith(".exe") ? path : null;
}

export function deckPaths(cfg: DeckPluginConfig): DeckPaths {
  const pluginRoot = join(cfg.root, cfg.pluginDir ?? DEFAULT_PLUGIN_DIR);
  const fileName = `${cfg.pluginId}.streamDeckPlugin`;
  return {
    pluginRoot,
    sdPlugin: join(pluginRoot, `${cfg.pluginId}.sdPlugin`),
    packed: join(pluginRoot, fileName),
    published: join(cfg.root, cfg.publicDir ?? DEFAULT_PUBLIC_DIR, fileName),
    stamp: join(pluginRoot, `${fileName}.stamp.json`),
    fileName,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir: string, base: string, acc: DeckSourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(join(dir, entry.name), base, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    const st = statSync(full);
    acc.push({
      rel: relative(base, full).replaceAll("\\", "/"),
      sha256: sha256File(full),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
}

/**
 * Every file the packed artifact is built from.
 *
 * Throws on an empty result. See the header: a zero-file scan here would hash
 * the empty string and agree with itself forever.
 */
export function scanDeckSources(cfg: DeckPluginConfig): DeckSourceScan {
  const paths = deckPaths(cfg);
  if (!existsSync(paths.sdPlugin)) {
    throw new Error(
      `Stream Deck source tree not found: ${paths.sdPlugin}. Either ${cfg.pluginId} is wrong ` +
        "or the plugin moved — in both cases this scan would measure nothing."
    );
  }

  const files: DeckSourceFile[] = [];
  walkFiles(paths.sdPlugin, paths.pluginRoot, files);

  const srcDir = join(paths.pluginRoot, "src");
  if (!existsSync(srcDir)) {
    throw new Error(
      `Stream Deck plugin has no src/: ${srcDir}. bin/plugin.js is built from it, so a tree ` +
        "without one means the scan is pointed at the wrong directory."
    );
  }
  walkFiles(srcDir, paths.pluginRoot, files);

  for (const name of ["rollup.config.mjs", "tsconfig.json", "package.json"]) {
    const full = join(paths.pluginRoot, name);
    if (!existsSync(full)) {
      throw new Error(
        `Stream Deck plugin is missing ${name} (${full}). It decides what the bundle comes out ` +
          "as, so hashing the sources without it would miss a change that alters the artifact."
      );
    }
    const st = statSync(full);
    files.push({ rel: name, sha256: sha256File(full), size: st.size, mtimeMs: st.mtimeMs });
  }

  // The launcher is an input to the artifact exactly like `src/` is, so editing
  // it has to make the gate go red. It is hashed only for a plugin that actually
  // embeds one: a manifest with no native `CodePathWin` does not ship it, and
  // hashing it there would report every plugin stale on a launcher change.
  if (launcherTarget(readManifest(paths))) {
    for (const name of LAUNCHER_SOURCES) {
      const full = join(LAUNCHER_DIR, name);
      if (!existsSync(full)) {
        throw new Error(
          `The shared Stream Deck launcher is missing ${name} (${full}). CodePathWin names a ` +
            "native binary, so this scan would hash the artifact's sources without the sources " +
            "of the one file in it that is not built from this resource."
        );
      }
      const st = statSync(full);
      files.push({
        rel: `tLib/shared/rust/deck-launcher/${name}`,
        sha256: sha256File(full),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  if (files.length === 0) {
    throw new Error(
      `Stream Deck source scan found NO files under ${paths.pluginRoot}. That is not a clean ` +
        "tree, it is a broken scan: it would hash the empty string and pass forever."
    );
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const digest = createHash("sha256");
  for (const f of files) digest.update(`${f.rel}\0${f.sha256}\n`);

  const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return {
    files,
    hash: digest.digest("hex"),
    newest: { rel: newest.rel, mtimeMs: newest.mtimeMs },
  };
}

export function readDeckStamp(cfg: DeckPluginConfig): DeckStamp | null {
  const path = deckPaths(cfg).stamp;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeckStamp;
  } catch (e) {
    throw new Error(`Stream Deck stamp is not readable JSON (${path}): ${String(e)}`);
  }
}

/**
 * Does the published artifact still match the sources it was packed from?
 */
export function checkDeckArtifact(cfg: DeckPluginConfig): DeckCheckResult {
  const paths = deckPaths(cfg);
  const scan = scanDeckSources(cfg);
  const problems: string[] = [];
  const notes: string[] = [];

  notes.push(
    `${scan.files.length} source files, hash ${scan.hash.slice(0, 16)}…  ` +
      `(newest on disk: ${scan.newest.rel})`
  );

  if (!existsSync(paths.published)) {
    problems.push(
      `the published artifact does not exist: ${paths.published}\n` +
        "    The docs download link points at it, so the page is a 404 until it is packed."
    );
    return { ok: false, problems, notes, scan, stamp: null };
  }

  const artifactSha = sha256File(paths.published);
  const artifactBytes = statSync(paths.published).size;
  const artifactMtime = statSync(paths.published).mtimeMs;
  notes.push(
    `artifact ${paths.fileName}: ${artifactBytes} bytes, sha256 ${artifactSha.slice(0, 16)}…`
  );
  // Reported, never asserted — git does not record mtimes. See the header.
  if (scan.newest.mtimeMs > artifactMtime) {
    notes.push(
      `mtime note: ${scan.newest.rel} is newer on disk than the artifact. On a fresh clone ` +
        "this means nothing; the hashes below are what decide."
    );
  }

  const stamp = readDeckStamp(cfg);
  if (!stamp) {
    problems.push(
      `no content stamp beside the plugin: ${paths.stamp}\n` +
        "    Without it nothing records which sources the published artifact was built from, " +
        "so it cannot be told from a stale one. Run the resource's `deck:pack`."
    );
    return { ok: false, problems, notes, scan, stamp: null };
  }

  if (stamp.pluginId !== cfg.pluginId) {
    problems.push(
      `the stamp is for a different plugin: ${stamp.pluginId} (expected ${cfg.pluginId})`
    );
  }
  if (stamp.artifactSha256 !== artifactSha || stamp.artifactBytes !== artifactBytes) {
    problems.push(
      "the stamp does not describe the published artifact — it was written for a different " +
        `pack (stamp: ${stamp.artifactBytes} bytes / ${stamp.artifactSha256.slice(0, 16)}…, ` +
        `on disk: ${artifactBytes} bytes / ${artifactSha.slice(0, 16)}…).\n` +
        "    Either the artifact was replaced by hand or the stamp was. Re-pack."
    );
  }
  if (stamp.sourceHash !== scan.hash) {
    const changed = stamp.sourceFiles !== scan.files.length;
    problems.push(
      "STALE — the plugin sources have changed since the artifact was packed " +
        `(stamp: ${stamp.sourceHash.slice(0, 16)}… over ${stamp.sourceFiles} files, ` +
        `now: ${scan.hash.slice(0, 16)}… over ${scan.files.length})` +
        (changed ? "; the file COUNT changed too, so a file was added or removed." : ".") +
        `\n    Packed at ${stamp.packedAt}. Run the resource's \`deck:pack\` and commit both ` +
        "the artifact and the stamp."
    );
  }

  return { ok: problems.length === 0, problems, notes, scan, stamp };
}

/**
 * Produce the native `CodePathWin` binary, in place, from tracked source.
 *
 * Cargo is a hard requirement rather than a fallback to a committed binary: a
 * prebuilt `.exe` in the tree is how the last one came to be unrebuildable.
 */
function buildDeckLauncher(
  paths: DeckPaths,
  manifest: DeckManifest,
  target: string,
  execute: typeof run
): void {
  step(`Building the Windows launcher for ${target}`);

  // Bun.spawnSync throws ENOENT on a missing binary rather than returning a status, so
  // without this the pack fails with a stack trace naming neither Rust nor what to do.
  if (!Bun.which("cargo")) {
    throw new Error(
      `${target} is a native launcher and cargo is not on PATH. Install Rust (rustup.rs) and ` +
        `the ${LAUNCHER_TRIPLE} target, then re-run. There is deliberately no prebuilt binary ` +
        "to fall back to."
    );
  }

  // Which Node major the host would have used. The launcher prefers it and falls
  // back, so an absent block is not fatal — but passing the manifest's own value
  // is what makes the launcher's choice the same choice.
  const nodeMajor = manifest.Nodejs?.Version ?? "";

  execute(
    "cargo",
    [
      "build",
      "--release",
      "--target",
      LAUNCHER_TRIPLE,
      "--manifest-path",
      join(LAUNCHER_DIR, "Cargo.toml"),
      "--target-dir",
      LAUNCHER_BUILD_DIR,
    ],
    LAUNCHER_DIR,
    { DECK_NODE_MAJOR: nodeMajor }
  );

  const built = join(LAUNCHER_BUILD_DIR, LAUNCHER_TRIPLE, "release", "deck-launcher.exe");
  if (!existsSync(built)) {
    throw new Error(
      `cargo reported success but produced no launcher at ${built}. Refusing to pack whatever ` +
        `${target} happened to be already — that is how a 114 MB hand-built binary shipped for ` +
        "three releases."
    );
  }

  const dest = join(paths.sdPlugin, target);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
  console.log(
    `  → ${target} — ${(statSync(dest).size / 1024).toFixed(1)} KiB` +
      (nodeMajor ? `, resolving Node ${nodeMajor} at launch` : "")
  );
}

/**
 * Build, validate, pack, publish — and write the stamp the gate reads.
 */
export function packDeckPlugin(
  cfg: DeckPluginConfig & { install?: boolean },
  execute: typeof run = run
): { published: string; bytes: number; sha256: string; changed: boolean } {
  const paths = deckPaths(cfg);
  step(`Packing the ${cfg.pluginId} Stream Deck plugin`);

  if (!existsSync(paths.sdPlugin)) {
    throw new Error(
      `No ${cfg.pluginId}.sdPlugin under ${paths.pluginRoot} — nothing to pack. ` +
        "A release must not quietly ship the previous download."
    );
  }

  // The previous SOURCE hash, not the previous artifact's bytes: Elgato's `streamdeck pack`
  // embeds entry timestamps with no flag to pin them, so three packs of one unchanged tree
  // held `sourceHash` at ea93c94… while the artifact sha varied (1b688404…, ca43bdbf…,
  // 39dbf5e9…) — comparing bytes asked for a new commit every run.
  const previousSource = readDeckStamp(cfg)?.sourceHash ?? null;

  if (cfg.install !== false) installDeps(paths.pluginRoot);
  execute("bun", ["run", "build"], paths.pluginRoot);

  // Before `validate`, which checks that every path the manifest names exists.
  const manifest = readManifest(paths);
  const launcher = launcherTarget(manifest);
  if (launcher && manifest) buildDeckLauncher(paths, manifest, launcher, execute);

  execute("bun", ["run", "validate"], paths.pluginRoot);
  execute("bun", ["run", "pack"], paths.pluginRoot);

  if (!existsSync(paths.packed) || statSync(paths.packed).size === 0) {
    throw new Error(
      `streamdeck pack reported success but produced no artifact at ${paths.packed}. ` +
        "Refusing to publish whatever was there before."
    );
  }

  mkdirSync(dirname(paths.published), { recursive: true });
  copyFileSync(paths.packed, paths.published);

  // Scanned AFTER the pack: `buildDeckLauncher` above rewrites the launcher binary,
  // which is part of the hashed source set, so a scan taken earlier would stamp a
  // hash the artifact does not match.
  const scan = scanDeckSources(cfg);

  const sha256 = sha256File(paths.published);
  const bytes = statSync(paths.published).size;

  const stamp: DeckStamp = {
    pluginId: cfg.pluginId,
    artifact: relative(cfg.root, paths.published).replaceAll("\\", "/"),
    artifactSha256: sha256,
    artifactBytes: bytes,
    sourceHash: scan.hash,
    sourceFiles: scan.files.length,
    packedAt: new Date().toISOString(),
  };
  writeFileSync(paths.stamp, `${JSON.stringify(stamp, null, 2)}\n`);

  const changed = previousSource !== scan.hash;
  console.log(`  → ${stamp.artifact} — ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`     ${scan.files.length} source files, hash ${scan.hash.slice(0, 16)}…`);
  console.log(
    changed
      ? previousSource === null
        ? "     NEW: there was no published artifact before this run."
        : "     CHANGED: the plugin sources moved — commit the download and the stamp."
      : "     unchanged (the artifact bytes differ every pack; the sources did not)."
  );

  return { published: paths.published, bytes, sha256, changed };
}
