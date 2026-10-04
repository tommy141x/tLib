#!/usr/bin/env bun
/**
 * solid2-scan — counts the Solid 1 constructs left in `shared/ts`.
 *
 * Run from the repo root: `bun run scan:solid2`.
 *
 *   bun run scan:solid2                 # report
 *   bun run scan:solid2 --min 10        # fail unless at least 10 sites remain
 *   bun run scan:solid2 --expect-zero   # fail unless the tree is clean
 *
 * THE CONTROL IS THE POINT. Every rule below is also run against
 * `scripts/solid2-scan-control.fixture.tsx`, a file that is deliberately still
 * written in Solid 1. If a rule stops matching there, the whole run fails —
 * even if the real tree reports clean. Without that, a pattern that silently
 * drifted (a renamed import, a reformatted call) reports zero findings, and
 * zero findings reads exactly like "the migration is finished".
 *
 * Exit codes: 0 pass, 1 an assertion failed, 2 the control broke, 3 bad usage.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCAN_ROOT = join(REPO, "shared", "ts");
const CONTROL = join(REPO, "scripts", "solid2-scan-control.fixture.tsx");

/** Not ours: `solid-compat/` is a vendor-import shim a peer owns, and it is
 *  REQUIRED to keep naming the Solid 1 surface. Scanning it would be noise. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "solid-compat"]);

/** Removed from the `solid-js` entrypoint in Solid 2. */
const REMOVED_FROM_SOLID_JS = [
  "onMount",
  "mergeProps",
  "splitProps",
  "Index",
  "on",
  "ErrorBoundary",
  "Suspense",
  "SuspenseList",
];

type Finding = { rule: string; file: string; line: number; text: string };
type Rule = { id: string; run: (src: string, file: string) => Finding[] };

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;
const textOf = (src: string, index: number) =>
  (src.split("\n")[lineOf(src, index) - 1] ?? "").trim();

function hit(rule: string, file: string, src: string, index: number): Finding {
  return { rule, file, line: lineOf(src, index), text: textOf(src, index).slice(0, 140) };
}

/** `import ... from "<spec>"` with the binding list captured. Multi-line safe. */
const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

