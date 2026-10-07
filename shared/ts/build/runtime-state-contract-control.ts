#!/usr/bin/env bun
/**
 * The control for `runtime-state-contract.ts`. Run it before trusting that gate.
 *
 * ⛔ WHY A CONTROL, AND WHY THIS SHAPE. A sibling gate's first control passed
 * GREEN while a whole reader had been deleted, because every fixture was
 * reachable by a second path — so "the gate failed" was satisfied by the wrong
 * rule. This control therefore asserts the EXACT rule id each fixture trips and
 * that no OTHER rule trips on it. A fixture that fires two rules is a failure
 * here even though it is red, because then it proves nothing about the rule it
 * was written for.
 *
 * Every defect fixture is built from a `clean()` tree that already clears both
 * floors — it is over the file count and it carries an `fxmanifest.lua` — so the
 * one difference between a fixture and a passing release is the defect itself.
 *
 * ## The broken-gate drill
 *
 * ⚠️ A red verdict is not evidence that the RULE caused it. So the last phase
 * narrows the matcher so it cannot match, and requires the fixture that was red
 * to go GREEN. Without that, a gate whose regex had rotted into matching
 * everything would pass this control on every fixture.
 *
 * The drill is run by re-checking a fixture with the matching rule in `skip`,
 * which exercises the real `skip` plumbing rather than a stub — and `skip` is
 * how a consumer silences a rule in production, so it is worth knowing it works.
 *
 * Nothing is written outside the OS temp dir.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDeclaredModules,
  checkStagedTree,
  declaredModules,
  failing,
} from "./runtime-state-contract.ts";

const root = mkdtempSync(join(tmpdir(), "runtime-state-control-"));
let failures = 0;

function report(name: string, want: string[], got: string[], why: string) {
  const w = [...want].sort();
  const g = [...new Set(got)].sort();
  if (g.length === w.length && g.every((r, i) => r === w[i])) {
    console.log(`  PASS  ${name.padEnd(30)} ${w.length ? `red: ${w.join(", ")}` : "green"}`);
    return true;
  }
  failures++;
  console.error(
    `  FAIL  ${name.padEnd(30)} expected [${w.join(", ") || "green"}] but got [${g.join(", ") || "green"}]`
  );
  console.error(`        why this fixture exists: ${why}`);
  return false;
}

// ── Part 1: the staged tree ──────────────────────────────────────────────────

/**
 * A staged tree that must pass every rule: an fxmanifest at the root, and
 * comfortably over the file-count floor.
 *
 * The filler files are `.lua` with nothing in them rather than realistic
 * content, so that adding a rule to the gate later cannot accidentally match
 * the padding.
 */
function clean(dir: string) {
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  writeFileSync(join(dir, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, "server", `sv_${i}.lua`), "");
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, "client", `cl_${i}.lua`), "");
}

type StagedFixture = {
  name: string;
  /** Extra files, relative to the staged root. `null` for an empty tree. */
  plant: string[] | null;
  /** Skip the `clean()` scaffold — for the floor fixtures. */
  bare?: boolean;
  expect: string[];
  why: string;
};

