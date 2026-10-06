/**
 * Negative control for the two CSS-contract gates in
 * `shared/ts/build/css-contract.ts`, which ride inside every resource's
 * `check:classes`.
 *
 * Why this file exists in this shape, and not as three `expect` calls:
 *
 *   • These gates are cheap to fool by accident. `walkCss` returns `[]` for a
 *     directory that does not exist, so a renamed `src/`, a wrong cwd or a
 *     widened skip rule all print "No surface.css class collisions." and exit 0
 *     in milliseconds. So the first thing asserted is that the fixtures the
 *     control planted are actually BEING READ -- by requiring named findings
 *     from them, never by trusting a zero.
 *
 *   • A gate that fires on correct code gets switched off by the next person,
 *     which is worse than no gate. Half the fixture is deliberately CORRECT
 *     usage -- `.panel .toolbar`, a hard-edged zero-blur shadow -- and is
 *     required to produce nothing.
 *
 *   • Findings are asserted as an exact SET OF NAMES, not a count. A count is
 *     satisfied by the wrong finding and goes stale the moment surface.css
 *     gains a class.
 *
 *   • The last case is a BROKEN-GATE drill: `subjectClasses` is the one piece of
 *     judgement in gate 1 (rightmost compound only), and a control that never
 *     removes it cannot tell whether the correct-usage case passed because the
 *     rule works or because nothing was looking. So the drill re-runs the
 *     correct-usage fixture through a deliberately naive "every class in the
 *     selector" reading and REQUIRES it to go red. If that reading also passes,
 *     the fixture is not exercising the rule and this control is theatre.
 *
 * It proves the gates discriminate. It cannot prove the gate set is complete.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blurredShadow,
  cssRules,
  findBlurredShadows,
  findSurfaceCollisions,
  subjectClasses,
  surfaceClassNames,
} from "../shared/ts/build/index.ts";

const root = join(tmpdir(), `tlib-css-contract-control-${process.pid}`);
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function sameSet(actual: string[], expected: string[]): boolean {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function setCheck(name: string, actual: string[], expected: string[]): void {
  check(
    name,
    sameSet(actual, expected),
    `expected {${[...expected].sort().join(", ")}}\n        actual   {${[...new Set(actual)].sort().join(", ")}}`
  );
}

// ── Fixture ────────────────────────────────────────────────────────────────────
//
// Written to the OS temp dir rather than into the repo: a fixture under `src`
// would be swept up by the very gate it is testing, and by every other
// resource's `check:classes` too.

mkdirSync(root, { recursive: true });

/* Correct, idiomatic consumer CSS. Every rule here MUST pass both gates. */
writeFileSync(
  join(root, "correct.css"),
  `@layer components {
  /* Styling something INSIDE a shared panel -- the supported way to use it. */
  .panel .toolbar { gap: 6px; }
  .panel > .list-row-count { opacity: .8; }
  /* A name of our own that merely contains a shared one. */
  .my-panel { padding: 4px; }
  .panel-header { font-weight: 600; }
  /* A shared class named only inside :not() / an attribute value. */
  .toolbar:not(.panel) { margin: 0; }
  .toolbar[data-of=".segment"] { margin: 0; }
  /* Zero-blur shadows: hard-edged, composite fine, explicitly allowed. */
  .thumb { box-shadow: 0 0 0 2px hsl(var(--background)); }
  .bar   { box-shadow: inset 3px 0 currentColor; }
  .tint  { box-shadow: inset 0 0 0 999px rgb(127 127 127 / 0.12); }
  .flat  { box-shadow: none; }
  /* A fractional alpha inside a colour function is not a blur radius. */
  .ring  { box-shadow: 0 0 0 2px hsl(var(--ring) / 0.4); }
}
`
);

/* Each of these re-declares a surface class. Exact set asserted below. */
writeFileSync(
  join(root, "collide.css"),
  `.panel { background: #111; }
@layer components {
  /* Overriding only a state is still a fork of the rule. */
  .prop-input:focus-visible { outline: none; }
  /* Rightmost compound, under a descendant selector. */
  .editor .list-row { color: red; }
  /* A selector list: both subjects count, the non-surface one is ignored. */
  .segment, .whatever { font-weight: 700; }
  /* Media-nested, to prove at-rules are descended into. */
  @media (width < 900px) {
    .field-hint { font-size: 10px; }
  }
}
`
);

/* Each of these blurs. Exact set of selectors asserted below. */
writeFileSync(
  join(root, "blur.css"),
  `.drop { box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3); }
.inner { box-shadow: inset 0 0 8px rgba(255, 255, 255, 0.2); }
.listed { box-shadow: 0 0 0 2px red, 0 2px 6px rgb(0 0 0 / 0.4); }
.em { box-shadow: 0 0 0.5rem #000; }
`
);

