// Negative control for tests/lua/runtimetxd-create-once.lua.
//
// The thing that suite guards cannot be observed in game: CREATE_RUNTIME_TXD leaks a
// pinned `ytd` streaming slot silently, and a name that collides across a resource
// restart makes every AddReplaceTexture resolve to the wrong dictionary — also
// silently. So the suite's only oracle is a counter and a set of strings, and a
// counter test is the easiest kind to write so that it agrees with the code.
//
// This plants the defect in THE MODULE'S OWN SOURCE, one substitution at a time, and
// requires an exact named set of assertions to go red. The patched copy is written to
// the OS temp directory — nothing inside the repo is touched — and the suite is told
// where it is through RUNTIMETXD_SOURCE. The patching happens here rather than in Lua
// because fengari ships no `io`.
//
//   nocache  `ensure` loses its cache and calls the native on every call.
//   notag    the dictionary name and both texture-name forms lose the per-load tag.
//
// Every substitution is asserted to have matched EXACTLY ONCE. A gsub that matched
// nothing would hand the suite the unmodified module, and the control would then be
// asserting that correct code is correct.
//
//   bun run test:lua:control

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SUITE = "tests/lua/runtimetxd-create-once.lua";
const MODULE = join(root, "shared/imports/runtimetxd/client.lua");

/** One literal substitution, with its own count assertion. */
interface Patch {
  find: string;
  replace: string;
}

const MODES: Record<string, Patch[]> = {
  // The cache is the entire point of `ensure`. Without it every call is a fresh
  // pinned streaming slot.
  nocache: [{ find: "local txd = txds[name]", replace: "local txd = nil" }],
  // Both texture forms as well as the dictionary: a module that tagged one and not
  // the other is the half-fixed state the suite's two separate assertions exist for.
  notag: [
    { find: "nameCache = ('%s_%s'):format(prefix, instance.tag())", replace: "nameCache = prefix" },
    {
      find: "if serial == nil then return ('%s_%s'):format(stem, instance.tag()) end",
      replace: "if serial == nil then return stem end",
    },
    {
      find: "return ('%s_%s_%d'):format(stem, instance.tag(), serial)",
      replace: "return ('%s_%d'):format(stem, serial)",
    },
  ],
};

const source = readFileSync(MODULE, "utf8");
const dir = mkdtempSync(join(tmpdir(), "tlib-runtimetxd-control-"));
let failures = 0;

for (const [mode, patches] of Object.entries(MODES)) {
  let patched = source;
  let planted = true;

  for (const { find, replace } of patches) {
    const hits = patched.split(find).length - 1;
    if (hits !== 1) {
      console.error(
        `FAIL control ${mode}: ${hits} occurrence(s) of the target line, expected 1 — ` +
          `the module has changed and this control would plant nothing:\n  ${find}`
      );
      planted = false;
      failures++;
      break;
    }
    patched = patched.replace(find, replace);
  }
  if (!planted) continue;

  const file = join(dir, `${mode}.lua`);
  writeFileSync(file, patched);

  const result = Bun.spawnSync(
    ["bunx", "--bun", "--package", "fengari-node-cli", "fengari", "scripts/run-lua-suite.lua", SUITE],
    {
      cwd: root,
      env: { ...process.env, RUNTIMETXD_CONTROL: mode, RUNTIMETXD_SOURCE: file },
    }
  );

  const out = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
  const expected = `CONTROL ${mode}: all`;

  if (result.exitCode === 0) {
    console.error(`FAIL control ${mode}: the suite exited 0 with a defect planted.`);
    failures++;
  } else if (!out.includes(expected)) {
    console.error(
      `FAIL control ${mode}: exited ${result.exitCode} but never reached its summary.\n${out.trim()}`
    );
    failures++;
  } else {
    console.log(`ok   control ${mode}: ${(out.split(/\r?\n/).find((l) => l.includes(expected)) ?? "").trim()}`);
  }
}

// And green with nothing planted — a pair that is red in both modes and red at
// baseline too would be indistinguishable from a working control.
const baseline = Bun.spawnSync(
  ["bunx", "--bun", "--package", "fengari-node-cli", "fengari", "scripts/run-lua-suite.lua", SUITE],
  { cwd: root }
);
if (baseline.exitCode !== 0) {
  console.error(
    `FAIL baseline: the suite is red with nothing planted.\n${baseline.stderr?.toString() ?? ""}`
  );
  failures++;
} else {
  console.log("ok   baseline: the suite passes with nothing planted");
}

if (failures > 0) {
  console.error(`\n${failures} control check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: ${Object.keys(MODES).length} planted defects caught, baseline green`);