const STAGED: StagedFixture[] = [
  {
    name: "clean",
    plant: [],
    expect: [],
    why: "the baseline. If this is not green, every red below is meaningless.",
  },
  {
    name: "data.json at root",
    plant: ["data.json"],
    expect: ["R-DATA-FILE"],
    why: "the one that actually shipped. tRadio put a real admin password in a customer zip.",
  },
  {
    name: "data.json nested",
    plant: ["server/storage/data.json"],
    expect: ["R-DATA-FILE"],
    why:
      "⛔ matched by BASENAME at any depth. data.json is written next to whichever file the " +
      "resource points its writer at, and a root-only check misses that entirely.",
  },
  {
    name: "data.json.bak",
    plant: ["data.json.bak"],
    expect: ["R-DATA-BAK"],
    why: "in tCAD the ONLY recovery path for a truncated data.json; shipping one replaces it.",
  },
  {
    name: "migration backup",
    plant: ["data.json.v2.bak"],
    expect: ["R-DATA-MIGRATION-BAK"],
    why: "tlib.jsonstore's pre-migration snapshot. Per-install by construction.",
  },
  {
    name: "tmp with pid suffix",
    plant: ["data.json.tmp-12345"],
    expect: ["R-DATA-TMP"],
    why:
      "⛔ the suffix is the whole point. tCAD's .gitignore MEASURED that a bare " +
      "`data.json.tmp` pattern matched nothing that is ever created.",
  },
  {
    name: "tmp bare",
    plant: ["data.json.tmp"],
    expect: ["R-DATA-TMP"],
    why: "the same rule must still cover the unsuffixed spelling, not only the pid one.",
  },
  {
    name: "quarantined corrupt file",
    plant: ["data.json.corrupt.1760000000"],
    expect: ["R-DATA-CORRUPT"],
    why: "tAFK parks an unparseable file under this name. It is the owner's repair evidence.",
  },
  {
    name: "two at once",
    plant: ["data.json", "data.json.bak"],
    expect: ["R-DATA-FILE", "R-DATA-BAK"],
    why: "the real shape of a hand-copied pair; each must be named, not just the first.",
  },
  {
    name: "lookalikes stay green",
    plant: ["data.json5", "mydata.json", "server/config.json", "data-json.bak", "data.jsonc"],
    expect: [],
    why:
      "⛔ the false-positive direction. A gate that fails a release over `config.json` is a " +
      "gate that gets a skip flag, and then it is not a gate.",
  },
  {
    name: "floor: empty tree",
    plant: null,
    bare: true,
    expect: ["R-FILE-FLOOR", "R-MANIFEST-FLOOR"],
    why:
      "⛔ the most perfect vacuous pass available. No files, so no forbidden name, so every " +
      "rule above is green and the release ships whatever it likes.",
  },
  {
    name: "floor: no fxmanifest",
    plant: null,
    bare: true,
    expect: ["R-MANIFEST-FLOOR"],
    why:
      "⛔ a directory with plenty of files and no manifest is not a staged resource — a " +
      "path typo, or a build output dir. The file-count floor alone does not catch it.",
  },
];

console.log(`runtime-state-contract control — staged-tree fixtures\n`);

for (const fixture of STAGED) {
  const dist = join(root, "staged", fixture.name.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dist, { recursive: true });

  if (!fixture.bare) clean(dist);
  if (fixture.name === "floor: no fxmanifest") {
    // Enough files to clear the count floor, and deliberately no manifest.
    mkdirSync(join(dist, "server"), { recursive: true });
    for (let i = 0; i < 8; i++) writeFileSync(join(dist, "server", `sv_${i}.lua`), "");
  }
  for (const file of fixture.plant ?? []) {
    const full = join(dist, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "{}");
  }

  const result = checkStagedTree({ dist });
  report(fixture.name, fixture.expect, result.findings.map((f) => f.rule), fixture.why);
}

// ── Part 1b: the broken-gate drill ───────────────────────────────────────────
//
// ⚠️ Every red above could also be produced by a matcher that had rotted into
// matching everything — `lookalikes stay green` is one guard against that, and
// this is the other, from the opposite side: take the rule away and the fixture
// that was red MUST go green. Without both, a red verdict is not evidence that
// the rule caused it.

console.log("\n  broken-gate drill — the rule removed, the same fixture must go green");

const DRILL: Array<{ file: string; rule: string }> = [
  { file: "data.json", rule: "R-DATA-FILE" },
  { file: "data.json.bak", rule: "R-DATA-BAK" },
  { file: "data.json.v2.bak", rule: "R-DATA-MIGRATION-BAK" },
  { file: "data.json.tmp-12345", rule: "R-DATA-TMP" },
  { file: "data.json.corrupt.1760000000", rule: "R-DATA-CORRUPT" },
];

