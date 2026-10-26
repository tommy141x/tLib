#!/usr/bin/env bun
/**
 * `bun run test:dom` — tLib's DOM component suite.
 *
 * A wrapper rather than an inline `cd client/web && bun test …`, because:
 *
 * 1. `bun test <path>` SILENTLY CONTRIBUTES ZERO for a path that is not there
 *    when more than one path is given, and a single missing path exits 1 with an
 *    error that looks like a crash. The directory is asserted here first.
 * 2. Existence is not coverage. A `tests/` emptied of every `.test.tsx` still
 *    passes the existence check and exits 0 with a smaller number.
 *    `MINIMUM_TESTS` closes that.
 * 3. `--conditions=browser` is load-bearing (see `client/web/tests/_setup.ts`).
 *    The preload refuses to run without it, so this is belt and braces.
 *
 * The suite runs from `client/web` because node resolution walks up from the
 * importing FILE, and `client/web` is the only install in this repo that has
 * solid-js — and the only one whose `resolve.dedupe` list matches the shipped
 * bundle's. See `client/web/tests/_setup.ts`.
 */

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WEB = resolve(ROOT, "client", "web");

/**
 * The suite may not shrink below this many passing tests. MEASURED, not a target:
 * `client/web/tests` reports 129 today. A floor rather than an equality, but it
 * has to stay close enough to the real count that a whole FILE going empty cannot
 * slip under it. A stale floor is not a conservative floor: tLS left one at 209
 * while its suite grew to 398, which had quietly disarmed it. Re-measure when you
 * add a batch.
 *
 * Do not trust this suite for anything about reactive-write errors: Solid 2's
 * [REACTIVE_WRITE_IN_OWNED_SCOPE] guard is DEV-ONLY and is not live here (measured
 * by probe), so a `not.toThrow()` on that class of defect passes against the bug.
 *
 * prop-editor and the `ui/` control kit live in `internal/`, which
 * publish-public.ts strips, so in a PUBLIC clone those files skip their cases and
 * the suite is legitimately smaller. MEASURED per file, not apportioned:
 * prop-editor-guard 24; export-badge 31; undo-redo-ui 16; confirm-delete-unmount
 * 3; harness 1 (the one case needing a component from a second package tree).
 */
const INTERNAL_ONLY_TESTS = 24 + 31 + 16 + 3 + 1;
const HAS_INTERNAL =
  existsSync(resolve(ROOT, "internal", "shared-ts", "prop-editor", "PropEditor.tsx")) &&
  existsSync(resolve(ROOT, "internal", "shared-ts", "ui", "undo-redo.tsx"));
const DEFAULT_MINIMUM_TESTS = HAS_INTERNAL ? 126 : 126 - INTERNAL_ONLY_TESTS;

const raw = process.env.TLIB_DOM_TEST_MIN;
let MINIMUM_TESTS = DEFAULT_MINIMUM_TESTS;
if (raw !== undefined) {
  // `Number("")` is 0, not NaN, so a digits-only test is required rather
  // than an `isInteger && >= 0` check — an empty override would otherwise set
  // the floor to zero and disable the one guard this file exists to provide.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(
      `test:dom: TLIB_DOM_TEST_MIN is not a non-negative integer: ${JSON.stringify(raw)}`
    );
    process.exit(1);
  }
  MINIMUM_TESTS = parsed;
}

for (const path of [
  resolve(WEB, "tests"),
  resolve(WEB, "tests", "_setup.ts"),
  resolve(WEB, "bunfig.toml"),
]) {
  try {
    await access(path);
  } catch {
    console.error(
      `test:dom: MISSING — ${path}\n` +
        "The DOM suite needs its directory, its preload and the bunfig that loads " +
        "the preload. Without the preload there is no DOM, no production Solid " +
        "compiler and no dedupe, and bun would still exit 0 on whatever managed " +
        "to run."
    );
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const run = Bun.spawnSync(
  ["bun", "test", "--conditions=browser", ...(args.length ? args : ["tests"])],
  {
    cwd: WEB,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  }
);
const stdout = run.stdout.toString();
const stderr = run.stderr.toString();
process.stdout.write(stdout);
process.stderr.write(stderr);

if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);

// bun reports the summary on stderr, but do not depend on which stream it picks.
const passed = Number(/^\s*(\d+)\s+pass$/m.exec(stderr + stdout)?.[1]);
if (!Number.isFinite(passed)) {
  console.error(
    "test:dom: COULD NOT READ THE PASS COUNT out of bun's summary. The floor " +
      "check is the only thing standing between an emptied test directory and a " +
      "green run, so an unreadable summary is a failure, not a shrug."
  );
  process.exit(1);
}
if (passed < MINIMUM_TESTS) {
  console.error(
    `test:dom: SUITE SHRANK — ${passed} passing, floor is ${MINIMUM_TESTS}.\n` +
      "Every required path exists, so this is tests disappearing from inside one " +
      "of them. Either restore them, or lower DEFAULT_MINIMUM_TESTS in " +
      "scripts/dom-test.ts in the same change that deliberately removes them."
  );
  process.exit(1);
}
