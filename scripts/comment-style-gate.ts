#!/usr/bin/env bun
/**
 * Comment-style gate: no emoji, no box-drawing dividers, and a ceiling on how
 * much of a file may be comment. The rules are in `docs/CODE-STYLE.md`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * `.json` is here for the tsconfigs, which are JSONC and carry comments; plain
 * JSON has none, so it costs nothing. The ratio rule skips `.json` and `.toml`:
 * a config file is mostly declarations and a comment ceiling on one says nothing.
 */
const EXTENSIONS = [".lua", ".ts", ".tsx", ".css", ".json", ".toml"];
const RATIO_EXEMPT = [".json", ".toml"];

const EXCLUDED_DIRS = [
  "node_modules",
  ".build",
  ".runtime",
  "dist",
  ".tmp",
  "internal",
  "assets",
  "export-staging",
  join("client", "ui"),
  join("server", "dist"),
];

/**
 * A licence or copyright notice in the first 2 KB means a third-party file whose
 * header is not ours to edit. Deliberately not the word "vendored": tLib's own
 * `deck/` modules describe which of their files get vendored into the Stream
 * Deck plugins, and matching that prose exempted four of our own files.
 */
const VENDOR_MARKERS = [
  "@license",
  "SPDX-License-Identifier",
  "Copyright (c)",
  "Copyright (C)",
  "THE SOFTWARE IS PROVIDED",
];

/**
 * Pictographs, dingbats and the shape glyphs used as severity markers. Plain
 * typographic arrows (U+2190-U+21FF) and dashes are prose, not decoration, and
 * are deliberately not matched.
 */
/*
 * ⚠️ THE TWO COMBINING MARKS ARE AN ALTERNATION, NOT CLASS MEMBERS, AND THAT IS
 * A CORRECTNESS FIX RATHER THAN A LINT APPEASEMENT.
 *
 * `U+FE0F` (variation selector-16) and `U+20E3` (combining enclosing keycap) are
 * COMBINING characters: they have no standalone meaning and exist to modify the
 * code point before them. Listing them inside a character class alongside base
 * pictographs says "match one of these characters", which is not what a
 * combining mark does — biome's `lint/suspicious/noMisleadingCharacterClass`
 * flags exactly that, and its advice is the alternation used here.
 *
 * ⚠️ SEMANTICALLY IDENTICAL FOR THIS GATE. A class `[a b c]` and an alternation
 * `a|b|c` match the same single code points; the difference only matters for
 * grapheme handling, which this gate does not do. Verified rather than argued:
 * `scripts/comment-style-control.ts` asserts in BOTH directions — that EMOJI
 * matches the severity glyphs (⚠ ⛔ ⭐ ✅ ❌ 🔴) and does NOT match typographic
 * arrows, dashes or ellipsis — and both arms still pass.
 *
 * ⛔ WRAPPED IN `(?:…)` DELIBERATELY. Every consumer today uses `.test()` or
 * `.match()` on the pattern whole, where bare alternation is safe — but an
 * unguarded `a|b|c` composed into a larger pattern via `.source` would bind
 * looser than intended and silently match the wrong thing. The group costs
 * nothing and removes that trap in advance.
 */
