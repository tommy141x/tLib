#!/usr/bin/env bun
/**
 * boolean-attr-selector-scan — finds CSS/UnoCSS selectors that Solid 2's
 * attribute serialisation turned into dead rules.
 *
 * Run from the repo root: `bun run check:boolattr`.
 *
 *   bun run check:boolattr                  # report + assert
 *   bun run check:boolattr --list           # every site, with its verdict
 *   bun run check:boolattr --strict         # also fail on `unknown` / `never-emitted`
 *   bun run check:boolattr --root <dir>     # scan a consumer instead
 *
 * THE DEFECT
 *
 * `@solidjs/web/dist/web.js`:
 *
 *     function setAttribute(node, name, value) {
 *       if (value == null || value === false) node.removeAttribute(name);
 *       else node.setAttribute(name, value === true ? "" : value);
 *     }
 *
 * Solid 2 writes a boolean `true` as the EMPTY STRING and REMOVES the attribute
 * on `false`. Solid 1 stringified both ("true" / "false"). So every selector
 * written as `[data-x="true"]`, where `data-x` is bound in JSX to a boolean,
 * went dead in the migration — and `[data-x="false"]` went dead too, because
 * there is no longer any "false" value to match. No error, no warning, no build
 * failure: the base rule simply wins.
 *
 * WHY THE CONTROL IS THE POINT
 *
 * Every rule below is also run against `boolean-attr-selector-control.fixture.tsx`,
 * a file written to be wrong on purpose. If a rule stops matching there the whole
 * run exits 2 — even when the real tree reports clean.
 *
 * The control is always read from THIS repo, so `--root` cannot weaken it.
 *
 * WHAT IS AND IS NOT A FINDING
 *
 * The scanner does not flag a selector for its shape. It resolves how the
 * attribute is actually PRODUCED in the same project first:
 *
 *   boolean   `data-x={a && b}`                       -> DEAD. Finding, fails.
 *   string    `data-x={open() ? "true" : undefined}`  -> correct. Not a finding.
 *             `data-x={String(moving())}`                Do not "normalise" it.
 *   dataset   `el.dataset.x = "true"`                 -> correct, a real string.
 *   static    `<div data-x="true">` in .html          -> correct, a real string.
 *   unknown   `data-x={props["data-x"]}`              -> cannot be proven here.
 *   absent    nothing emits the attribute at all      -> the rule is dead for an
 *                                                        unrelated reason.
 *
 * `unknown` and `never-emitted` are REPORTED but do not fail without `--strict`,
 * because turning an "I cannot prove this" into a hard failure is how a gate
 * gets routed around. A selector nobody emits is a finding to read, not a
 * selector to quietly rewrite until it matches something that was never there.
 *
 * aria is deliberately treated the same way but is almost never a finding:
 * `aria-expanded="true"` is a real string value in the ARIA spec and is normally
 * passed as one. It is only flagged when the JSX hands it a RAW boolean, which
 * writes `aria-x=""` — invalid ARIA, and dead against any `="true"` selector.
 *
 * SOLID 1 ROOTS
 *
 * Under Solid 1 the same site is CORRECT: `data-x={bool}` stringified. Scanning
 * a Solid 1 root therefore reports its findings as `latent` and does not fail.
 * They are not bugs today; they are the list of what breaks the day that project
 * is migrated. This project's own version is read from the package.json files
 * under the root, so nothing has to be passed in.
 *
 * AND DO NOT PRE-EMPTIVELY APPLY THE FIX THERE. Presence is exact under Solid
 * 2 only because `false` REMOVES the attribute. Solid 1 writes `data-x="false"`,
 * which IS present — so `[data-x]` in a Solid 1 project matches the false state
 * too, and converting early inverts the rule instead of future-proofing it. The
 * `latent` list is to be worked through as part of each migration, not before.
 *
 * Exit codes: 0 pass, 1 a dead selector exists, 2 the control broke, 3 bad usage.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const CONTROL = join(REPO, "scripts", "boolean-attr-selector-control.fixture.tsx");

const argRoot = process.argv.indexOf("--root");
if (argRoot !== -1 && !process.argv[argRoot + 1]) {
  console.error("--root needs a directory");
  process.exit(3);
}
const SCAN_ROOT = argRoot === -1 ? REPO : resolve(process.cwd(), process.argv[argRoot + 1]!);
if (!statSync(SCAN_ROOT, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`scan root is not a directory: ${SCAN_ROOT}`);
  process.exit(3);
}
const STRICT = process.argv.includes("--strict");

/**
 * `backups/` and the built `assets/` hold frozen copies of the pre-migration
 * tree and minified CSS; both are full of exactly this pattern and neither is
 * editable source. `solid-compat/` documents the Solid 1 surface on purpose.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "backups", "assets", "solid-compat"]);
/**
 * Every dot-directory, which is ripgrep's default and the right call here:
 * build output, and the pre-migration trees a consumer keeps in one.
 */
