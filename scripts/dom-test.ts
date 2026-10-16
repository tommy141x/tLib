#!/usr/bin/env bun
/**
 * `bun run test:dom` — tLib's DOM component suite.
 *
 * A wrapper rather than an inline `cd client/web && bun test …` for three
 * reasons, each of which is a way the inline form passes while measuring
 * nothing:
 *
 * 1. `bun test <path>` SILENTLY CONTRIBUTES ZERO for a path that is not
 *     there when more than one path is given, and a single missing path exits 1
 *     with an error that looks like a crash. Either way the directory is
 *     asserted here first, so "the DOM suite was deleted" is a named failure.
 * 2. Existence is not coverage. A `tests/` emptied of every `.test.tsx`
 *     still passes the existence check and exits 0 with a smaller number.
 *     `MINIMUM_TESTS` closes that.
 *  3. `--conditions=browser` is load-bearing (see `client/web/tests/_setup.ts`)
 *     and belongs somewhere a reader will find it rather than buried in a
 *     package.json one-liner. The preload itself refuses to run without it, so
 *     this is belt and braces.
 *
 * Why the suite runs from `client/web` at all is answered at length in
 * `client/web/tests/_setup.ts`: node resolution walks up from the importing
 * FILE, and `client/web` is the only install in this repo that has solid-js —
 * and the only one whose `resolve.dedupe` list matches the shipped bundle's.
 */

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WEB = resolve(ROOT, "client", "web");

/**
 * The suite may not shrink below this many passing tests.
 *
 * MEASURED, not a target: 122 is what `client/web/tests` reports today (8
 * harness + 16 undo-redo + 16 undo-keys + 23 prop-editor guard + 9
 * layout-editor-discard + 7 layout-editor-dirty + 9 lucide-spread-arity +
 * 31 export-badge + 3 confirm-delete-unmount).
 *
 * RE-MEASURED 2026-10-15 when `confirm-delete-unmount.test.tsx` landed with the
 * ConfirmDelete disposal fix: 3 tests, which is now the smallest file here and
 * so the margin the floor is allowed. That file is also worth reading before
 * trusting this suite with anything about reactive-write errors — Solid 2's
 * [REACTIVE_WRITE_IN_OWNED_SCOPE] guard is DEV-ONLY and is not live here, which
 * was measured by probe, so a `not.toThrow()` on that class of defect passes
 * against the bug.
 *
 * RE-MEASURED 2026-10-15 when `layout-editor-dirty.test.tsx` landed with the
 * synchronous placement mirror: 7 tests.
 *
 * RE-MEASURED 2026-10-07 TWICE. First when `lucide-spread-arity.test.tsx`
 * landed and `layout-editor-discard.test.tsx` dropped its `lucide-solid` stub:
 * the floor was 64 against a real count of 72. Then when `export-badge.test.tsx`
 * landed with the ExportBadge convergence, taking the suite from 81 to 112 — the
 * floor was 73, which would have let the entire 31-test file vanish without a
 * word, since 81 is comfortably above it.
 *
 * A floor rather than an equality, so adding tests is not a chore — but it has
 * to stay high enough that a whole FILE going empty cannot slip under it. The
 * smallest file here carries 7, so a floor 7 below the real count is the
 * loosest it may be. A stale floor is not a conservative floor: tELS left
 * one at 209 while its suite grew to 398, which had quietly disarmed it.
 * Re-measure when you add a batch.
 */
/**
 * prop-editor lives in `internal/`, which publish-public.ts strips, so in a
 * PUBLIC clone `prop-editor-guard.test.tsx` skips its 24 tests and the suite
 * is legitimately smaller. The floor has to know that or it fires on a clone
 * that is behaving correctly -- a floor that cannot tell "deliberately absent"
 * from "silently vanished" is the stale-floor failure this comment warns about,
 * just in the other direction.
 */
const PROP_EDITOR_GUARD_TESTS = 24;
const HAS_PROP_EDITOR = existsSync(
  resolve(ROOT, "internal", "shared-ts", "prop-editor", "PropEditor.tsx")
);
const DEFAULT_MINIMUM_TESTS = HAS_PROP_EDITOR ? 115 : 115 - PROP_EDITOR_GUARD_TESTS;

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
