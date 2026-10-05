// Negative control for tests/lua/framerelay-election.lua.
//
// The frame relay's correctness only shows up with TWO PLAYERS IN ONE VEHICLE, so the
// suite that covers it builds a two-client world — and a two-client world built by
// hand is exactly the kind of fixture that can agree with the code by construction.
// This runs the real suite twice with a defect planted, and requires BOTH runs to go
// red for the right reason.
//
//   election   both clients report themselves the controller. This is planted in the
//              REAL CODE PATH: publishTick computes `mine` from
//              tlib.occupancy.isController(), so the module genuinely admits two
//              writers on one statebag key. It is the pre-election bug, replayed.
//   clock      the world's clock stops advancing — the module's only notion of time,
//              and the one way a relay reasoned entirely about elapsed milliseconds
//              can look perfect while measuring nothing.
//
// The suite itself requires an EXACT set of assertions to flip and names any that did
// not, so a control whose expected set has gone stale refuses its own run. What this
// script adds is the half the suite cannot check about itself: that each mode exits
// NON-ZERO, which is all CI reads, and that it does so with the control's own summary
// line rather than with an unrelated crash — a planted defect that makes the suite
// die on a syntax error or a nil call proves nothing about the assertions.
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

// Also prove the suite is GREEN with nothing planted. A control pair that is red in
// both modes and red at baseline too would be indistinguishable from this one.
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