export const EMOJI =
  /(?:[\u{1F000}-\u{1FAFF}\u{2460}-\u{24FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{E0020}-\u{E007F}]|\u{FE0F}|\u{20E3})/u;
/** Box drawing and block elements. */
export const BOX_DRAWING = /[\u{2500}-\u{259F}]/u;

/** A file of this many lines or more is subject to the ratio ceiling. */
export const RATIO_MIN_LINES = 200;
/** The ceiling, as a fraction of lines that are whole-line comments. */
export const RATIO_MAX = 0.3;
/**
 * Fewer files than this means the file set collapsed -- a wrong cwd, a broken
 * `git ls-files`, a widened exclusion -- and a zero-finding run is not a pass.
 */
export const MIN_FILES = 300;

export const floorOk = (measured: number) => measured >= MIN_FILES;

export type CommentPiece = {
  line: number;
  text: string;
  /** True when nothing but this comment is on the line. */
  whole: boolean;
};

/**
 * Comment pieces in a C-family source. String- and regex-aware: an emoji in a
 * string literal is content, not a comment, and flagging it would make the gate
 * fire on correct code.
 */
function scanCLike(src: string, allowLineComments: boolean): CommentPiece[] {
  const out: CommentPiece[] = [];
  let i = 0;
  let line = 1;
  let codeOnLine = false;
  const n = src.length;
  let prevSignificant = "";

  const push = (startLine: number, text: string, hadCode: boolean) => {
    out.push({ line: startLine, text, whole: !hadCode });
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "\n") {
      line++;
      codeOnLine = false;
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }

    if (allowLineComments && c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push(line, src.slice(i + 2, j).replace(/\r$/, ""), codeOnLine);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const body = src.slice(i + 2, Math.min(j, n));
      const startLine = line;
      const hadCode = codeOnLine;
      const parts = body.split("\n");
      for (let k = 0; k < parts.length; k++) {
        push(startLine + k, parts[k].replace(/\r$/, ""), k === 0 ? hadCode : false);
      }
      line = startLine + parts.length - 1;
      i = Math.min(j + 2, n);
      codeOnLine = true;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        if (src[j] === "\n") {
          if (quote === "`") line++;
          else break;
        }
        j++;
      }
      i = j + 1;
      codeOnLine = true;
      prevSignificant = quote;
      continue;
    }

    // A `/` after an operator or an opening bracket starts a regex literal,
    // not a division; without this a `/` inside one can read as a comment.
    if (c === "/" && allowLineComments && /^$|[(,=:[!&|?{};+\-*%~^]/.test(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        i = j + 1;
        codeOnLine = true;
        prevSignificant = "/";
        continue;
      }
    }

    if (!/\s/.test(c)) {
      codeOnLine = true;
      prevSignificant = c;
    }
    i++;
  }
  return out;
}

/** Comment pieces in a Lua source, string- and long-bracket-aware. */
function scanLua(src: string): CommentPiece[] {
  const out: CommentPiece[] = [];
  let i = 0;
  let line = 1;
  let codeOnLine = false;
  const n = src.length;

  const longBracket = (at: number) => {
    if (src[at] !== "[") return null;
    let k = at + 1;
    let eq = 0;
    while (src[k] === "=") {
      eq++;
      k++;
    }
    if (src[k] !== "[") return null;
    return { bodyStart: k + 1, close: `]${"=".repeat(eq)}]` };
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      codeOnLine = false;
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }

    if (c === "-" && src[i + 1] === "-") {
      const lb = longBracket(i + 2);
      if (lb) {
        const end = src.indexOf(lb.close, lb.bodyStart);
        const stop = end === -1 ? n : end;
        const body = src.slice(lb.bodyStart, stop);
        const startLine = line;
        const hadCode = codeOnLine;
        const parts = body.split("\n");
        for (let k = 0; k < parts.length; k++) {
          out.push({
            line: startLine + k,
            text: parts[k].replace(/\r$/, ""),
            whole: k === 0 ? !hadCode : true,
          });
        }
        line = startLine + parts.length - 1;
        i = end === -1 ? n : end + lb.close.length;
        codeOnLine = true;
        continue;
      }
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      out.push({ line, text: src.slice(i + 2, j).replace(/\r$/, ""), whole: !codeOnLine });
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote || src[j] === "\n") break;
        j++;
      }
      i = j + 1;
      codeOnLine = true;
      continue;
    }

    if (c === "[") {
      const lb = longBracket(i);
      if (lb) {
        const end = src.indexOf(lb.close, lb.bodyStart);
        const stop = end === -1 ? n : end;
        line += (src.slice(i, stop).match(/\n/g) || []).length;
        i = end === -1 ? n : end + lb.close.length;
        codeOnLine = true;
        continue;
      }
    }

    if (!/\s/.test(c)) codeOnLine = true;
    i++;
  }
  return out;
}

/** `#` line comments, string-aware. TOML has no block comment. */
function scanToml(src: string): CommentPiece[] {
  const out: CommentPiece[] = [];
  for (const [index, raw] of src.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "#") {
        out.push({
          line: index + 1,
          text: line.slice(i + 1),
          whole: line.slice(0, i).trim() === "",
        });
        break;
      }
    }
  }
  return out;
}

