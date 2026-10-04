#!/usr/bin/env bun
/**
 * solid2-scan — counts the Solid 1 constructs left in `shared/ts`.
 *
 * Run from the repo root: `bun run scan:solid2`.
 *
 *   bun run scan:solid2                 # report
 *   bun run scan:solid2 --min 10        # fail unless at least 10 sites remain
 *   bun run scan:solid2 --expect-zero   # fail unless the tree is clean
 *   bun run scan:solid2 --root <dir>    # scan somewhere else (a consumer's src/)
 *
 * `--root` exists so the CONSUMERS of shared/ts are measured by this scanner and
 * not by a second one. A migration is per-repo but the rules are not: tUnit hit
 * `createEffect(on(...))`, the store path setter and `solid-js/web` exactly as
 * shared/ts did. A sibling copy would drift from the control fixture, and a rule
 * that has drifted reports zero — which reads as a finished migration.
 *
 * The control is read from THIS repo either way, so pointing `--root` elsewhere
 * cannot weaken it: the fixture never moves and all 7 rules must still trip on it.
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
const CONTROL = join(REPO, "scripts", "solid2-scan-control.fixture.tsx");

const argRoot = process.argv.indexOf("--root");
if (argRoot !== -1 && !process.argv[argRoot + 1]) {
  console.error("--root needs a directory");
  process.exit(3);
}
/** Resolved against the CWD, not this repo, so a consumer can pass a relative path. */
const SCAN_ROOT =
  argRoot === -1 ? join(REPO, "shared", "ts") : resolve(process.cwd(), process.argv[argRoot + 1]!);
if (!statSync(SCAN_ROOT, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`scan root is not a directory: ${SCAN_ROOT}`);
  process.exit(3);
}

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

/** Original (un-blanked) source per file, so a finding reports the real line. */
const ORIGINAL = new Map<string, string>();

function hit(rule: string, file: string, src: string, index: number): Finding {
  const line = lineOf(src, index);
  const original = ORIGINAL.get(file) ?? src;
  const text = (original.split("\n")[line - 1] ?? textOf(src, index)).trim();
  return { rule, file, line, text: text.slice(0, 140) };
}

/**
 * Types that `solid-js` no longer owns: the renderer package does.
 *
 * `JSX` is simply gone from core — core models a renderer-neutral `Element` and
 * `@solidjs/web` owns the JSX namespace. `ValidComponent` is the nastier one,
 * because BOTH packages export that name and the core one still resolves: core's
 * is `Component<any>` (function components only) while the web one admits a tag
 * name, so a polymorphic `as="a"` typechecks against the web flavour alone.
 */
const MOVED_TO_SOLIDJS_WEB = ["JSX", "ValidComponent"];

/** `import ... from "<spec>"` with the binding list captured. Multi-line safe. */
const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/**
 * Blanks out comment bodies, keeping every byte position and newline.
 *
 * Needed because a migration leaves prose BEHIND that names the old API —
 * "`createEffect(on(src, fn))` folds to `createEffect(src, fn)`" is the
 * explanation of a finished change, not a finding. Without this the scanner can
 * never reach zero without the comments being reworded to avoid it, which is
 * exactly backwards: the note is the valuable part.
 *
 * It is a small state machine rather than a regex because a naive `//` strip eats
 * the `//` in a URL inside a string literal, and that silently removes real code
 * from the rest of the line.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? src.length : j + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n" && c !== "`") break;
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Named bindings of an import match, with any inline `type` modifier stripped. */
function bindingsOf(m: RegExpMatchArray): string[] {
  return (m[2] ?? "")
    .split(",")
    .map((s) =>
      s
        .replace(/\btype\b/, "")
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
    )
    .filter(Boolean) as string[];
}

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
    id: "solid1-type-moved",
    run(src, file) {
      const out: Finding[] = [];
      for (const m of src.matchAll(IMPORT_RE)) {
        if (m[3] !== "solid-js") continue;
        for (const n of bindingsOf(m)) {
          if (MOVED_TO_SOLIDJS_WEB.includes(n)) {
            out.push(hit(`solid1-type-moved:${n}`, file, src, m.index ?? 0));
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
ORIGINAL.set(CONTROL, controlSrc);
const controlFindings = scan([{ file: CONTROL, src: stripComments(controlSrc) }]);
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

const files = walk(SCAN_ROOT).map((file) => {
  const src = readFileSync(file, "utf8");
  ORIGINAL.set(file, src);
  // Rules run over comment-blanked source; see stripComments.
  return { file, src: stripComments(src) };
});
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
