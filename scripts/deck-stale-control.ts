#!/usr/bin/env bun
/**
 * Negative control for `deck-stale.ts`. Proves the gate can go red, and that it
 * goes red for the reason it claims.
 *
 *   bun run ../tLib/scripts/deck-stale-control.ts --id com.timmyg-studios.tradio
 *
 * Why this is here
 *
 * Because the gate's green output and a gate that measured nothing look
 * identical. `deck-stale` prints a file count and two hashes; a copy of the
 * plugin tree that silently came out empty, a skip list that widened to swallow
 * `src/`, or a stamp comparison wired so both sides read the same value would
 * all print a tick. This estate has shipped that shape repeatedly, so the gate
 * does not get to be trusted on its own say-so.
 *
 * How it works, and why it needs no Elgato CLI and no network
 *
 * It builds a SYNTHETIC resource root in the OS temp directory: the real plugin
 * project copied in, plus a `docs/public/<id>.streamDeckPlugin` of arbitrary
 * bytes and a stamp computed from the real library. That is sound rather than a
 * shortcut, because the gate's entire contract is about hashes — it never opens
 * the artifact as a zip, and it must not, since a zip carries entry timestamps
 * and no two packs of one tree are byte-identical. So the control can assert the
 * whole rule set without running `streamdeck pack`, without `bun install`, and
 * without touching anything inside the repo.
 *
 * The cases
 *
 * A BASELINE that must be green, with a floor under the file count (an empty
 * copy would make every case below red for the wrong reason), then one planted
 * defect at a time:
 *
 *   source-edited      a byte changed in an .sdPlugin file   → 1
 *   source-added       a new file in src/                    → 1
 *   source-deleted     a source file removed                 → 1
 *   artifact-missing   the published download is gone        → 1
 *   artifact-tampered  the artifact's bytes changed          → 1
 *   stamp-missing      no stamp beside the plugin            → 1
 *   stamp-wrong-id     stamp copied from another plugin      → 1
 *   no-sdplugin        the .sdPlugin tree renamed away       → 2  (cannot run)
 *   no-src             src/ removed                          → 2  (cannot run)
 *
 * and two DECOYS that must stay green, each of which documents a decision:
 *
 *   bin-edited         build output changed, source did not  → 0
 *   mtime-only         a source file touched, bytes the same → 0
 *
 * The `no-*` pair is the one that matters most: a 2 is the gate saying it could
 * not measure, and reading a 2 as a pass is how a gate that measures nothing
 * stays green forever.
 *
 * STILL UNPROVEN, and it says so here rather than nowhere
 *
 * One tamper passes: edit a source file, then rewrite the stamp from the edited
 * tree without re-packing. Both hashes then agree and the published artifact is
 * stale. That is a deliberate two-step forgery rather than an accident — the
 * accident this gate exists to catch is forgetting to pack at all — but closing
 * it would need the stamp to be derivable from the ARTIFACT's contents, and the
 * artifact is a zip whose entry timestamps differ on every pack. No case below
 * covers it, and no case below pretends to.
 *
 * Exit 0 all cases behaved; 1 a case did not; 3 bad usage.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deckPaths, scanDeckSources } from "../shared/ts/build/deck-pack.ts";

const GATE = join(import.meta.dir, "deck-stale.ts");

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(3);
  }
  return v;
}

const pluginId = flag("--id");
if (!pluginId) {
  console.error("deck-stale-control: --id <plugin uuid> is required");
  process.exit(3);
}
const repo = resolve(flag("--repo") ?? process.cwd());
const pluginDir = flag("--plugin-dir") ?? "client/stream-deck";

/**
 * A floor, not a formality. If the fixture copy produced 3 files, every red case
 * below would still be red and the run would still print nine ticks — while
 * proving nothing about a real plugin. All three deck plugins have well over
 * this many; the smallest measured 29.
 */
const MIN_SOURCE_FILES = 15;

const SOURCE_ITEMS = [
  `${pluginId}.sdPlugin`,
  "src",
  "rollup.config.mjs",
  "tsconfig.json",
  "package.json",
];

const tmp = mkdtempSync(join(tmpdir(), "deck-stale-control-"));
let failures = 0;

function note(s: string) {
  console.log(s);
}

/** A fresh synthetic resource root, with a stamp that agrees with its artifact. */
function build(): { root: string; files: number } {
  const root = mkdtempSync(join(tmp, "case-"));
  const dest = join(root, pluginDir);
  mkdirSync(dest, { recursive: true });
  for (const item of SOURCE_ITEMS) {
    const src = join(repo, pluginDir, item);
    if (!existsSync(src)) {
      console.error(
        `deck-stale-control: the fixture source is missing ${item} (${src}). ` +
          "Nothing below would mean anything."
      );
      process.exit(1);
    }
    cpSync(src, join(dest, item), { recursive: true });
  }
  // `bin/` is build output and the gate skips it by design. Planted here so the
  // bin-edited decoy has something to edit on every tree, even a clean checkout
  // that has never run the rollup build.
  mkdirSync(join(dest, `${pluginId}.sdPlugin`, "bin"), { recursive: true });
  writeFileSync(join(dest, `${pluginId}.sdPlugin`, "bin", "plugin.js"), "// synthetic\n");

  const paths = deckPaths({ root, pluginId, pluginDir });
  mkdirSync(join(root, "docs", "public"), { recursive: true });
  writeFileSync(paths.published, Buffer.from("PK\u0003\u0004 synthetic streamDeckPlugin bytes"));
  stampFor(root);
  const scan = scanDeckSources({ root, pluginId, pluginDir });
  return { root, files: scan.files.length };
}