const skipDir = (name: string) => SKIP_DIRS.has(name) || name.startsWith(".");
const SCAN_EXT = /\.(css|scss|html|tsx?|jsx?|mdx)$/;
/** This scanner's own source quotes the defect verbatim, in prose and in regex
 *  literals that comment-blanking cannot reach. It is not a selector site. */
const SELF = resolve(import.meta.path);

/**
 * Blanks comment bodies, preserving every byte position and newline.
 *
 * Needed because the FIX for this defect is a comment explaining why the
 * selector is now presence-based — and that comment quotes `[data-x="true"]`.
 * Without this, nui.css's own write-up of the bug reports as the bug, and the
 * only way to a green run is to delete the explanation, which is backwards.
 *
 * Handles `//`, `/* *\/` and `<!-- -->`, and skips string literals so the `//`
 * in a URL inside a string does not eat the rest of the line.
 */
function stripComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++)
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? src.length : j + 2;
      blank(i, end);
      i = end;
    } else if (c === "<" && src.startsWith("<!--", i)) {
      const j = src.indexOf("-->", i + 4);
      const end = j === -1 ? src.length : j + 3;
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

// ----------------------------------------------------------------- selectors

/** `[data-x="true"]`, `[data-x=true]`, `[aria-x='false']`. */
const SELECTOR_RE =
  /\[\s*(data|aria)-([a-zA-Z0-9-]+)\s*=\s*(?:"(true|false)"|'(true|false)'|(true|false))\s*\]/g;
/** UnoCSS variants, including the group/peer-prefixed forms: `peer-data-[active=true]/menu-button:`. */
const VARIANT_RE =
  /(data|aria)-\[([a-zA-Z0-9-]+)=(?:"(true|false)"|'(true|false)'|(true|false))\]/g;

type Site = {
  file: string;
  line: number;
  attr: string;
  ns: "data" | "aria";
  value: string;
  kind: "selector" | "variant";
  text: string;
  /** Renderer of the file the SELECTOR lives in; see `preferRenderer` below. */
  renderer: "solid" | "react";
};

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;
const lineText = (src: string, line: number) =>
  (src.split("\n")[line - 1] ?? "").trim().slice(0, 160);

/** `src` is comment-blanked; `original` is only used to print the real line. */
function selectorSites(file: string, src: string, original: string): Site[] {
  const out: Site[] = [];
  const renderer = rendererOf(file, original);
  const push = (kind: Site["kind"], m: RegExpMatchArray) => {
    const value = m[3] ?? m[4] ?? m[5]!;
    const line = lineOf(src, m.index ?? 0);
    out.push({
      file,
      line,
      ns: m[1] as "data" | "aria",
      attr: `${m[1]}-${m[2]}`,
      value,
      kind,
      text: lineText(original, line),
      renderer,
    });
  };
  for (const m of src.matchAll(SELECTOR_RE)) push("selector", m);
  for (const m of src.matchAll(VARIANT_RE)) push("variant", m);
  return out;
}

// ------------------------------------------------------------------ producers

type Binding = {
  file: string;
  line: number;
  expr: string;
  verdict: "boolean" | "string" | "unknown";
  renderer: "solid" | "react";
  fromTest: boolean;
};

/**
 * REACT IS NOT AFFECTED. React stringifies a boolean `data-*`/`aria-*` value
 * to "true"/"false", so `[data-x="true"]` beside `data-x={bool}` is CORRECT in a
 * React file and must not be touched. shark-ui ships a `registry/react` and a
 * `registry/solid` side by side, with the same component in both — without this,
 * the React copies report as the defect and the "fix" breaks working code.
 */
function rendererOf(file: string, src: string): "solid" | "react" {
  if (/from\s*["']react(?:["']|\/)/.test(src)) return "react";
  if (/["']react\/jsx-/.test(src)) return "react";
  if (/[\\/]react[\\/]/.test(file)) return "react";
  return "solid";
}

/**
 * A test or a fixture renders shapes the app never renders. `solid-2-aria-attributes.test.tsx`
 * deliberately passes `asBool(false)` to `aria-invalid` to PROVE the Solid 2
 * behaviour — and that one line made tWeb's entirely-correct `aria-[invalid=true]:`
 * variant report dead. Tests are still scanned for SELECTORS (tLib's own browser
 * test was the one real finding in this sweep); they are only disregarded as
 * evidence of what the app emits.
 */
const isTestFile = (file: string) =>
  /\.(?:test|spec)\.[jt]sx?$/.test(file) ||
  /[\\/](?:__tests__|__fixtures__|fixtures)[\\/]/.test(file) ||
  /\.fixture\.[jt]sx?$/.test(file);

/** Reads an expression from `{` to its matching `}`, paren/bracket/brace aware. */
function braceSlice(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Reads an object-property value: from `:` to the top-level `,` or closing `}`. */
function propSlice(src: string, colon: number): string {
  let depth = 0;
  for (let i = colon + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") {
      if (depth === 0) return src.slice(colon + 1, i);
      depth--;
    } else if (ch === "," && depth === 0) return src.slice(colon + 1, i);
  }
  return src.slice(colon + 1);
}

/**
 * Classifies the bound expression.
 *
 * STRING is checked FIRST and wins, because the correct forms all mention a
 * boolean somewhere: `open() ? "true" : "false"` reads as boolean to any
 * operator test, and `props.error ? ("true" as const) : ("false" as const)` has
 * the ternary too. What makes a site correct is that the VALUE reaching the DOM
 * is a string, not that the condition is not a boolean.
 */
function classify(expr: string): Binding["verdict"] {
  // `?.` and `??` are masked out first. Both start with the character a ternary
  // starts with, and Dialog.tsx's
  // `hasLabelledSibling() && LABELLESS.has(field()?.type ?? "")` was read as a
  // string ternary — the `??` plus its `""` default — so the exact site this
  // scanner exists for came back `correct`. Measured against the real tree,
  // twice: masking only `?.` was not enough.
  const e = expr.trim().replace(/\?\?/g, "@@").replace(/\?\./g, "@.");
  if (e === "") return "unknown";
  // A string literal anywhere in the value position, a template, or an explicit
  // stringify: whatever the condition is, the DOM gets a string.
  if (/^\s*["'`]/.test(e)) return "string";
  if (/\bString\s*\(/.test(e)) return "string";
  if (/["'](?:true|false)["']/.test(e)) return "string";
  // `cond ? "a" : "b"` with non-boolean strings, e.g. `data-state`. A real
  // ternary has a `:`, which is what separates it from the masked operators.
  //
  // A template literal counts only HERE and in the leading-quote test above —
  // i.e. only in a value position. A bare "contains a backtick" rule read
  // shark-ui's `item.url === `#${activeHeading}`` as string-valued, which is a
  // COMPARISON against a template and produces a boolean. It reached the right
  // verdict by luck, via a different route than the one that is true, and the
  // next expression of that shape would not have been so lucky.
  if (/\?[\s\S]*:[\s\S]*["'`]/.test(e)) return "string";
  // Provably boolean: an operator or literal that can only produce one.
  if (/(?:^|[^=!<>])!(?!=)/.test(e)) return "boolean";
  if (/===|!==|&&|\|\||[<>]=?[^=]/.test(e)) return "boolean";
  if (/\b(?:true|false)\b/.test(e)) return "boolean";
  if (/\bBoolean\s*\(/.test(e)) return "boolean";
  if (/\.(?:has|includes)\s*\(/.test(e)) return "boolean";
  return "unknown";
}

const camel = (attr: string) =>
  attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());

type Producers = {
  /** attr -> JSX/object bindings found for it. */
  bound: Map<string, Binding[]>;
  /** attrs written imperatively or present as real markup — always real strings. */
  literal: Set<string>;
};

function collectProducers(files: { file: string; src: string }[]): Producers {
  const bound = new Map<string, Binding[]>();
  const literal = new Set<string>();
  const add = (attr: string, b: Binding) => {
    const list = bound.get(attr) ?? [];
    list.push(b);
    bound.set(attr, list);
  };
  for (const { file, src } of files) {
    const renderer = rendererOf(file, src);
    const fromTest = isTestFile(file);
    // JSX: `data-x={expr}` / `aria-x={expr}`
    for (const m of src.matchAll(/\b(data|aria)-([a-zA-Z0-9-]+)\s*=\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const expr = braceSlice(src, open);
      add(`${m[1]}-${m[2]}`, {
        file,
        line: lineOf(src, m.index ?? 0),
        expr: expr.trim().slice(0, 120),
        verdict: classify(expr),
        renderer,
        fromTest,
      });
    }
    // Spread-object form: `"data-x": expr,` — how tRadio's User and tLib's
    // nui-field hand attributes to a child, and invisible to the JSX pattern.
    for (const m of src.matchAll(/["'](data|aria)-([a-zA-Z0-9-]+)["']\s*:/g)) {
      const colon = (m.index ?? 0) + m[0].length - 1;
      const expr = propSlice(src, colon);
      add(`${m[1]}-${m[2]}`, {
        file,
        line: lineOf(src, m.index ?? 0),
        expr: expr.trim().slice(0, 120),
        verdict: classify(expr),
        renderer,
        fromTest,
      });
    }
    // Imperative and static producers. A `dataset.x = …` or a literal
    // `data-x="…"` in markup is a real string value by construction.
    for (const m of src.matchAll(/\bdataset\.([a-zA-Z][a-zA-Z0-9]*)\s*=/g))
      literal.add(`data-${m[1]}`);
    for (const m of src.matchAll(/setAttribute\(\s*["'](data|aria)-([a-zA-Z0-9-]+)["']/g))
      literal.add(`${m[1]}-${m[2]}`);
    for (const m of src.matchAll(/\s(data|aria)-([a-zA-Z0-9-]+)\s*=\s*["'][^"'{]*["']/g))
      literal.add(`${m[1]}-${m[2]}`);
  }
  return { bound, literal };
}

/** `data-radio-list-active` is produced by `dataset.radioListActive`. */
function emittedLiterally(attr: string, p: Producers): boolean {
  if (p.literal.has(attr)) return true;
  if (!attr.startsWith("data-")) return false;
  return p.literal.has(`data-${camel(attr)}`);
}

// ----------------------------------------------------------------- the engine

type Verdict = "dead" | "correct" | "unknown" | "never-emitted" | "latent";
type Finding = Site & { verdict: Verdict; why: string };

function evaluate(sites: Site[], producers: Producers, solidMajor: number): Finding[] {
  return sites.map((s) => {
    const all = producers.bound.get(s.attr) ?? [];
    // App code is the evidence; a test fixture is only the fallback, and only so
    // that a tree whose ONLY binding is in a fixture still gets a verdict
    // instead of silently becoming `never-emitted`.
    const app = all.filter((b) => !b.fromTest);
    let bindings = app.length > 0 ? app : all;
    // Same-renderer bindings win when there are any.
    //
    // shark-ui ships `registry/react` and `registry/solid` side by side with the
    // same component in both, and `data-active` is bound to a boolean in each.
    // Project-global attribution blamed the React selectors on the Solid
    // binding and vice versa, which is the one judgement that must not be
    // guessed: React stringifies a boolean, so a React selector beside a React
    // binding is CORRECT and "fixing" it breaks working code.
    const sameRenderer = bindings.filter((b) => b.renderer === s.renderer);
    if (sameRenderer.length > 0) bindings = sameRenderer;
    const bools = bindings.filter((b) => b.verdict === "boolean" && b.renderer === "solid");
    const reactBools = bindings.filter((b) => b.verdict === "boolean" && b.renderer === "react");
    const strings = bindings.filter((b) => b.verdict === "string");
    if (bools.length > 0) {
      const where = `${relative(SCAN_ROOT, bools[0]!.file)}:${bools[0]!.line}`;
      const why = `bound to a boolean at ${where} — \`${bools[0]!.expr}\``;
      // Solid 1 stringified, so the same site is correct there — for now.
      return { ...s, verdict: solidMajor >= 2 ? "dead" : "latent", why };
    }
    if (strings.length > 0)
      return {
        ...s,
        verdict: "correct",
        why: `string-valued at ${relative(SCAN_ROOT, strings[0]!.file)}:${strings[0]!.line}`,
      };
    if (reactBools.length > 0)
      return {
        ...s,
        verdict: "correct",
        why: `React stringifies the boolean at ${relative(SCAN_ROOT, reactBools[0]!.file)}:${reactBools[0]!.line}`,
      };
    if (emittedLiterally(s.attr, producers))
      return { ...s, verdict: "correct", why: "written imperatively or as static markup" };
    if (bindings.length > 0)
      return {
        ...s,
        verdict: "unknown",
        why: `bound at ${relative(SCAN_ROOT, bindings[0]!.file)}:${bindings[0]!.line}, value not provable — \`${bindings[0]!.expr}\``,
      };
    return { ...s, verdict: "never-emitted", why: "no producer found under this root" };
  });
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (skipDir(name)) continue;
    const p = join(dir, name);
    let s: ReturnType<typeof statSync> | undefined;
    try {
      s = statSync(p);
    } catch {
      continue; // a junction or a `nul`-shaped path; not source either way
    }
    if (s.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(p)) acc.push(p);
  }
  return acc;
}

/**
 * Highest solid-js major declared under the root. 0 when Solid is not used.
 *
 * Its own walk, because a project's solid-js dependency is rarely in the root
 * package.json — tLib declares it in `shared/ts` and `client/web`, and reading
 * only the root would see major 0 and downgrade every finding to `latent`.
 */
function solidMajorOf(root: string): number {
  let max = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skipDir(name)) continue;
      const p = join(dir, name);
      let s: ReturnType<typeof statSync> | undefined;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) visit(p);
      else if (name === "package.json") {
        const m = readFileSync(p, "utf8").match(/"solid-js"\s*:\s*"[^\d]*(\d+)/);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
  };
  visit(root);
  return max;
}

// ---------------------------------------------------------------- the control

const controlSrc = readFileSync(CONTROL, "utf8");
const controlStripped = stripComments(controlSrc);
const controlFiles = [{ file: CONTROL, src: controlStripped }];
const controlFindings = evaluate(
  selectorSites(CONTROL, controlStripped, controlSrc),
  collectProducers(controlFiles),
  2
);
/**
 * An EXACT per-attribute map, not a set of verdicts that appeared somewhere.
 *
 * "all four verdicts were seen" is satisfiable by accident — one rule can cover
 * for another and the count still looks right. Naming which attribute must come
 * out as what means a rule can only drift by turning a specific, named line red.
 *
 * `data-ctl-gone` is the `="false"` half of the defect and is listed separately
 * on purpose: it is the quieter half, because the selector reads as a deliberate
 * negative state rather than as a mistake.
 */
const EXPECTED_IN_CONTROL: Record<string, Verdict> = {
  "data-ctl-dead": "dead",
  "data-ctl-gone": "dead",
  "aria-ctl-raw": "dead",
  "data-ctl-ok": "correct",
  "data-ctl-imp": "correct",
  "data-ctl-opaque": "unknown",
  "data-ctl-ghost": "never-emitted",
};
const controlByAttr = new Map(controlFindings.map((f) => [f.attr, f.verdict]));
const controlWrong = Object.entries(EXPECTED_IN_CONTROL).filter(
  ([attr, want]) => controlByAttr.get(attr) !== want
);

console.log(
  `control: ${controlFindings.length} sites, ${Object.keys(EXPECTED_IN_CONTROL).length - controlWrong.length}/${Object.keys(EXPECTED_IN_CONTROL).length} expected verdicts`
);
if (controlWrong.length > 0) {
  console.error(
    "CONTROL BROKEN — the fixture no longer produces the verdicts it is written to produce:"
  );
  for (const [attr, want] of controlWrong)
    console.error(
      `  ${attr}: expected ${want}, got ${controlByAttr.get(attr) ?? "(no site found)"}`
    );
  console.error(`fixture: ${CONTROL}`);
  console.error(
    "A zero from this scanner is therefore meaningless. Fix the rule, not the fixture."
  );
  process.exit(2);
}

/**
 * Both READERS must still fire, not just the verdicts.
 *
 * Found by a drift drill: deleting the UnoCSS-variant reader outright left the
 * control at 7/7 and the run green, because every fixture attribute also appears
 * in a plain CSS-shaped selector and the per-attribute map could not tell which
 * reader had produced it. The variant form is the one that matters most in this
 * codebase — `data-[active=true]:` in a class string, where there is no
 * stylesheet to read and nothing else looks at it.
 */
for (const kind of ["selector", "variant"] as const) {
  const attrs = controlFindings.filter((f) => f.kind === kind).map((f) => f.attr);
  if (!attrs.includes("data-ctl-dead") || !attrs.includes("data-ctl-gone")) {
    console.error(`CONTROL BROKEN — the ${kind} reader no longer finds the fixture's dead pair.`);
    console.error(`fixture: ${CONTROL}`);
    console.error(
      "A zero from this scanner is therefore meaningless. Fix the rule, not the fixture."
    );
    process.exit(2);
  }
}

// ------------------------------------------------------------------- the scan

const paths = walk(SCAN_ROOT).filter((p) => p !== CONTROL && resolve(p) !== SELF);
const files = paths.map((file) => {
  const original = readFileSync(file, "utf8");
  return { file, src: stripComments(original), original };
});
const producers = collectProducers(files);
const solidMajor = solidMajorOf(SCAN_ROOT);
const findings = evaluate(
  files.flatMap(({ file, src, original }) => selectorSites(file, src, original)),
  producers,
  solidMajor
);

const counts = new Map<Verdict, number>();
for (const f of findings) counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1);

console.log(
  `\nscan root: ${relative(REPO, SCAN_ROOT) || "."}  (${files.length} files, solid-js major ${solidMajor || "n/a"})`
);
for (const v of ["dead", "latent", "unknown", "never-emitted", "correct"] as Verdict[])
  if (counts.get(v)) console.log(`  ${String(counts.get(v)).padStart(3)}  ${v}`);
console.log(`total selector sites: ${findings.length}`);

const show = (v: Verdict) => {
  for (const f of findings
    .filter((x) => x.verdict === v)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line))
    console.log(
      `  ${relative(SCAN_ROOT, f.file)}:${f.line}  [${f.attr}="${f.value}" ${f.kind}]  ${f.why}\n      ${f.text}`
    );
};

for (const v of ["dead", "latent", "unknown", "never-emitted"] as Verdict[])
  if (counts.get(v)) {
    console.log(`\n${v}:`);
    show(v);
  }
if (process.argv.includes("--list") && counts.get("correct")) {
  console.log("\ncorrect (left alone deliberately):");
  show("correct");
}

// ------------------------------------------------------------- the assertions

const dead = counts.get("dead") ?? 0;
if (dead > 0) {
  console.error(
    `\nFAIL: ${dead} selector(s) can never match — the attribute is bound to a boolean and Solid 2 writes that as "" or removes it.`
  );
  console.error(
    "Fix the CSS to a presence selector (`[data-x]`), which is exact: `false` removes the attribute."
  );
  process.exit(1);
}
if (STRICT) {
  const soft = (counts.get("unknown") ?? 0) + (counts.get("never-emitted") ?? 0);
  if (soft > 0) {
    console.error(
      `\nFAIL (--strict): ${soft} selector(s) could not be proven or have no producer.`
    );
    process.exit(1);
  }
}
console.log(
  "\nPASS: no dead boolean-attribute selector, and the control still produces every verdict."
);
