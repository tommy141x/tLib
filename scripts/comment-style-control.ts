#!/usr/bin/env bun
/**
 * Negative control for `scripts/comment-style-gate.ts`.
 *
 * Three things make this gate cheap to fool, and each gets a case below:
 *
 *   - `run()` reads whatever file list it is handed and reports nothing for a
 *     path that does not exist, so a wrong cwd or a widened exclusion prints a
 *     clean verdict in milliseconds. Every red case here asserts a named
 *     finding; no case trusts a zero on its own, and the file-set floor is
 *     asserted in both directions.
 *   - A gate that fires on correct code gets switched off. Half the fixture is
 *     deliberately correct: an emoji and a box-drawing banner inside string
 *     literals in all three languages, which is real code in this tree
 *     (`server/sv_demo.lua` prints a boxed banner), plus a licence-headed file
 *     that must be skipped whole.
 *   - String-awareness is the one piece of judgement in the two character
 *     rules, so the last drill re-reads the correct fixture with a naive
 *     any-line-containing-the-character reader and REQUIRES it to go red.
 *     Without that, the green case above passes for free and proves nothing.
 *
 * Plus a broken-gate drill per rule: each rule is removed through the real
 * `skip` plumbing and the fixture that was red must go green.
 *
 * It proves the rules discriminate. It does not prove the rule set is complete,
 * and it says nothing about whether a comment is worth keeping -- that is a
 * judgement in `docs/CODE-STYLE.md`, not something a regex can hold.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_PATH,
  BOX_DRAWING,
  EMOJI,
  floorOk,
  loadBaseline,
  MIN_FILES,
  RATIO_MAX,
  RATIO_MIN_LINES,
  run,
} from "./comment-style-gate.ts";

// The OS temp dir, not the repo: a fixture in the tree would be swept up by the
// very gate it tests, and other agents work in this tree.
const root = join(tmpdir(), `tlib-comment-style-control-${process.pid}`);
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

/** The gate's own count for a fixture, so no ratchet case hard-codes a number. */
const countOf = (rel: string) => {
  const r = run({ root, files: [rel] }).stats.ratios[0];
  if (!r) throw new Error(`countOf: the gate measured nothing for ${rel}`);
  return r.comments;
};

const plant = (name: string, body: string) => {
  writeFileSync(join(root, name), body);
  return name;
};

mkdirSync(root, { recursive: true });

/** Correct code in all three languages. Must produce nothing, from every rule. */
const CORRECT = {
  ts: `// A plain comment with an arrow -> and an em dash, which are prose.
const banner = "╔══╗ boxed output ╔══╗";
const warn = "⚠️ something went wrong";
// A comment marker inside a string, FOLLOWED by decoration. Drop the string
// tracking and this line alone turns into a divider finding, which is what makes
// the green verdict above attributable to the rule.
const notAComment = "https://example.test//═══ ⚠️";
const alsoNot = "/* ══ ⛔ */";
const re = /\\/\\//;
console.log(banner, warn, notAComment, alsoNot, re);
`,
  lua: `-- The gate's own shape, said once.
local banner = '^1╔═══╗^7'
local warn = '⚠️ demo mode is on'
local notAComment = '-- ═══ ⚠️ still a string'
local long = [[
  ═══ a long-bracket STRING, not a comment ═══
]]
print(banner, warn, notAComment, long)
`,
  css: `/* What this sheet is. */
.banner::before { content: "═══"; }
.warn::after { content: "⚠️"; }
.tricky::after { content: "/* ══ ⛔ */"; }
`,
};

/** Each of these plants one violation, in a comment, and is named below. */
const DEFECTS = {
  ts: `// ⚠️ an emoji in a line comment
/* ── a divider in a block comment ── */
export const x = 1;
`,
  lua: `-- ⛔ an emoji in a Lua comment
--[[ ═══ a divider inside a long comment ═══ ]]
local x = 1
`,
  css: `/* ⭐ an emoji in a CSS comment */
/* ──── a divider ──── */
.x { color: red; }
`,
};

const ratioFile = (lines: number, commentLines: number) => {
  const out: string[] = [];
  for (let i = 0; i < commentLines; i++) out.push(`// prose line ${i}`);
  for (let i = commentLines; i < lines; i++) out.push(`export const v${i} = ${i};`);
  return `${out.join("\n")}\n`;
};