for (const { file, rule } of DRILL) {
  const dist = join(root, "drill", rule);
  mkdirSync(dist, { recursive: true });
  clean(dist);
  writeFileSync(join(dist, file), "{}");

  const armed = checkStagedTree({ dist });
  const disarmed = checkStagedTree({ dist, skip: [rule] });

  const armedRules = [...new Set(armed.findings.map((f) => f.rule))];
  if (armedRules.length !== 1 || armedRules[0] !== rule) {
    failures++;
    console.error(
      `  FAIL  drill ${rule.padEnd(24)} armed gate fired [${armedRules.join(", ") || "nothing"}], expected exactly [${rule}]`
    );
    continue;
  }
  if (disarmed.findings.length !== 0) {
    failures++;
    console.error(
      `  FAIL  drill ${rule.padEnd(24)} with ${rule} removed the fixture is STILL red ` +
        `[${disarmed.findings.map((f) => f.rule).join(", ")}] — so the red above was not ` +
        "caused by that rule and proves nothing about it."
    );
    continue;
  }
  console.log(`  PASS  drill ${rule.padEnd(24)} red armed, green disarmed`);
}

// ── Part 2: declared modules ─────────────────────────────────────────────────

console.log("\n  tlib_modules fixtures");

/** A fake tLib with a known, small module set. */
const fakeTlib = join(root, "fakeTlib");
for (const [name, files] of [
  ["logger", ["shared.lua"]],
  ["jsonstore", ["server.lua"]],
  ["kvp", ["client.lua"]],
  ["notdeclared", ["shared.lua"]],
] as Array<[string, string[]]>) {
  const dir = join(fakeTlib, "shared", "imports", name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "return {}");
}
// A directory with no loadable file at all: `imports.lua` resolves this to
// nothing, so it must NOT count as available.
mkdirSync(join(fakeTlib, "shared", "imports", "emptydir"), { recursive: true });

type ModuleFixture = {
  name: string;
  manifest: string;
  lua: Record<string, string>;
  expect: string[];
  why: string;
};

const MODULES: ModuleFixture[] = [
  {
    name: "clean",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger', 'jsonstore' }\n",
    lua: { "server/sv_data.lua": "local s = tlib.jsonstore.open({ log = tlib.logger.create('x') })" },
    expect: [],
    why: "the baseline. Both declared, both present, both referenced.",
  },
  {
    name: "ghost module",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger', 'jsonstoer' }\n",
    lua: { "server/sv_data.lua": "tlib.logger.create('x'); tlib.jsonstoer.open({})" },
    expect: ["R-MODULE-GHOST"],
    why:
      "⛔ the silent one. A typo'd name is not a failed load, it is NOT A LOAD AT ALL — " +
      "imports.lua's eager loop raises nothing for a name that resolves to no file.",
  },
  {
    name: "directory with no module file",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'emptydir' }\n",
    lua: { "server/sv_x.lua": "tlib.emptydir.go()" },
    expect: ["R-MODULE-GHOST"],
    why:
      "a directory under shared/imports is not a module. `imports.lua` looks for " +
      "server/client/shared .lua inside it, so availability must be judged the same way.",
  },
  {
    name: "unused declaration (soft)",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger', 'kvp' }\n",
    lua: { "server/sv_x.lua": "tlib.logger.create('x')" },
    expect: ["R-MODULE-UNUSED"],
    why: "a stale entry in a block whose stated purpose is being an honest inventory.",
  },
  {
    name: "referenced only in a comment",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger', 'kvp' }\n",
    lua: {
      "server/sv_x.lua":
        "tlib.logger.create('x')\n-- we used to call tlib.kvp.get here\n--[[ tlib.kvp.set ]]",
    },
    expect: ["R-MODULE-UNUSED"],
    why:
      "⛔ prose is not use. MEASURED for real: every `tlib.diag` in tELS's cl_env.lua is " +
      "inside a comment, and a reader that did not strip comments called that declaration used.",
  },
  {
    name: "method-call and has() both count",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger', 'kvp', 'jsonstore' }\n",
    lua: {
      "server/sv_x.lua": "tlib.logger.create('x')",
      "client/cl_x.lua": "if tlib.has('kvp') then end\nlocal v = tlib:jsonstore",
    },
    expect: [],
    why:
      "`tlib.has('x')` is the SANCTIONED guard (a bare `if tlib.x` is always truthy), and " +
      "`tlib:x` is legal Lua. Calling either of those unused would be a false positive.",
  },
  {
    name: "singular tlib_module is read too",
    manifest: "fx_version 'cerulean'\ntlib_module { 'logger' }\n",
    lua: { "server/sv_x.lua": "tlib.logger.create('x')" },
    expect: [],
    why: "imports.lua reads BOTH spellings; a reader that read one would call the other absent.",
  },
  {
    name: "declaration inside a comment is not one",
    manifest:
      "fx_version 'cerulean'\n-- tlib_modules { 'jsonstoer' }\ntlib_modules { 'logger' }\n",
    lua: { "server/sv_x.lua": "tlib.logger.create('x')" },
    expect: [],
    why:
      "a commented-out block is a very common way to park a declaration, and reading it " +
      "would invent a ghost that is not there.",
  },
  {
    name: "floor: wrong tLib path",
    manifest: "fx_version 'cerulean'\ntlib_modules { 'logger' }\n",
    lua: { "server/sv_x.lua": "tlib.logger.create('x')" },
    expect: ["R-IMPORTS-FLOOR"],
    why:
      "⛔ availableModules returns [] for a path that does not exist, which makes EVERY " +
      "declared name a ghost — the gate would be loudly, confidently wrong rather than quiet.",
  },
];