export function commentsOf(path: string, src: string): CommentPiece[] {
  if (path.endsWith(".lua")) return scanLua(src);
  if (path.endsWith(".css")) return scanCLike(src, false);
  if (path.endsWith(".toml")) return scanToml(src);
  return scanCLike(src, true);
}

export const isVendored = (src: string) =>
  VENDOR_MARKERS.some((m) => src.slice(0, 2000).includes(m));

function listFiles(): string[] {
  // Tracked plus not-yet-added files, minus anything gitignored: the set that
  // would be pushed, not just the set already committed.
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "buffer",
  });
  if (git.status !== 0) {
    console.error("comment-style-gate: `git ls-files` failed; the file set is unknown.");
    process.exit(2);
  }
  const names = git.stdout.toString("utf8").split("\0").filter(Boolean);
  return names.filter((rel) => {
    if (!EXTENSIONS.some((e) => rel.endsWith(e))) return false;
    const native = rel.split("/").join(sep);
    return !EXCLUDED_DIRS.some(
      (d) => native === d || native.startsWith(`${d}${sep}`) || native.includes(`${sep}${d}${sep}`)
    );
  });
}

export type Finding = { file: string; line: number; rule: string; detail: string };

/**
 * Files that were over the ceiling when the gate was introduced, each pinned at
 * the whole-line-comment count it had then.
 *
 * A ratchet, not an allowlist. A pinned file may only shrink, and the moment it
 * is at or under the ceiling the gate demands its entry be deleted -- so the
 * ledger cannot outlive the thing it describes, which is the failure mode a
 * sibling resource's `KNOWN_OPEN_FINDINGS` already demonstrated.
 */
export type Baseline = Record<string, number>;

export const BASELINE_PATH = join(import.meta.dirname, "comment-ratio-baseline.json");

export function loadBaseline(path = BASELINE_PATH): Baseline {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  for (const [file, count] of Object.entries(parsed)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(`${path}: ${file} is pinned to ${JSON.stringify(count)}, not a line count`);
    }
  }
  return parsed as Baseline;
}

export type Options = {
  /** Rules to disable, for the control's broken-gate drills. */
  skip?: string[];
  /** Measure these files instead of the pushable set. */
  files?: string[];
  root?: string;
  baseline?: Baseline;
};