/** Rewrite the stamp so it agrees with the tree as it stands right now. */
function stampFor(root: string): void {
  const paths = deckPaths({ root, pluginId, pluginDir });
  const scan = scanDeckSources({ root, pluginId, pluginDir });
  const bytes = readFileSync(paths.published);
  writeFileSync(
    paths.stamp,
    `${JSON.stringify(
      {
        pluginId,
        artifact: `docs/public/${paths.fileName}`,
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        artifactBytes: bytes.length,
        sourceHash: scan.hash,
        sourceFiles: scan.files.length,
        packedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

function runGate(root: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", GATE, "--id", pluginId, "--repo", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

/** First file under the `.sdPlugin` tree, so a case can edit something real. */
function anySdPluginFile(root: string): string {
  const scan = scanDeckSources({ root, pluginId, pluginDir });
  const hit = scan.files.find((f) => f.rel.includes(".sdPlugin/") && f.rel.endsWith(".json"));
  if (!hit) {
    console.error("deck-stale-control: no .sdPlugin JSON in the fixture — the copy is wrong.");
    process.exit(1);
  }
  return join(root, pluginDir, hit.rel);
}

function check(name: string, expected: number, plant: (root: string) => void): void {
  const { root } = build();
  plant(root);
  const { code, out } = runGate(root);
  if (code === expected) {
    note(`  ok    ${name.padEnd(18)} exit ${code}`);
    return;
  }
  failures++;
  note(`  FAIL  ${name.padEnd(18)} exit ${code}, expected ${expected}`);
  note(
    out
      .trim()
      .split("\n")
      .map((l) => `          ${l}`)
      .join("\n")
  );
}

try {
  // baseline
  const base = build();
  const baseRun = runGate(base.root);
  note(`deck-stale-control: ${pluginId}`);
  note(`  fixture: ${base.files} source files`);
  if (base.files < MIN_SOURCE_FILES) {
    console.error(
      `deck-stale-control: FLOOR FAILED — only ${base.files} source files were copied, ` +
        `expected at least ${MIN_SOURCE_FILES}. Every case below would be red for the wrong ` +
        "reason, so this run proves nothing."
    );
    process.exit(1);
  }
  if (baseRun.code !== 0) {
    console.error(
      "deck-stale-control: BASELINE IS NOT GREEN — the clean synthetic tree fails the gate, " +
        "so a red result below says nothing about the planted defect.\n" +
        baseRun.out
    );
    process.exit(1);
  }
  note(`  ok    baseline           exit 0`);

  // defects that must be caught
  check("source-edited", 1, (root) => {
    const f = anySdPluginFile(root);
    writeFileSync(f, `${readFileSync(f, "utf8")}\n`);
  });

  check("source-added", 1, (root) => {
    writeFileSync(join(root, pluginDir, "src", "control-extra.ts"), "export const x = 1;\n");
  });

  check("source-deleted", 1, (root) => {
    rmSync(anySdPluginFile(root));
  });

  check("artifact-missing", 1, (root) => {
    rmSync(deckPaths({ root, pluginId, pluginDir }).published);
  });

  check("artifact-tampered", 1, (root) => {
    const p = deckPaths({ root, pluginId, pluginDir }).published;
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from("x")]));
  });

  check("stamp-missing", 1, (root) => {
    rmSync(deckPaths({ root, pluginId, pluginDir }).stamp);
  });

  // A stamp copied in from the wrong plugin — the shape a merge resolution or a
  // copy-paste between the three resources produces. Caught by name rather than
  // by hash, because the hashes would tell you nothing: they would simply both
  // be wrong, and the message would send someone looking for a stale pack.
  check("stamp-wrong-id", 1, (root) => {
    const paths = deckPaths({ root, pluginId, pluginDir });
    const stamp = JSON.parse(readFileSync(paths.stamp, "utf8"));
    stamp.pluginId = "com.timmyg-studios.not-this-one";
    writeFileSync(paths.stamp, `${JSON.stringify(stamp, null, 2)}\n`);
  });

  // the gate must say "I could not measure", never "fine"
  check("no-sdplugin", 2, (root) => {
    rmSync(join(root, pluginDir, `${pluginId}.sdPlugin`), { recursive: true, force: true });
  });

  check("no-src", 2, (root) => {
    rmSync(join(root, pluginDir, "src"), { recursive: true, force: true });
  });

  // decoys: these must NOT fail
  check("bin-edited", 0, (root) => {
    writeFileSync(
      join(root, pluginDir, `${pluginId}.sdPlugin`, "bin", "plugin.js"),
      "// rebuilt, byte-different, not source\n"
    );
  });

  check("mtime-only", 0, (root) => {
    const f = anySdPluginFile(root);
    const future = new Date(Date.now() + 86_400_000);
    utimesSync(f, future, future);
    // And make the artifact look older than the touched source, which is exactly
    // the condition an mtime gate would fail on. It must not fail here: git does
    // not record mtimes, so that condition is true of every fresh clone.
    const art = deckPaths({ root, pluginId, pluginDir }).published;
    const past = new Date(Date.now() - 86_400_000);
    utimesSync(art, past, past);
    if (statSync(f).mtimeMs <= statSync(art).mtimeMs) {
      console.error("deck-stale-control: could not plant the mtime decoy — utimes had no effect.");
      failures++;
    }
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(
    `\ndeck-stale-control: ${failures} case(s) behaved wrongly. A green deck-stale is not ` +
      "evidence until this is clean."
  );
  process.exit(1);
}
console.log(
  "\ndeck-stale-control: all cases behaved — the gate can go red, and stays green on the decoys."
);