try {
  // ── 0. The walker descends at-rules and does not choke on the hard selector ─
  const probe = cssRules(
    `@layer components { .segment:hover:not([aria-pressed="true"]):not([a-b="x{y"]) { color: red } }`
  );
  setCheck(
    "the walker descends @layer and survives a quoted brace in an attribute",
    probe.flatMap((r) => subjectClasses(r.selector)),
    ["segment"]
  );

  // ── 1. surface.css is the source of the guarded names, not a list here ─────
  const surface = surfaceClassNames();
  const mustGuard = [
    "panel",
    "section-label",
    "field-hint",
    "prop-input",
    "segment",
    "segment-track",
    "list-row",
    "row-action",
  ];
  const missing = mustGuard.filter((n) => !surface.has(n));
  check(
    `surface.css declares every guarded name {${mustGuard.join(", ")}}`,
    missing.length === 0,
    `not found in surface.css: ${missing.join(", ")}`
  );
  check(
    "a class surface.css does NOT declare is not guarded (settings-panel)",
    !surface.has("settings-panel")
  );
  // `.list-row.selected` is the one compound subject in surface.css. Harvesting
  // both of its classes put bare `selected` in the guarded set and reported
  // tELS's unrelated `.selected` -- the only false positive in a nine-bundle
  // sweep. A state modifier compounded onto something is not a forkable rule.
  setCheck(
    "a state modifier from a compound subject is not guarded on its own",
    [...surface].filter((n) => n === "selected"),
    []
  );

  // ── 2. Correct usage produces nothing, from either gate ────────────────────
  const correct = { cssRoots: [root] };
  const onlyCorrect = { cssRoots: [join(root, "..", "nope")] };
  check(
    "a missing cssRoot yields no findings, so a zero can never be trusted alone",
    findSurfaceCollisions(onlyCorrect).length === 0 && findBlurredShadows(onlyCorrect).length === 0
  );

  // Gate 1, run over the correct fixture alone.
  setCheck(
    "correct usage: no surface collision",
    findSurfaceCollisions({ cssRoots: [root], allowSurfaceCollisions: [] })
      .filter((c) => c.sites.every((s) => s.includes("correct.css")))
      .map((c) => c.name),
    []
  );
  setCheck(
    "correct usage: no blurred shadow",
    findBlurredShadows(correct)
      .filter((f) => f.site.includes("correct.css"))
      .map((f) => f.selector),
    []
  );

  // ── 3. Each planted defect turns an exact named set red ────────────────────
  setCheck(
    "planted collisions are reported, by name",
    findSurfaceCollisions(correct)
      .filter((c) => c.sites.some((s) => s.includes("collide.css")))
      .map((c) => c.name),
    ["panel", "prop-input", "list-row", "segment", "field-hint"]
  );
  setCheck(
    "planted blurs are reported, by selector",
    findBlurredShadows(correct)
      .filter((f) => f.site.includes("blur.css"))
      .map((f) => f.selector),
    [".drop", ".inner", ".listed", ".em"]
  );

  // ── 4. The allow-list escape hatch actually suppresses ─────────────────────
  setCheck(
    "allowSurfaceCollisions suppresses exactly what it names",
    findSurfaceCollisions({ cssRoots: [root], allowSurfaceCollisions: ["panel", "segment"] }).map(
      (c) => c.name
    ),
    ["prop-input", "list-row", "field-hint"]
  );

  // ── 5. Broken-gate drill ───────────────────────────────────────────────────
  //
  // The rightmost-compound rule is the only judgement in gate 1. Replace it
  // with the naive reading and the CORRECT fixture must go red -- otherwise case
  // 2 above passed for free and proves nothing.
  const naive = (selectorList: string): string[] => [
    ...new Set([...selectorList.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] as string)),
  ];
  const naiveHits = new Set<string>();
  for (const rule of cssRules(await Bun.file(join(root, "correct.css")).text(), "correct.css")) {
    for (const n of naive(rule.selector)) if (surface.has(n)) naiveHits.add(n);
  }
  setCheck(
    "DRILL: the naive every-class reading goes red on the correct fixture",
    [...naiveHits],
    ["panel", "segment"]
  );
  check(
    "DRILL: the real reading disagrees with the naive one on that fixture",
    naiveHits.size > 0 &&
      cssRules(await Bun.file(join(root, "correct.css")).text(), "correct.css")
        .flatMap((r) => subjectClasses(r.selector))
        .every((n) => !surface.has(n))
  );

  // ── 6. The blur predicate, on the two values the audit's regex got wrong ───
  check(
    "DRILL: the audit's proposed regex misses `inset 0 0 8px rgba(...)`",
    !/box-shadow:[^;]*[1-9][0-9]*px [1-9]/.test("box-shadow: inset 0 0 8px rgba(255,255,255,.2)") &&
      blurredShadow("inset 0 0 8px rgba(255,255,255,.2)") !== undefined
  );
  check(
    "DRILL: the audit's proposed regex fires on a hard-edged `inset 2px 4px #000`",
    /box-shadow:[^;]*[1-9][0-9]*px [1-9]/.test("box-shadow: inset 2px 4px #000") &&
      blurredShadow("inset 2px 4px #000") === undefined
  );
  // The three shadows tLib actually ships, each required to pass.
  setCheck(
    "tLib's own zero-blur shadows all pass the predicate",
    [
      "inset 3px 0 currentColor",
      "inset 0 0 0 999px #8882",
      "0 0 0 2px hsl(var(--background))",
    ].filter((v) => blurredShadow(v) !== undefined),
    []
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\ncss-contract control: all cases behaved as required."
    : `\ncss-contract control: ${failures.length} case(s) did not behave as required:\n  ${failures.join("\n  ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