export function run(opts: Options = {}) {
  const skip = new Set(opts.skip ?? []);
  const root = opts.root ?? ROOT;
  const files = opts.files ?? listFiles();
  const baseline = opts.baseline ?? {};
  const unseen = new Set(Object.keys(baseline));
  const findings: Finding[] = [];
  let totalLines = 0;
  let totalCommentLines = 0;
  let emojiCount = 0;
  let dividerCount = 0;
  const ratios: { file: string; lines: number; comments: number; ratio: number }[] = [];
  let measured = 0;

  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (isVendored(src)) continue;
    measured++;

    // A trailing newline is a terminator, not a line. Counting it put a
    // 199-line file over the 200-line threshold.
    const split = src.split("\n");
    const lines = split.length - (split.at(-1) === "" ? 1 : 0);
    const wholeLines = new Set<number>();
    for (const p of commentsOf(rel, src)) {
      if (p.whole && p.text.trim() !== "") wholeLines.add(p.line);

      const emoji = p.text.match(EMOJI);
      if (emoji) {
        emojiCount++;
        if (!skip.has("emoji")) {
          findings.push({
            file: rel,
            line: p.line,
            rule: "emoji",
            detail: `emoji ${JSON.stringify(emoji[0])} in a comment`,
          });
        }
      }

      const box = p.text.match(BOX_DRAWING);
      if (box) {
        dividerCount++;
        if (!skip.has("divider")) {
          findings.push({
            file: rel,
            line: p.line,
            rule: "divider",
            detail: `box-drawing character ${JSON.stringify(box[0])} in a comment`,
          });
        }
      }
    }

    totalLines += lines;
    totalCommentLines += wholeLines.size;
    const ratio = lines === 0 ? 0 : wholeLines.size / lines;
    ratios.push({ file: rel, lines, comments: wholeLines.size, ratio });

    if (skip.has("ratio") || RATIO_EXEMPT.some((e) => rel.endsWith(e))) continue;
    unseen.delete(rel);
    const pinned = baseline[rel];
    const over = lines >= RATIO_MIN_LINES && ratio > RATIO_MAX;

    if (pinned === undefined) {
      if (over) {
        findings.push({
          file: rel,
          line: 1,
          rule: "ratio",
          detail: `${wholeLines.size}/${lines} lines are whole-line comments (${(ratio * 100).toFixed(1)}%), over the ${(RATIO_MAX * 100).toFixed(0)}% ceiling for files of ${RATIO_MIN_LINES}+ lines`,
        });
      }
    } else if (!over) {
      findings.push({
        file: rel,
        line: 1,
        rule: "ratio-ratchet",
        detail: `now ${(ratio * 100).toFixed(1)}%, under the ceiling. Delete its entry from ${BASELINE_PATH.split(sep).pop()}`,
      });
    } else if (wholeLines.size > pinned) {
      findings.push({
        file: rel,
        line: 1,
        rule: "ratio-ratchet",
        detail: `pinned at ${pinned} whole-line comments, now ${wholeLines.size}. A pinned file may only shrink`,
      });
    }
  }

  if (!skip.has("ratio")) {
    for (const rel of unseen) {
      findings.push({
        file: rel,
        line: 1,
        rule: "ratio-ratchet",
        detail: `pinned in the baseline but not measured -- renamed, deleted or now excluded. Delete its entry`,
      });
    }
  }

  return {
    findings,
    stats: { files: measured, totalLines, totalCommentLines, emojiCount, dividerCount, ratios },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const statsOnly = argv.includes("--stats");
  const skip = argv.filter((a) => a.startsWith("--skip=")).flatMap((a) => a.slice(7).split(","));
  const writeBaseline = argv.includes("--write-baseline");

  if (writeBaseline) {
    const { stats } = run({});
    const pinned = Object.fromEntries(
      stats.ratios
        .filter((r) => r.lines >= RATIO_MIN_LINES && r.ratio > RATIO_MAX)
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((r) => [r.file, r.comments])
    );
    writeFileSync(BASELINE_PATH, `${JSON.stringify(pinned, null, 2)}\n`);
    console.log(`wrote ${Object.keys(pinned).length} pinned file(s) to ${BASELINE_PATH}`);
    process.exit(0);
  }

  const { findings, stats } = run({ skip, baseline: loadBaseline() });

  if (!floorOk(stats.files)) {
    console.error(
      `comment-style-gate: only ${stats.files} files measured, under the floor of ${MIN_FILES}. The file set collapsed; this is not a pass.`
    );
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify({ findings, stats }, null, 2));
    process.exit(statsOnly ? 0 : findings.length > 0 ? 1 : 0);
  }

  console.log(
    `comment-style-gate: ${stats.files} files, ${stats.totalLines} lines, ${stats.totalCommentLines} whole-line comments (${((stats.totalCommentLines / stats.totalLines) * 100).toFixed(1)}%)`
  );
  console.log(`  emoji in comments: ${stats.emojiCount}`);
  console.log(`  box-drawing dividers in comments: ${stats.dividerCount}`);

  if (statsOnly) {
    const worst = stats.ratios
      .filter((r) => r.lines >= RATIO_MIN_LINES)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 40);
    console.log(`\nworst comment ratios (files of ${RATIO_MIN_LINES}+ lines):`);
    for (const r of worst) {
      console.log(
        `  ${(r.ratio * 100).toFixed(1).padStart(5)}%  ${String(r.lines).padStart(5)}  ${r.file}`
      );
    }
    process.exit(0);
  }

  if (findings.length === 0) {
    console.log("OK");
    process.exit(0);
  }

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byRule.get(f.rule) ?? [];
    list.push(f);
    byRule.set(f.rule, list);
  }
  for (const [rule, list] of byRule) {
    console.error(`\n${rule}: ${list.length}`);
    for (const f of list.slice(0, 50)) console.error(`  ${f.file}:${f.line}  ${f.detail}`);
    if (list.length > 50) console.error(`  ... and ${list.length - 50} more`);
  }
  console.error("\nSee docs/CODE-STYLE.md.");
  process.exit(1);
}

if (import.meta.main) main();
