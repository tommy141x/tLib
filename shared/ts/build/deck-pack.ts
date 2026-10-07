/**
 * Stream Deck plugin packing, and the staleness gate that keeps it honest.
 *
 * Three resources ship an Elgato Stream Deck plugin — tRadio, tELS and tRadar —
 * and each one publishes the packed `.streamDeckPlugin` as a download from its
 * own docs. Until this file existed, nothing built it: `scripts/prod.ts` had
 * zero deck steps in all three, so the published artifact was whatever someone
 * last packed by hand and copied.
 *
 * ⚠️ MEASURED 2026-10-06, and this is why it is a build step rather than a note.
 * tRadio's committed `docs/public/com.timmyg-studios.tradio.streamDeckPlugin`
 * was packed on Oct 1 and held **29** files; a pack of the same working tree
 * produced **38**. The published download was missing `ui/function.html`,
 * `ui/softkey.html` and the softkey action icons — whole actions a customer
 * could not use — and carried `imgs/plugin/marketplace@2x.png` at 155,618 bytes
 * where the source tree has a 15,068-byte re-export. Nothing reported it,
 * because there was nothing to report it.
 *
 * ── Where the output goes, and where it must NOT go ─────────────────────────
 *
 * Into the resource's own `docs/public/`. NEVER into `.build/dist/`: the plugin
 * is a Node program the customer installs into their own Stream Deck app, not
 * resource runtime, and `client/stream-deck/` is deliberately excluded from the
 * release ZIP — see the comment saying so in tELS/scripts/prod.ts's allowlist.
 * Staging it would also route it through `createZip`'s credential sanitizer,
 * which has no business rewriting a zip-of-a-zip.
 *
 * And never into `internal/tWeb/public/assets/<resource>/`. The site mirror is
 * the website's own sync step (`tWeb/scripts/sync-docs-assets.ts`); a resource
 * build writing into tWeb's tree would make a private repo a build output of
 * five public ones.
 *
 * ── Why the gate stamps content instead of comparing timestamps ─────────────
 *
 * The brief asked for "fails when the committed `.streamDeckPlugin` is older
 * than any file under its `.sdPlugin` source tree", and an mtime comparison is
 * the obvious reading. It cannot be the mechanism: **git does not record
 * mtimes**. A fresh clone — every CI run, every new worktree — writes every
 * file at checkout time, so the artifact and its sources come out the same age
 * to within the time it takes to write them. On that tree an mtime gate is
 * green on genuinely stale bytes, and intermittently red on fresh ones
 * depending on the order the checkout happened to write files in. A gate that
 * is green for the wrong reason on every runner is the failure mode this
 * codebase keeps hitting.
 *
 * So the recorded fact is a HASH of the source set, written beside the plugin
 * as `<id>.streamDeckPlugin.stamp.json` when the pack runs, and the gate
 * recomputes it. That answers exactly the question the brief asked — has
 * anything the artifact is built from changed since it was packed — and it
 * survives a clone. mtimes are still *reported*, because on a developer's own
 * machine they are the human-readable version of the same fact; they are not
 * asserted on.
 *
 * The stamp also records the artifact's own sha256 and size. That is what stops
 * the one tamper the sibling `gen:deck-icons:check` gate documents as still
 * open on itself: a sidecar hand-written (or merge-resolved) to agree with a
 * stale artifact. Here the stamp has to agree with BOTH sides, so a stale
 * artifact needs a deliberate forgery of two hashes rather than one edit.
 *
 * A `.streamDeckPlugin` is a zip, and a zip carries per-entry timestamps, so
 * two packs of an unchanged tree are not byte-identical. That is why the gate
 * cannot simply re-pack and compare — the comparison would always report drift.
 *
 * ── Fail loudly on nothing measured ─────────────────────────────────────────
 *
 * `scanDeckSources` THROWS on an empty source set rather than returning `[]`.
 * A renamed `src/`, a moved `.sdPlugin` or a widened skip list would otherwise
 * make the gate hash the empty string, agree with itself forever, and print a
 * tick. `tLib/scripts/deck-stale-control.ts` plants that defect among others and
 * requires each one to go red.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
 *
 * `bin/` holds the rollup bundle and `logs/` whatever the Stream Deck app wrote;
 * both are gitignored in all three resources, and both are regenerated by the
 * pack itself. Hashing them would make the stamp disagree with itself after
 * every build — a structurally always-red gate, which is a gate someone
 * eventually deletes. `src/` is what `bin/` is built FROM and it IS hashed, so
 * nothing is lost: a bundle cannot change without its source changing.
 */
