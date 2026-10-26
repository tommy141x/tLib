// Negative control for tests/lua/framerelay-election.lua, which builds a
// two-client world by hand — the kind of fixture that can agree with the code by
// construction. Two defects, each planted in the real code path:
//
//   election   both clients report themselves the controller. publishTick computes
//              `mine` from tlib.occupancy.isController(), so the module genuinely
//              admits two writers on one statebag key. The pre-election bug, replayed.
//   clock      the world's clock stops advancing — the module's only notion of time,
//              and the one way a relay reasoned entirely about elapsed milliseconds
//              can look perfect while measuring nothing.
//
// The suite checks its own assertion set; what this adds is that each mode exits
// NON-ZERO (all CI reads) and reaches the control's own summary line rather than
// dying on a syntax error or a nil call.
//
// `test:lua:control` chains this, runtimetxd-control.ts and primitives-control.ts.
//
//   bun run test:lua:control

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SUITE = "tests/lua/framerelay-election.lua";
const MODES = ["election", "clock"] as const;

let failures = 0;

for (const mode of MODES) {
  const result = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      "--package",
      "fengari-node-cli",
      "fengari",
      "scripts/run-lua-suite.lua",
      SUITE,
    ],
    { cwd: root, env: { ...process.env, FRAMERELAY_CONTROL: mode } }
  );

  const out = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
  const expected = `CONTROL ${mode}: all`;

  if (result.exitCode === 0) {
    console.error(`FAIL control ${mode}: the suite exited 0 with a defect planted.`);
    failures++;
  } else if (!out.includes(expected)) {
    // Red for the wrong reason. The suite crashed before reaching its own
    // bookkeeping, so nothing was measured about the assertions.
    console.error(
      `FAIL control ${mode}: exited ${result.exitCode} but never reached its summary.\n${out.trim()}`
    );
    failures++;
  } else {
    const line = out.split(/\r?\n/).find((l) => l.includes(expected)) ?? "";
    console.log(`ok   control ${mode}: ${line.trim()}`);
  }
}

// Green with nothing planted: a pair red in both modes AND red at baseline would be
// indistinguishable from a working control.
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
console.log(`\nPASS: ${MODES.length} planted defects caught, baseline green`);