for (const fixture of MODULES) {
  const dir = join(root, "modules", fixture.name.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fxmanifest.lua"), fixture.manifest);
  for (const [file, body] of Object.entries(fixture.lua)) {
    const full = join(dir, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }

  const tlib = fixture.name === "floor: wrong tLib path" ? join(root, "no-such-tlib") : fakeTlib;
  const result = checkDeclaredModules({ root: dir, tlib });
  report(fixture.name, fixture.expect, result.findings.map((f) => f.rule), fixture.why);
}

// A reader-level assertion, not a rule-level one: the manifest parser must find
// both names in a multi-line block with comments between the entries, which is
// what every real fxmanifest in this estate looks like.
{
  const parsed = declaredModules(
    `tlib_modules {
    -- a long paragraph about why this one is eager, mentioning 'notdeclared'
    'logger',
    --[[ and a block comment naming 'alsonot' ]]
    'jsonstore',
}`
  );
  const want = ["jsonstore", "logger"];
  const ok = parsed.length === want.length && parsed.every((n, i) => n === want[i]);
  if (!ok) {
    failures++;
    console.error(
      `  FAIL  manifest parser                read [${parsed.join(", ")}], expected [${want.join(", ")}]`
    );
    console.error(
      "        why this exists: every real fxmanifest here has multi-line prose between " +
        "entries, and names appear INSIDE that prose. Reading one is a ghost that is not there."
    );
  } else {
    console.log(`  PASS  manifest parser              ${parsed.join(", ")}`);
  }
}

// `failing()` is the thing the CLI and every prod.ts actually branch on, so it
// is asserted directly rather than inferred from an exit code.
{
  const soft = [{ rule: "R-MODULE-UNUSED", file: "f", detail: "", soft: true }];
  const hard = [{ rule: "R-DATA-FILE", file: "f", detail: "" }];
  const ok =
    failing(soft).length === 0 &&
    failing(soft, true).length === 1 &&
    failing(hard).length === 1 &&
    failing(hard, true).length === 1;
  if (!ok) {
    failures++;
    console.error(
      "  FAIL  failing()                      a soft finding must pass by default and fail " +
        "under --strict; a hard one must fail either way"
    );
  } else {
    console.log("  PASS  failing()                    soft passes, --strict fails, hard always fails");
  }
}

rmSync(root, { recursive: true, force: true });

const total = STAGED.length + DRILL.length + MODULES.length + 2;
if (failures > 0) {
  console.error(
    `\n${failures} of ${total} control checks did not behave as specified. ` +
      "⛔ Do NOT trust check:runtime-state until this is green — a gate whose control is red " +
      "is indistinguishable from a gate that passes because it is reading nothing."
  );
  process.exit(1);
}
console.log(`\nAll ${total} control checks behaved exactly as specified.`);
