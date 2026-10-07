#!/usr/bin/env bun
/**
 * A gate over a bundle's BUILT output, asserting it is parseable by CEF 103.
 *
 * ## Why this exists, and why it is not a visual check
 *
 * FiveM's NUI is CEF `103.0.0-cfx-m103.2605+g1316dae+chromium-103.0.5060.141`,
 * i.e. **Chromium 103** (June 2022). Four things this estate relies on landed
 * AFTER it, and every one of them fails SILENTLY — no error, no warning, no
 * console line, just a declaration or a whole at-rule that Blink discards:
 *
 *   - `oklch()` and `color-mix()`        Chromium 111
 *   - `:has()`                           Chromium 105
 *   - Media Queries Level 4 range syntax Chromium 104
 *     (`@media (width>=1024px)` for `@media (min-width: 1024px)`)
 *
 * Both of those have already cost this estate real damage, and both were
 * invisible in a browser:
 *
 *   1. `presetWind4` compiles every colour utility to
 *      `color-mix(in oklab, <colour> var(--un-*-opacity), transparent)` and ships
 *      its palette as `oklch()` literals. MEASURED on a sibling bundle: 348
 *      colour-mixes and 211 oklch values dropped in game — the panel rendered
 *      geometry-correct and COLOURLESS. Both FiveM frontends are pinned to
 *      `presetWind3` (via `tPreset({ target: "nui" })`) for exactly this reason.
 *   2. `target: "esnext"` tells esbuild/oxc every feature is available, so it is
 *      free to UPGRADE syntax on the way out. It does, and CSS is where it bites:
 *      `@media (min-width: 1024px)` is rewritten to the Level 4 range form, which
 *      CEF cannot parse, so it serialises the whole query to `@media not all` — a
 *      condition that never matches. MEASURED on tRadio's dispatch panel: every
 *      `sm:`/`md:`/`lg:`/`xl:` utility in both panels was dead, which is why the
 *      marketplace grid computed to a single 1290px column instead of three.
 *
 * ⛔ A GREEN RESULT IN A MODERN HEADLESS CHROME SAYS NOTHING ABOUT ANY OF THIS.
 * That is the whole problem: current Chrome renders all four correctly, so a
 * visual A/B, a screenshot diff and a Lighthouse run are all blind to it. This
 * gate reads the shipped bytes instead, which is deterministic, needs no browser,
 * and is immune to machine load.
 *
 * tLib DOES ship a real Chromium 103 harness (`nui-chromium.ts`), and a visual
 * check there is strictly better EVIDENCE. It is not better as a GATE: it costs a
 * 190 MB download, a browser launch and a render per run, and it can only see the
 * rules the one page it loads happens to use. A text contract over the whole
 * stylesheet sees every rule in it, including the ones belonging to a route
 * nobody screenshotted.
 *
 * ## The two floors, and why the gate is useless without them
 *
 * ⛔ "No Level 4 media queries" and "no media queries at all" are
 * indistinguishable from the outside, and so are "no oklch" and "no CSS". A gate
 * that only ever looks for bad strings passes PERFECTLY on an empty file — which
 * is the exact shape of failure that matters here, because an UnoCSS scan that
 * silently stops matching produces a tiny stylesheet and no error.
 *
 * So `R-MEDIA-FLOOR` requires at least one LEGACY `min-width`/`max-width` query
 * to be present, and `R-SIZE-FLOOR` requires the sheet to clear a byte floor.
 * Both are witnesses in the sense of the web-perf playbook §1.5: they can only be
 * produced by the thing under test actually having run.
 *
 * ## Scope: what this does NOT check, deliberately
 *
 * - **JS syntax.** Every syntactic feature a bundler would emit at `esnext` is
 *   older than Chromium 103 (private fields 84, logical assignment 85, top-level
 *   await 89, class static blocks 94). The post-103 additions are LIBRARY methods
 *   (`Array.prototype.toSorted` 110, `Object.groupBy` 117), which a target change
 *   does not introduce — they can only arrive from source, where a type-checker
 *   sees them. Asserting on JS here would be a check with no measured failure
 *   behind it, so there is none.
 * - **Blurred shadows and `backdrop-filter`.** CEF composites neither usefully,
 *   and `NUI_BLOCKLIST` in `uno-preset.ts` already bans the utility families;
 *   `findBlurredShadows` in `css-contract.ts` already gates the hand-written half.
 *   tRadio's dispatch panel is the estate's one dual home and sets
 *   `nuiElevationException: true` with the argument written out, so these are
 *   EXPECTED in its output. They are reported as an informational count here and
 *   never fail the gate — a second rule answering the same question a different
 *   way is how a legitimate carve-out turns into a gate everyone learns to skip.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CefFinding {
  /** Stable rule id, so a control can assert WHICH rule fired. */
  rule: string;
  file: string;
  /** 1-based line, or 0 when the finding is about the file as a whole. */
  line: number;
  detail: string;
}