const RULES: Rule[] = [
  {
    id: "solid1-import-removed",
    run(src, file) {
      const out: Finding[] = [];
      for (const m of src.matchAll(IMPORT_RE)) {
        if (m[3] !== "solid-js") continue;
        // `import type { ... }` is types only; those still live in solid-js.
        if (m[1]) continue;
        const names = m[2]
          .split(",")
          .map((s) =>
            s
              .replace(/\btype\b/, "")
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim()
          )
          .filter(Boolean) as string[];
        for (const n of names) {
          if (REMOVED_FROM_SOLID_JS.includes(n)) {
            out.push(hit(`solid1-import-removed:${n}`, file, src, m.index ?? 0));
          }
        }
      }
      return out;
    },
  },
  {
    id: "solid1-web-import",
    run(src, file) {
      const out: Finding[] = [];
      for (const m of src.matchAll(/from\s*["']solid-js\/web["']/g)) {
        out.push(hit("solid1-web-import", file, src, m.index ?? 0));
      }
      return out;
    },
  },
  {
    id: "solid1-store-import",
    run(src, file) {
      const out: Finding[] = [];
      for (const m of src.matchAll(/from\s*["']solid-js\/store["']/g)) {
        out.push(hit("solid1-store-import", file, src, m.index ?? 0));
      }
      return out;
    },
  },
  {
    id: "createEffect-on",
    run(src, file) {
      const out: Finding[] = [];
      // `createEffect(on(...))` — the Solid 1 explicit-dependency wrapper.
      // Allows whitespace/newline between the two, which is how biome wraps it.
      for (const m of src.matchAll(/createEffect\s*\(\s*on\s*\(/g)) {
        out.push(hit("createEffect-on", file, src, m.index ?? 0));
      }
      return out;
    },
  },
  {
    id: "cleanup-in-mount",
    run(src, file) {
      const out: Finding[] = [];
      // Brace-match the onMount callback and look for onCleanup inside it.
      for (const m of src.matchAll(/onMount\s*\(\s*\(\s*\)\s*=>\s*\{/g)) {
        const start = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let end = start;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (src.slice(start, end).includes("onCleanup(")) {
          out.push(hit("cleanup-in-mount", file, src, m.index ?? 0));
        }
      }
      return out;
    },
  },
];

/**
 * The store-setter rule is cross-file: it learns the setter identifiers from
 * every `createStore` destructure in the tree first, then flags path-form and
 * merge-form calls to those identifiers anywhere. A single-file regex would
 * miss `setPropEditorState("propData", …)` in the viewport, which imports it.
 */
function storeSetterRule(files: { file: string; src: string }[]): Finding[] {
  const setters = new Set<string>();
  for (const { src } of files) {
    for (const m of src.matchAll(/\[\s*\w+\s*,\s*(\w+)\s*\]\s*=\s*createStore\b/g)) {
      if (m[1]) setters.add(m[1]);
    }
  }
  if (setters.size === 0) return [];
  const out: Finding[] = [];
  const re = new RegExp(`\\b(${[...setters].join("|")})\\s*\\(\\s*["'{]`, "g");
  for (const { file, src } of files) {
    for (const m of src.matchAll(re)) out.push(hit("store-path-setter", file, src, m.index ?? 0));
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(p)) acc.push(p);
  }
  return acc;
}

function scan(files: { file: string; src: string }[]): Finding[] {
  const out: Finding[] = [];
  for (const { file, src } of files) for (const r of RULES) out.push(...r.run(src, file));
  out.push(...storeSetterRule(files));
  return out;
}

// ---------------------------------------------------------------- the control

const controlSrc = readFileSync(CONTROL, "utf8");
const controlFindings = scan([{ file: CONTROL, src: controlSrc }]);
const controlRules = new Set(controlFindings.map((f) => f.rule.split(":")[0]));
const EXPECTED_IN_CONTROL = [...RULES.map((r) => r.id), "store-path-setter"];
const deadRules = EXPECTED_IN_CONTROL.filter((id) => !controlRules.has(id));

console.log(
  `control: ${controlFindings.length} findings across ${controlRules.size}/${EXPECTED_IN_CONTROL.length} rules`
);
if (deadRules.length > 0) {
  console.error(
    `CONTROL BROKEN — these rules no longer match the deliberately-Solid-1 fixture: ${deadRules.join(", ")}`
  );
  console.error(`fixture: ${CONTROL}`);
  console.error(
    "A zero from this scanner is therefore meaningless. Fix the rule, not the fixture."
  );
  process.exit(2);
}

// ----------------------------------------------------------------- the scan

const files = walk(SCAN_ROOT).map((file) => ({ file, src: readFileSync(file, "utf8") }));
const findings = scan(files);

const byRule = new Map<string, number>();
for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

console.log(`\nscan root: ${relative(REPO, SCAN_ROOT)}  (${files.length} .ts/.tsx files)`);
for (const [rule, n] of [...byRule].sort()) console.log(`  ${String(n).padStart(3)}  ${rule}`);
console.log(`total: ${findings.length}`);

if (process.argv.includes("--list")) {
  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${relative(REPO, f.file)}:${f.line}  [${f.rule}]  ${f.text}`);
  }
}

// ------------------------------------------------------------- the assertions

const argMin = process.argv.indexOf("--min");
if (argMin !== -1) {
  const min = Number(process.argv[argMin + 1]);
  if (!Number.isFinite(min)) {
    console.error("--min needs a number");
    process.exit(3);
  }
  if (findings.length < min) {
    console.error(`FLOOR FAILED: expected at least ${min} sites, found ${findings.length}.`);
    process.exit(1);
  }
  console.log(`floor ok: ${findings.length} >= ${min}`);
}

if (process.argv.includes("--expect-zero")) {
  if (findings.length !== 0) {
    console.error(`EXPECTED ZERO: ${findings.length} sites remain (re-run with --list).`);
    process.exit(1);
  }
  console.log("clean: 0 sites, and the control still trips every rule.");
}
