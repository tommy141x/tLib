#!/usr/bin/env bun
/**
 * Sweep every sibling resource's `tlib_modules` block against what tLib
 * actually provides.
 *
 * ## Why this lives in tLib and not in each resource
 *
 * Same reason as `secrets:provision:check`: only tLib can see every sibling. A
 * per-resource copy of this would be eleven copies of one rule, which is eleven
 * chances for one to be the stale one — and a stale gate is silent.
 *
 * ## Why the STAGED-TREE half is NOT here
 *
 * `checkStagedTree` is the other half of `runtime-state-contract.ts` and it is
 * wired into each resource's own `prod.ts`, immediately after staging. That is
 * deliberate and it is not symmetry for its own sake:
 *
 *   · A staged tree is only meaningful when it is FRESH. `stageFiles` cleans the
 *     output directory first, so a dist on disk between builds is whatever the
 *     last build left — MEASURED on this machine: tAFK's, tELS's and tRadio's
 *     `.build/dist` each hold a `data.json` older than the `fxmanifest.lua`
 *     beside it, i.e. a leftover from a build that predates the exclusion. That
 *     is a true finding about a directory and a false finding about a release.
 *   · Failing tLib's regression chain on a months-old build artifact is exactly
 *     how a gate earns a skip flag. The place a staged-tree check can actually
 *     STOP something is inside the build that produced the tree.
 *
 * So: this sweep is cheap, offline, always valid, and lives in
 * `check:regression`. The artifact assertion lives at the point of release.
 *
 * Exit 0 pass, 1 a finding, 2 the gate could not run. Exit 2 is NOT a pass.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  availableModules,
  checkDeclaredModules,
  failing,
  type RuntimeStateFinding,
} from "../shared/ts/build/runtime-state-contract.ts";

const TLIB = resolve(import.meta.dir, "..");
const SIBLINGS = resolve(TLIB, "..");
const strict = process.argv.includes("--strict");

/**
 * The floor. "No resource has a bad declaration" and "no resource was read"
 * are otherwise the same green, and the discovery below is a directory listing
 * filtered by a name pattern — exactly the kind of thing that returns an empty
 * array after a reorganisation and reports success.
 *
 * Eight is the count today (tAFK tCAD tChirp tDetector tELS tRadar tRadio
 * tUnit); the floor is set below it so adding or retiring one resource does not
 * need an edit here, while a collapse to two or three still stops the run.
 */
const MIN_RESOURCES = 6;

function die(message: string): never {
  console.error(`check:runtime-state: ${message}`);
  process.exit(2);
}

const available = availableModules(TLIB);
if (available.length === 0) {
  die(
    `tLib provides no modules at all, which cannot be true — ${join(TLIB, "shared/imports")} ` +
      "is empty or missing. Every declared name in every sibling would read as a ghost."
  );
}

const resources = readdirSync(SIBLINGS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^t[A-Z]/.test(e.name) && e.name !== "tLib")
  .map((e) => e.name)
  .filter((name) => existsSync(join(SIBLINGS, name, "fxmanifest.lua")))
  .sort();

if (resources.length < MIN_RESOURCES) {
  die(
    `found ${resources.length} sibling resource(s) with an fxmanifest (need ${MIN_RESOURCES}). ` +
      "Either the layout moved or the discovery rule stopped matching; a sweep over almost " +
      "nothing is not a pass."
  );
}

console.log(
  `check:runtime-state — tlib_modules across ${resources.length} resources, ` +
    `${available.length} modules available in tLib\n`
);

let hard = 0;
let soft = 0;
const serverOnlyNotes: string[] = [];

for (const resource of resources) {
  const root = join(SIBLINGS, resource);
  const result = checkDeclaredModules({ root, tlib: TLIB });

  const hardFindings = failing(result.findings, false);
  const softFindings = result.findings.filter((f) => f.soft);
  hard += hardFindings.length;
  soft += softFindings.length;

  const verdict = hardFindings.length > 0 ? "FAIL" : softFindings.length > 0 ? "soft" : "ok  ";
  console.log(
    `  ${verdict}  ${resource.padEnd(11)} ${String(result.declared.length).padStart(2)} declared` +
      (result.serverOnly.length > 0 ? `, ${result.serverOnly.length} server-only` : "")
  );
  if (result.serverOnly.length > 0) {
    serverOnlyNotes.push(`${resource}: ${result.serverOnly.join(", ")}`);
  }

  const say = (f: RuntimeStateFinding, tag: string) =>
    console[tag === "FAIL" ? "error" : "log"](`          ${tag} ${f.rule} — ${f.detail}`);
  for (const f of hardFindings) say(f, "FAIL");
  for (const f of softFindings) say(f, "soft");
}

// Informational only, never a failure. A module with just `server.lua` is legal
// and established — jsonstore, fs and soundstore are all server-only — and on
// the client `imports.lua` resolves the name to nothing and raises nothing. The
// manifest has no side marker to declare, so there is nothing to enforce; it is
// printed because "declared in a block the client VM also reads" is worth
// knowing when reading a client-side error.
if (serverOnlyNotes.length > 0) {
  console.log(`\n  server-only modules declared (informational, legal, never a failure):`);
  for (const note of serverOnlyNotes) console.log(`    ${note}`);
}

if (hard > 0 || (strict && soft > 0)) {
  console.error(
    `\nFAIL: ${hard} hard finding(s)` +
      (strict ? ` and ${soft} soft finding(s) under --strict` : "") +
      " across the sweep."
  );
  process.exit(1);
}

console.log(
  `\nPASS: ${resources.length} resources, no declared tLib module is missing from tLib` +
    (soft > 0
      ? `. ${soft} soft finding(s) reported and NOT failed — a consumer may legitimately ` +
        "declare a module it never names itself, because a tLib module it does use needs " +
        "that one loaded eagerly. Pass --strict to fail on them."
      : ".")
);
