#!/usr/bin/env bun
/**
 * deck-stale — fails when a resource's published `.streamDeckPlugin` no longer
 * matches the plugin sources it was packed from.
 *
 * One shared gate for all three deck resources, invoked from each one's
 * package.json the same way `secrets:check` is:
 *
 *   bun run ../tLib/scripts/deck-stale.ts --id com.timmyg-studios.tradio
 *   bun run ../tLib/scripts/deck-stale.ts --id … --repo /path/to/resource
 *   bun run ../tLib/scripts/deck-stale.ts --id … --list      # name every source file
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Because it had already happened. On 2026-10-06 tRadio's published download was
 * five days old and 9 files short of its own source tree — missing two property
 * inspectors and the softkey icons, so actions a customer dragged onto a key had
 * no UI. Nothing was wrong with the repo: the artifact is tracked, the sources
 * are tracked, and no gate related the two. The measurement is in the header of
 * tLib/shared/ts/build/deck-pack.ts.
 *
 * ── What it asserts, and what it only reports ───────────────────────────────
 *
 * Asserted: the stamp beside the plugin describes the published artifact's exact
 * bytes, AND the hash of the source set still matches what the stamp recorded.
 * Reported only: mtimes. git does not record mtimes, so on a fresh clone every
 * file is the same age and an mtime gate is green on stale bytes — see
 * deck-pack.ts's header for the full argument.
 *
 * Exit codes are semantic, like the rest of this toolchain:
 *   0  the published artifact is current
 *   1  it is stale, missing, or its stamp disagrees with it
 *   2  the gate could not run (no plugin tree, no src/, nothing to measure) —
 *      NOT a pass
 *   3  bad usage
 *
 * `bun run deck:stale:control` in each resource is the proof it can go red.
 */

import { resolve } from "node:path";
import { checkDeckArtifact, scanDeckSources } from "../shared/ts/build/deck-pack.ts";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(3);
  }
  return value;
}

const pluginId = flag("--id");
if (!pluginId) {
  console.error(
    "deck-stale: --id <plugin uuid> is required, e.g. --id com.timmyg-studios.tradio\n" +
      "It is not defaulted on purpose: a guessed id scans a directory that does not exist, " +
      "and this gate must never be able to measure nothing."
  );
  process.exit(3);
}

const root = resolve(flag("--repo") ?? process.cwd());
const cfg = {
  root,
  pluginId,
  pluginDir: flag("--plugin-dir"),
  publicDir: flag("--public-dir"),
};

let result: ReturnType<typeof checkDeckArtifact>;
try {
  result = checkDeckArtifact(cfg);
} catch (e) {
  // Everything scanDeckSources throws is "the gate could not measure the thing
  // it is for". That is exit 2, not 1 and emphatically not 0.
  console.error(`deck-stale: CANNOT RUN — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

console.log(`deck-stale: ${pluginId}`);
for (const n of result.notes) console.log(`  ${n}`);

if (argv.includes("--list")) {
  const scan = scanDeckSources(cfg);
  for (const f of scan.files) console.log(`    ${f.sha256.slice(0, 12)}  ${f.rel}`);
}

if (!result.ok) {
  console.error("\ndeck-stale: FAILED");
  for (const p of result.problems) console.error(`  • ${p}`);
  console.error(
    "\nThe download link in the docs serves the committed artifact directly, so a stale one " +
      "is what every customer gets."
  );
  process.exit(1);
}

console.log(
  `  CURRENT — the published artifact was packed from these exact ${result.scan.files.length} ` +
    "source files."
);
