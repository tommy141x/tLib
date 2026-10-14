#!/usr/bin/env bun
/**
 * `bun run test:dom:control` — the negative control for the DOM suite.
 *
 * What a control here can and cannot prove
 *
 * A PASSING CONTROL PROVES THE ASSERTION STILL FIRES. IT DOES NOT PROVE THE
 * RULE SET IS COMPLETE, and — the sharper half — it does not prove the assertion
 * covers the path where the defect would really occur. tUnit learned the second
 * one the expensive way: its first control broke a synchronous mirror and the
 * proof PASSED, because the only path that control exercised was a slider burst
 * whose commit lands 400ms later, by which time the store has flushed and the
 * trap cannot bite. A control that cannot reach the hazard reads as a clean bill
 * of health.
 *
 * So every defect in `client/web/tests/_setup.ts`'s `DEFECTS` table declares the
 * code `path` it travels, and this runner asserts the EXACT named set of tests
 * it reddens. A defect that reddens nothing, or reddens something other than
 * what it declared, is a failed control — not a pass.
 *
 * How the defect is planted
 *
 * In the REAL source bytes, in memory, through the loader — not in a copy of the
 * logic rewritten inside a test, and nothing is written to disk (this tree has
 * other agents working in it). Each entry declares how many times its `find`
 * must match, because A SUBSTITUTION THAT MATCHES NOTHING HANDS THE SUITE THE
 * UNMODIFIED MODULE and the control then asserts that correct code is correct.
 *
 * Two traps for whoever adds a defect to that table
 *
 * A multi-line `find` has to match its target's own line endings: PropEditor.tsx
 * is CRLF and LayoutEditor.tsx is LF, and two anchors matched nothing because of
 * it. And a defect's blast radius can far exceed the file it was planted in —
 * `spread-arity-verbatim` reddens most of the suite, because the Solid 1
 * `spread` arity bug throws inside a render effect and Solid 2 halts the
 * reactive graph for the whole PROCESS, so files that never import lucide-solid
 * go red too. Declare the radius you measured, not the one you expect.
 *
 * Exit codes
 *
 *   0  every defect reddened exactly what it declared, the drill fired, and the
 *      baseline is green
 *   1  a defect reddened the wrong set, or nothing
 *   2  the control could not run, which is NOT a pass
 */

import { resolve } from "node:path";
import { DOM_CONTROL_DEFECTS } from "../client/web/tests/_defects.ts";

const ROOT = resolve(import.meta.dir, "..");
const WEB = resolve(ROOT, "client", "web");

interface Run {
  exitCode: number;
  output: string;
  /** Every `(fail) …` line's test name, trimmed of bun's timing suffix. */
  failures: string[];
}

function runSuite(env: Record<string, string> = {}): Run {
  const proc = Bun.spawnSync(["bun", "test", "--conditions=browser", "tests"], {
    cwd: WEB,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const output = proc.stdout.toString() + proc.stderr.toString();
  const failures = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) =>
    // bun prints `describe > describe > test`; the leaf name is what the table
    // declares, because a describe block's wording is prose and will be edited.
    m[1]!.split(" > ").pop()!.trim()
  );
  return { exitCode: proc.exitCode ?? 1, output, failures };
}

let bad = 0;
const say = (ok: boolean, line: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) bad++;
};

// 0. The baseline must be GREEN
//
// Without this, every red result below is unattributable: a suite that is
// already failing reddens the named tests whatever is planted.
{
  const base = runSuite();
  say(base.exitCode === 0, `baseline is green (exit ${base.exitCode})`);
  if (base.exitCode !== 0) {
    console.error(base.output);
    console.error(
      "control: THE BASELINE IS RED, so nothing below can be attributed to a " +
        "planted defect. Fix the suite first."
    );
    process.exit(2);
  }
}

// 1. The broken-gate drill
//
// `drill-cannot-match`'s `find` is not in the file. The preload MUST throw
// rather than hand the suite an unpatched module and a green run. Without this
// case, "every defect reddened something" is not evidence that the patcher is
// wired up at all.
{
  const drill = runSuite({ DOM_CONTROL: "drill-cannot-match" });
  const refused = drill.exitCode !== 0 && /matched 0 time\(s\)/.test(drill.output);
  say(refused, "broken-gate drill: an unmatchable substitution REFUSES to run");
  if (!refused) console.error(drill.output.slice(0, 4000));
}

// 2. An unknown name is refused rather than silently ignored
{
  const unknown = runSuite({ DOM_CONTROL: "no-such-defect" });
  const refused = unknown.exitCode !== 0 && /is not a known defect/.test(unknown.output);
  say(refused, "an unknown DOM_CONTROL name REFUSES to run");
}

// 3. Each real defect reddens EXACTLY what it declares
for (const [name, defect] of Object.entries(DOM_CONTROL_DEFECTS)) {
  if (defect.reddens.length === 0) continue; // the drill, handled above
  const run = runSuite({ DOM_CONTROL: name });

  // The defect must have been APPLIED. A file the suite never imports cannot be
  // patched, and a green control would then read as "the defect did not matter"
  // when it means "the defect was never applied". The preload prints this line;
  // a global could not be read across the process boundary.
  const planted = run.output.includes(`PLANTED DOM_CONTROL=${name} in ${defect.file}`);
  say(planted, `${name}: the defect was planted in ${defect.file}`);

  const expected = new Set(defect.reddens);
  const actual = new Set(run.failures);
  const missing = [...expected].filter((t) => !actual.has(t));
  const extra = [...actual].filter((t) => !expected.has(t));

  say(
    run.exitCode !== 0,
    `${name}: the suite goes RED (exit ${run.exitCode}) — path: ${defect.path}`
  );
  say(missing.length === 0, `${name}: reddens all ${expected.size} declared test(s)`);
  if (missing.length) console.error(`  missing: ${JSON.stringify(missing, null, 2)}`);
  // Over-reach, as a measured total rather than a list of prose titles — see
  // `Defect.total` in `_defects.ts` for why that trade is made this way.
  say(
    run.failures.length === defect.total,
    `${name}: blast radius is ${defect.total} test(s), measured ${run.failures.length}`
  );
  if (run.failures.length !== defect.total) {
    console.error(`  all failures: ${JSON.stringify(run.failures, null, 2)}`);
  }
  if (extra.length) console.log(`  (also red, declared blast radius: ${extra.length})`);
}

console.log(
  bad === 0
    ? "\ncontrol: all checks passed. Note what this does and does not mean — see this file's header."
    : `\ncontrol: ${bad} check(s) failed.`
);
process.exit(bad === 0 ? 0 : 1);