try {
  // 0. The character classes themselves, on the glyphs the standard names and
  //    on the prose characters it deliberately allows.
  setCheck(
    "EMOJI matches the severity glyphs",
    ["⚠", "⛔", "⭐", "✅", "❌", "\u{1F534}"].filter((c) => !EMOJI.test(c)),
    []
  );
  setCheck(
    "EMOJI does NOT match typographic arrows, dashes or ellipsis",
    ["→", "←", "↔", "⇒", "—", "–", "…", "·"].filter((c) => EMOJI.test(c)),
    []
  );
  setCheck(
    "BOX_DRAWING matches the divider and frame glyphs",
    ["─", "═", "│", "┌", "█"].filter((c) => !BOX_DRAWING.test(c)),
    []
  );
  check("BOX_DRAWING does not match an em dash", !BOX_DRAWING.test("—"));

  // 1. The file-set floor, both directions. A gate that reports nothing because
  //    it read nothing is the failure this exists to catch.
  check(`the floor rejects ${MIN_FILES - 1} files`, !floorOk(MIN_FILES - 1));
  check("the floor rejects an empty file set", !floorOk(0));
  check(`the floor accepts ${MIN_FILES} files`, floorOk(MIN_FILES));
  const real = run();
  check(
    `the real pushable file set clears the floor (measured ${real.stats.files})`,
    floorOk(real.stats.files)
  );

  // 2. A path that does not exist yields nothing, so no zero is trusted alone.
  setCheck(
    "a missing file yields no findings",
    run({ root, files: ["no-such-file.ts"] }).findings.map((f) => f.rule),
    []
  );

  // 3. Correct code is green, in all three languages.
  const correctFiles = [
    plant("correct.ts", CORRECT.ts),
    plant("correct.lua", CORRECT.lua),
    plant("correct.css", CORRECT.css),
  ];
  setCheck(
    "correct code: an emoji or a boxed banner in a STRING is not a finding",
    run({ root, files: correctFiles }).findings.map((f) => `${f.file}:${f.rule}`),
    []
  );

  // 4. Each planted defect turns an exact named set red.
  const defectFiles = [
    plant("defect.ts", DEFECTS.ts),
    plant("defect.lua", DEFECTS.lua),
    plant("defect.css", DEFECTS.css),
  ];
  setCheck(
    "planted emoji are reported, by file",
    run({ root, files: defectFiles })
      .findings.filter((f) => f.rule === "emoji")
      .map((f) => f.file),
    ["defect.ts", "defect.lua", "defect.css"]
  );
  setCheck(
    "planted dividers are reported, by file",
    run({ root, files: defectFiles })
      .findings.filter((f) => f.rule === "divider")
      .map((f) => f.file),
    ["defect.ts", "defect.lua", "defect.css"]
  );

  // 5. The ratio rule, on both sides of both of its thresholds.
  const over = plant(
    "over.ts",
    ratioFile(RATIO_MIN_LINES, Math.ceil(RATIO_MIN_LINES * RATIO_MAX) + 10)
  );
  const atCeiling = plant("at-ceiling.ts", ratioFile(RATIO_MIN_LINES, RATIO_MIN_LINES * RATIO_MAX));
  const shortFile = plant("short.ts", ratioFile(RATIO_MIN_LINES - 1, RATIO_MIN_LINES - 1));
  setCheck(
    "a long file over the ceiling is reported",
    run({ root, files: [over] })
      .findings.filter((f) => f.rule === "ratio")
      .map((f) => f.file),
    [over]
  );
  setCheck(
    "a long file exactly AT the ceiling is not reported",
    run({ root, files: [atCeiling] })
      .findings.filter((f) => f.rule === "ratio")
      .map((f) => f.file),
    []
  );
  setCheck(
    `a file under ${RATIO_MIN_LINES} lines is not reported however dense`,
    run({ root, files: [shortFile] })
      .findings.filter((f) => f.rule === "ratio")
      .map((f) => f.file),
    []
  );
  // A trailing comment on a line of code is not a whole-line comment and must
  // not count: the standard says so, and counting it would push every densely
  // annotated file over without any wall of prose in it.
  const trailing = plant(
    "trailing.ts",
    `${Array.from({ length: RATIO_MIN_LINES }, (_, i) => `export const t${i} = ${i}; // why`).join("\n")}\n`
  );
  setCheck(
    "trailing comments do not count towards the ratio",
    run({ root, files: [trailing] })
      .findings.filter((f) => f.rule === "ratio")
      .map((f) => f.file),
    []
  );

  // 6. A licence-headed file is skipped whole: every rule, and the ratio too.
  const licensed = plant(
    "licensed.ts",
    `/*!
 * SPDX-License-Identifier: MIT
 * ────────── ⚠️ ──────────
 */
${ratioFile(RATIO_MIN_LINES, RATIO_MIN_LINES - 4)}`
  );
  setCheck(
    "a licence-headed file is exempt from every rule",
    run({ root, files: [licensed] }).findings.map((f) => f.rule),
    []
  );
  check(
    "and it is not merely unread -- an identical file without the licence is red",
    run({
      root,
      files: [
        plant(
          "unlicensed.ts",
          `/*!\n * ─── ⚠️ ───\n */\n${ratioFile(RATIO_MIN_LINES, RATIO_MIN_LINES - 4)}`
        ),
      ],
    }).findings.length > 0
  );

  // 7. Broken-gate drills: remove each rule through the real `skip` plumbing and
  //    the fixture that was red MUST go green. Without this, "the defects were
  //    reported" is not evidence the rule caused it.
  for (const rule of ["emoji", "divider"] as const) {
    setCheck(
      `DRILL: with the ${rule} rule removed, the planted ${rule} goes green`,
      run({ root, files: defectFiles, skip: [rule] })
        .findings.filter((f) => f.rule === rule)
        .map((f) => f.file),
      []
    );
  }
  setCheck(
    "DRILL: with the ratio rule removed, the over-ceiling file goes green",
    run({ root, files: [over], skip: ["ratio"] })
      .findings.filter((f) => f.rule === "ratio")
      .map((f) => f.file),
    []
  );

  // 7b. The ratchet. The baseline is the one part of this gate that can rot, and
  //     a ledger that outlives what it describes is the failure a sibling
  //     resource already shipped -- five claimed live bugs, three of them long
  //     fixed. So all four directions are required, including the two that
  //     demand the entry be DELETED.
  setCheck(
    "a pinned file at its pinned count is green",
    run({ root, files: [over], baseline: { [over]: countOf(over) } }).findings.map((f) => f.rule),
    []
  );
  setCheck(
    "a pinned file that grew is reported",
    run({ root, files: [over], baseline: { [over]: countOf(over) - 1 } })
      .findings.filter((f) => f.rule === "ratio-ratchet")
      .map((f) => f.file),
    [over]
  );
  setCheck(
    "a pinned file now UNDER the ceiling is reported, so the entry cannot linger",
    run({ root, files: [atCeiling], baseline: { [atCeiling]: 999 } })
      .findings.filter((f) => f.rule === "ratio-ratchet")
      .map((f) => f.file),
    [atCeiling]
  );
  setCheck(
    "a pinned file that is no longer measured is reported",
    run({ root, files: [atCeiling], baseline: { "gone/away.ts": 10 } })
      .findings.filter((f) => f.rule === "ratio-ratchet")
      .map((f) => f.file),
    ["gone/away.ts"]
  );
  setCheck(
    "DRILL: with the ratio rule removed, every ratchet finding goes green too",
    run({ root, files: [over], baseline: { "gone/away.ts": 10 }, skip: ["ratio"] }).findings.map(
      (f) => f.rule
    ),
    []
  );
  // The shipped baseline is held to the same rule as the fixtures: it must parse,
  // and `check:comments` is what asserts every entry in it is still live.
  check(
    `the shipped ${BASELINE_PATH.split(/[\\/]/).pop()} parses and pins only line counts`,
    Object.values(loadBaseline()).every((n) => Number.isInteger(n) && n >= 0)
  );

  // 8. The string-awareness drill. This is the one piece of judgement in the two
  //    character rules: a naive reader that flags any LINE containing the
  //    character must go red on the correct fixture. If it agrees with the gate,
  //    case 3 stopped exercising anything and this control is theatre.
  const naive: string[] = [];
  for (const rel of correctFiles) {
    const src = await Bun.file(join(root, rel)).text();
    for (const [i, line] of src.split("\n").entries()) {
      if (EMOJI.test(line) || BOX_DRAWING.test(line)) naive.push(`${rel}:${i + 1}`);
    }
  }
  check(
    "DRILL: a naive any-line reader goes red on the correct fixture in all three languages",
    new Set(naive.map((s) => s.split(":")[0])).size === 3,
    `naive hits: ${naive.join(", ") || "none"}`
  );
  check(
    "DRILL: and the real gate finds none of them",
    naive.length > 0 && run({ root, files: correctFiles }).findings.length === 0
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\ncomment-style control: all cases behaved as required."
    : `\ncomment-style control: ${failures.length} case(s) did not behave as required:\n  ${failures.join("\n  ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
