#!/usr/bin/env bun
/**
 * The control for `cef-output-contract.ts`. Run it before trusting that gate.
 *
 * ⛔ WHY A CONTROL AT ALL, AND WHY THIS SHAPE. A sibling gate's first control
 * passed GREEN while a whole reader had been deleted, because every fixture was
 * reachable by a second path — so "the gate failed" was satisfied by the wrong
 * rule. This control therefore asserts the EXACT rule id each fixture trips, and
 * asserts that no OTHER rule trips on it. A fixture that fires two rules is a
 * failure here even though it is "red", because then it proves nothing about the
 * rule it was written for.
 *
 * Every defect fixture is built from `clean()`, which already clears both floors
 * (it is over the byte floor and it carries a legacy `min-width` query), so the
 * one difference between a fixture and a passing build is the defect itself.
 *
 * The two floor fixtures are the opposite case and are expected to be the ONLY
 * rule that fires: an empty output directory, and a stylesheet with a Level 4
 * query and nothing legacy — which is what a `target: "esnext"` regression
 * actually looks like, and which must trip R-MQ4-RANGE *and* R-MEDIA-FLOOR.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCefOutput } from "./cef-output-contract.ts";

/**
 * A stylesheet that must pass every rule: over the byte floor, and carrying a
 * legacy media query so R-MEDIA-FLOOR is satisfied.
 *
 * The padding is a comment rather than real rules so that adding a rule to the
 * gate later cannot accidentally match the padding.
 */
function clean(): string {
  const padding = `/*${"x".repeat(2400)}*/`;
  return (
    `:root{--border:210 20% 90%;--radius:0.625rem}` +
    `.panel{background:hsl(var(--border));border-radius:var(--radius)}` +
    `@media (min-width: 1024px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}` +
    `${padding}`
  );
}

type Fixture = {
  name: string;
  /** `null` writes no file at all (empty output directory). */
  css: string | null;
  /** The rule ids this fixture must trip — exactly these, no more, no fewer. */
  expect: string[];
  why: string;
};

const FIXTURES: Fixture[] = [
  {
    name: "clean",
    css: clean(),
    expect: [],
    why: "the baseline. If this is not green, every red below is meaningless.",
  },
  {
    name: "oklch",
    css: `${clean()}.btn{color:oklch(0.62 0.19 259.8)}`,
    expect: ["R-OKLCH"],
    why: "presetWind4 ships its palette as oklch() literals (Chromium 111).",
  },
  {
    name: "color-mix",
    css: `${clean()}.btn{background:color-mix(in srgb, #fff 40%, transparent)}`,
    expect: ["R-COLOR-MIX"],
    why: "presetWind4 compiles every colour utility through color-mix() (Chromium 111).",
  },
  {
    name: "oklab",
    css: `${clean()}.btn{color:oklab(59% 0.1 0.1)}`,
    expect: ["R-OKLAB"],
    why: "the colour space Wind4 mixes IN; arrives by the same route as the two above.",
  },
  {
    name: "has",
    css: `${clean()}.row:has(.badge){padding-left:1rem}`,
    expect: ["R-HAS"],
    why: ":has() is Chromium 105; CEF 103 drops the whole rule, not just a declaration.",
  },
  {
    name: "mq4-range-ge",
    css: `${clean()}@media (width>=1024px){.grid{display:grid}}`,
    expect: ["R-MQ4-RANGE"],
    why: "the exact form esbuild/oxc emits at target:esnext. Chromium 104.",
  },
  {
    name: "mq4-range-spaced",
    css: `${clean()}@media (width >= 48rem){.grid{display:grid}}`,
    expect: ["R-MQ4-RANGE"],
    why: "same defect written with spaces — the minifier is not the only producer.",
  },
  {
    name: "mq4-range-interval",
    css: `${clean()}@media (400px<=width<=700px){.grid{display:grid}}`,
    expect: ["R-MQ4-RANGE"],
    why: "the two-sided interval form, which a single-operator regex would miss.",
  },
  {
    name: "mq4-only-no-legacy",
    // Deliberately NOT built on clean(): this is the real shape of the
    // target:esnext regression, where EVERY query was rewritten.
    css: `:root{--radius:0.625rem}@media (width>=1024px){.grid{display:grid}}/*${"x".repeat(2400)}*/`,
    expect: ["R-MQ4-RANGE", "R-MEDIA-FLOOR"],
    why: "a whole-sheet rewrite. Must trip the range rule AND the floor, which is the backstop if the range regex ever stops matching a new spelling.",
  },
  {
    name: "floor-no-legacy-media",
    css: `:root{--radius:0.625rem}.panel{border-radius:var(--radius)}/*${"x".repeat(2400)}*/`,
    expect: ["R-MEDIA-FLOOR"],
    why: "⛔ the vacuous pass. No bad strings and no media queries — R-MQ4-RANGE is green here and means nothing.",
  },
  {
    name: "floor-tiny-sheet",
    css: `@media (min-width: 1024px){.a{color:red}}`,
    expect: ["R-SIZE-FLOOR"],
    why: "⛔ a collapsed UnoCSS scan. Tiny sheet, no error, passes every forbidden-string rule.",
  },
  {
    name: "floor-empty-dir",
    css: null,
    expect: ["R-SIZE-FLOOR", "R-MEDIA-FLOOR"],
    why: "⛔ no CSS emitted at all — the most perfect vacuous pass available.",
  },
];

const root = mkdtempSync(join(tmpdir(), "cef-contract-control-"));
let failures = 0;

console.log(`cef-output-contract control — ${FIXTURES.length} fixtures in ${root}\n`);

for (const fixture of FIXTURES) {
  const dist = join(root, fixture.name, "assets");
  mkdirSync(dist, { recursive: true });
  if (fixture.css !== null) writeFileSync(join(dist, "index-abc123.css"), fixture.css, "utf8");

  const result = checkCefOutput({ dist: join(root, fixture.name) });
  const got = [...new Set(result.findings.map((f) => f.rule))].sort();
  const want = [...fixture.expect].sort();
  const ok = got.length === want.length && got.every((r, i) => r === want[i]);

  if (ok) {
    console.log(`  PASS  ${fixture.name.padEnd(22)} ${want.length ? `red: ${want.join(", ")}` : "green"}`);
  } else {
    failures++;
    console.error(
      `  FAIL  ${fixture.name.padEnd(22)} expected [${want.join(", ") || "green"}] but got [${got.join(", ") || "green"}]`
    );
    console.error(`        why this fixture exists: ${fixture.why}`);
  }
}

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(
    `\n${failures} of ${FIXTURES.length} control fixtures did not behave as specified. ` +
      "Do NOT trust check:cef until this is green — a gate whose control is red is " +
      "indistinguishable from a gate that passes because it is reading nothing."
  );
  process.exit(1);
}
console.log(`\nAll ${FIXTURES.length} fixtures behaved exactly as specified.`);