const SKIP_DIRS = new Set(["bin", "logs", "node_modules"]);

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
 * The `.sdPlugin` tree is the plugin as installed (manifest, property
 * inspectors, images, layouts); `src/` is the TypeScript rollup turns into
 * `bin/plugin.js`; and `rollup.config.mjs`, `tsconfig.json` and `package.json`
 * decide what that bundle comes out as — a dependency bump changes the shipped
 * bytes with no change under `src/`.
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
    // A corrupt stamp is a failure, not an absence: returning null here would
    // read as "never packed" and the caller's message would send someone to the
    // wrong problem.
    throw new Error(`Stream Deck stamp is not readable JSON (${path}): ${String(e)}`);
  }
}

/**
 * Does the published artifact still match the sources it was packed from?
 *
 * Returns rather than throws, so the CLI can print every problem at once and a
 * caller can treat "never packed" differently from "stale".
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
 * Build, validate, pack, publish — and write the stamp the gate reads.
 *
 * The three sub-steps go through the plugin's OWN package scripts (`build`,
 * `validate`, `pack`) rather than invoking `bunx streamdeck` here, so the
 * Elgato CLI's arguments live in one place per plugin and `bun run deck:pack`
 * by hand does exactly what the release does. tRadar already had those scripts;
 * tRadio and tELS had only `build`/`watch` and now match it.
 *
 * `streamdeck pack` writes beside the `.sdPlugin` directory, which is gitignored
 * in tELS and tRadar (`*.streamDeckPlugin`) and untracked in tRadio. The copy
 * under `docs/public/` is the tracked one, and it is tracked on purpose: the
 * docs site deploys from a plain checkout with no build step.
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

  const previous = existsSync(paths.published) ? sha256File(paths.published) : null;

  if (cfg.install !== false) installDeps(paths.pluginRoot);
  execute("bun", ["run", "build"], paths.pluginRoot);
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

  // ⚠️ HASHED AFTER THE PACK, NOT BEFORE, AND THAT IS A MEASUREMENT RATHER THAN
  // A PREFERENCE. This read the sources first, on the reasoning that the stamp
  // should describe them as committed. It cannot: `streamdeck validate`/`pack`
  // REWRITES `<id>.sdPlugin/manifest.json` as a side effect. Measured on tELS
  // 2026-10-06 — 54 changed lines, every one of them `"Controllers":
  // ["Keypad"]` re-wrapped onto three lines, and `JSON.parse` of both sides
  // compares equal, so it is purely the CLI's own formatting. But the file is
  // TRACKED and it IS in the source set, so hashing before the pack recorded a
  // hash of a tree that no longer existed by the time the pack finished: the
  // gate went red immediately after a successful pack, on a clean checkout,
  // every time. That is a structurally always-red gate, which is a gate
  // somebody eventually deletes.
  //
  // The rewrite is idempotent, so the post-pack tree is also the one that gets
  // committed and the one the gate will read. Hashing it is both correct and
  // the only option that is stable.
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

  const changed = previous !== sha256;
  console.log(`  → ${stamp.artifact} — ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`     ${scan.files.length} source files, hash ${scan.hash.slice(0, 16)}…`);
  console.log(
    changed
      ? previous === null
        ? "     NEW: there was no published artifact before this run."
        : "     CHANGED: the published download differs from the committed one — commit it."
      : "     unchanged (a zip carries entry timestamps, so identical bytes means identical input)."
  );

  return { published: paths.published, bytes, sha256, changed };
}