export interface CefContractOptions {
  /** Build output directory to scan (the Vite `build.outDir`). */
  dist: string;
  /**
   * Minimum total CSS bytes. A real bundle here ships 29 KB (client/web) to
   * 77 KB (server/web); 2 KB is a floor against a collapsed scan, not a budget.
   */
  minCssBytes?: number;
  /** Rule ids to skip. Each needs a written reason at the call site. */
  skip?: string[];
}

/**
 * Patterns that must not appear in shipped CSS.
 *
 * Each is matched against the raw stylesheet text. They are written against
 * MINIFIED output — the sheets are one long line — so nothing may rely on
 * newlines or on whitespace around a token.
 */
const FORBIDDEN: Array<{ rule: string; re: RegExp; detail: string }> = [
  {
    rule: "R-OKLCH",
    // `oklch(` as a colour function. Also catches it inside `color-mix`.
    re: /\boklch\s*\(/gi,
    detail: "oklch() is Chromium 111; CEF 103 drops the whole declaration",
  },
  {
    rule: "R-COLOR-MIX",
    re: /\bcolor-mix\s*\(/gi,
    detail: "color-mix() is Chromium 111; CEF 103 drops the whole declaration",
  },
  {
    rule: "R-OKLAB",
    re: /\boklab\s*\(/gi,
    detail: "oklab() is Chromium 111; CEF 103 drops the whole declaration",
  },
  {
    rule: "R-HAS",
    re: /:has\s*\(/gi,
    detail: ":has() is Chromium 105; CEF 103 drops the whole rule",
  },
  {
    rule: "R-MQ4-RANGE",
    // Media Queries Level 4 range syntax inside a media/container condition:
    // `(width>=1024px)`, `(width >= 1024px)`, `(400px<=width<=700px)`.
    // Requires a comparison operator directly against a `width`/`height`
    // feature name, which the legacy `min-width:`/`max-width:` form never has.
    re: /\(\s*[^)]*\b(?:min-|max-)?(?:width|height|aspect-ratio)\s*[<>]=?[^)]*\)/gi,
    detail:
      "Media Queries Level 4 range syntax is Chromium 104; CEF 103 serialises the " +
      "whole query to `@media not all`, which never matches. Pin build.cssTarget to chrome103.",
  },
];

/** Legacy media-feature form, which is the witness that media queries survived. */
const LEGACY_MQ = /\(\s*(?:min|max)-(?:width|height|aspect-ratio)\s*:/gi;

/** Informational only — see the scope note in the module docstring. */
const ELEVATION = /\bbackdrop-filter\s*:|\bblur\s*\(/gi;

function cssFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

/** 1-based line number of a byte offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export interface CefContractResult {
  findings: CefFinding[];
  /** Files scanned, for the report — an empty list is itself a failure. */
  files: string[];
  totalCssBytes: number;
  legacyMediaQueries: number;
  elevationDeclarations: number;
}

export function checkCefOutput(options: CefContractOptions): CefContractResult {
  const { dist, minCssBytes = 2048, skip = [] } = options;
  const files = cssFiles(dist);
  const findings: CefFinding[] = [];
  let totalCssBytes = 0;
  let legacyMediaQueries = 0;
  let elevationDeclarations = 0;

  if (!existsSync(dist)) {
    findings.push({
      rule: "R-NO-DIST",
      file: dist,
      line: 0,
      detail: "build output directory does not exist — run the build first",
    });
    return { findings, files, totalCssBytes, legacyMediaQueries, elevationDeclarations };
  }

  for (const file of files) {
    const css = readFileSync(file, "utf8");
    totalCssBytes += statSync(file).size;
    legacyMediaQueries += [...css.matchAll(LEGACY_MQ)].length;
    elevationDeclarations += [...css.matchAll(ELEVATION)].length;

    for (const { rule, re, detail } of FORBIDDEN) {
      if (skip.includes(rule)) continue;
      for (const m of css.matchAll(re)) {
        findings.push({
          rule,
          file,
          line: lineOf(css, m.index ?? 0),
          detail: `${detail} — found ${JSON.stringify(m[0].slice(0, 80))}`,
        });
      }
    }
  }

  // ── The floors. See the module docstring: without these the gate passes on an
  // empty directory, which is the failure shape that actually happens here.
  if (files.length === 0 && !skip.includes("R-SIZE-FLOOR")) {
    findings.push({
      rule: "R-SIZE-FLOOR",
      file: dist,
      line: 0,
      detail: "no .css files in the build output at all — the gate would pass vacuously",
    });
  } else if (totalCssBytes < minCssBytes && !skip.includes("R-SIZE-FLOOR")) {
    findings.push({
      rule: "R-SIZE-FLOOR",
      file: dist,
      line: 0,
      detail:
        `shipped CSS is ${totalCssBytes} B, below the ${minCssBytes} B floor — ` +
        "a collapsed UnoCSS scan produces a tiny sheet and no error, and would pass every rule above",
    });
  }

  if (legacyMediaQueries === 0 && !skip.includes("R-MEDIA-FLOOR")) {
    findings.push({
      rule: "R-MEDIA-FLOOR",
      file: dist,
      line: 0,
      detail:
        "not one legacy `min-width:`/`max-width:` media query in the shipped CSS. " +
        "R-MQ4-RANGE cannot distinguish `no Level 4 syntax` from `no media queries`, " +
        "so this floor is what makes that rule mean anything.",
    });
  }

  return { findings, files, totalCssBytes, legacyMediaQueries, elevationDeclarations };
}

export function formatCefResult(r: CefContractResult, dist: string): string {
  const lines: string[] = [];
  lines.push(
    `check:cef — ${r.files.length} stylesheet(s), ${r.totalCssBytes} B, ` +
      `${r.legacyMediaQueries} legacy media quer${r.legacyMediaQueries === 1 ? "y" : "ies"}, ` +
      `${r.elevationDeclarations} elevation declaration(s) (informational)`
  );
  if (r.findings.length === 0) {
    lines.push(`  OK — ${dist} is parseable by CEF 103.`);
    return lines.join("\n");
  }
  const byRule = new Map<string, CefFinding[]>();
  for (const f of r.findings) {
    const list = byRule.get(f.rule) ?? [];
    list.push(f);
    byRule.set(f.rule, list);
  }
  for (const [rule, list] of byRule) {
    lines.push(`\n  ${rule} — ${list.length} finding(s)`);
    lines.push(`    ${list[0].detail}`);
    for (const f of list.slice(0, 8)) lines.push(`      ${f.file}:${f.line}`);
    if (list.length > 8) lines.push(`      ... and ${list.length - 8} more`);
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Run by path so this needs no `package.json` entry to be usable:
//   bun <this file> --dist <build output dir> [--min-css-bytes N] [--skip RULE,RULE]

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dist = flag("--dist");
  if (!dist) {
    console.error(
      "usage: bun cef-output-contract.ts --dist <build output dir> [--min-css-bytes N] [--skip R-X,R-Y]"
    );
    process.exit(2);
  }
  const result = checkCefOutput({
    dist,
    minCssBytes: flag("--min-css-bytes") ? Number(flag("--min-css-bytes")) : undefined,
    skip: flag("--skip")?.split(",").filter(Boolean),
  });
  const report = formatCefResult(result, dist);
  if (result.findings.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}
