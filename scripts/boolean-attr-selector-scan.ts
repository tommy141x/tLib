#!/usr/bin/env bun
/**
 * Finds CSS/UnoCSS selectors that Solid 2's attribute serialisation turned
 * into dead rules. `bun run check:boolattr [--list] [--strict] [--root <dir>]`
 *
 * `@solidjs/web`'s `setAttribute` writes a boolean `true` as the EMPTY
 * STRING and REMOVES the attribute on `false` (Solid 1 stringified both).
 * So `[data-x="true"]` or `[data-x="false"]` beside a JSX boolean binding
 * goes dead with no error, no warning, no build failure.
 *
 * The scanner resolves how the attribute is actually produced before calling
 * a selector dead: bound to a boolean (`data-x={a && b}`) is the finding;
 * bound to a string (`open() ? "true" : undefined`, `String(x)`), set via
 * `dataset`/`setAttribute`, or static markup is correct and left alone;
 * `unknown` (unprovable, e.g. `props["data-x"]`) and `never-emitted` are
 * reported but only fail under `--strict` — turning "cannot prove this" into
 * a hard failure is how a gate gets routed around. `aria-*` gets the same
 * treatment but is rarely a finding since `aria-expanded="true"` is a
 * legitimate string per the ARIA spec; it's only dead when JSX hands it a
 * raw boolean, producing invalid `aria-x=""`.
 *
 * Under Solid 1 the same site is correct, so a Solid 1 root (version read
 * from its own package.json files) reports findings as `latent` rather than
 * failing — the list of what breaks on migration, not bugs today. Do not
 * pre-fix them: `[data-x]` presence is only exact once `false` removes the
 * attribute, and Solid 1 still writes `data-x="false"` (present), so
 * converting early inverts the rule.
 *
 * Every rule also runs against `boolean-attr-selector-control.fixture.tsx`,
 * deliberately wrong, read from this repo regardless of `--root` so it can't
 * be weakened; if either reader (CSS selector, UnoCSS variant) stops finding
 * its dead pair, the whole run exits 2 even when the real tree is clean —
 * deleting the variant reader once left an earlier control fully green.
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

/** `backups/`, `assets/` hold frozen pre-migration/minified copies, not editable source; `solid-compat/` documents the Solid 1 surface on purpose. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "backups", "assets", "solid-compat"]);
const skipDir = (name: string) => SKIP_DIRS.has(name) || name.startsWith(".");
const SCAN_EXT = /\.(css|scss|html|tsx?|jsx?|mdx)$/;
/** This file's own regex literals quote the defect verbatim; exclude self from the scan. */
const SELF = resolve(import.meta.path);

/**
 * Blanks comment bodies, preserving every byte position and newline, so a
 * comment explaining the fix (which quotes `[data-x="true"]`) doesn't itself
 * report as the bug. Handles `//`, `/* *\/` and `<!-- -->`; skips string
 * literals so a `//` in a URL doesn't eat the rest of the line.
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


type Binding = {
  file: string;
  line: number;
  expr: string;
  verdict: "boolean" | "string" | "unknown";
  renderer: "solid" | "react";
  fromTest: boolean;
};

/**
 * React is not affected: it stringifies a boolean `data-*`/`aria-*` to
 * "true"/"false", so the same selector beside the same binding is correct
 * there. shark-ui ships `registry/react` and `registry/solid` side by side
 * with the same component in both, so renderer matters per-file.
 */
function rendererOf(file: string, src: string): "solid" | "react" {
  if (/from\s*["']react(?:["']|\/)/.test(src)) return "react";
  if (/["']react\/jsx-/.test(src)) return "react";
  if (/[\\/]react[\\/]/.test(file)) return "react";
  return "solid";
}

/**
 * A test/fixture renders shapes the app never renders:
 * `solid-2-aria-attributes.test.tsx` deliberately passes `asBool(false)` to
 * `aria-invalid`, which made tWeb's correct `aria-[invalid=true]:` variant
 * report dead. Tests are still scanned for selectors, just not trusted as
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
 * Classifies the bound expression. String is checked first and wins: what
 * makes a site correct is that the VALUE reaching the DOM is a string, not
 * that the condition isn't a boolean (e.g. `open() ? "true" : "false"`).
 */
function classify(expr: string): Binding["verdict"] {
  // `?.`/`??` masked first: both start like a ternary, and Dialog.tsx's
  // `a() && LABELLESS.has(field()?.type ?? "")` was misread as a string
  // ternary via the `??`/`""` default without this.
  const e = expr.trim().replace(/\?\?/g, "@@").replace(/\?\./g, "@.");
  if (e === "") return "unknown";
  if (/^\s*["'`]/.test(e)) return "string";
  if (/\bString\s*\(/.test(e)) return "string";
  if (/["'](?:true|false)["']/.test(e)) return "string";
  // Real ternary (has `:`) with a quote/backtick in the value position only —
  // a bare "contains a backtick" rule misread shark-ui's
  // `item.url === `#${activeHeading}`` (a boolean comparison) as string-valued.
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


type Verdict = "dead" | "correct" | "unknown" | "never-emitted" | "latent";
type Finding = Site & { verdict: Verdict; why: string };

function evaluate(sites: Site[], producers: Producers, solidMajor: number): Finding[] {
  return sites.map((s) => {
    const all = producers.bound.get(s.attr) ?? [];
    // App code is evidence; a test-only binding is the fallback, so a tree
    // whose only binding is in a fixture still gets a verdict.
    const app = all.filter((b) => !b.fromTest);
    let bindings = app.length > 0 ? app : all;
    // Same-renderer bindings win: shark-ui ships registry/react and
    // registry/solid with the same `data-active` boolean binding in both, and
    // a React selector beside the React binding is correct (React stringifies).
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

const controlSrc = readFileSync(CONTROL, "utf8");
const controlStripped = stripComments(controlSrc);
const controlFiles = [{ file: CONTROL, src: controlStripped }];
const controlFindings = evaluate(
  selectorSites(CONTROL, controlStripped, controlSrc),
  collectProducers(controlFiles),
  2
);
/**
 * An exact per-attribute map, not a set of verdicts seen somewhere -- "all
 * four verdicts appeared" is satisfiable by one rule covering for another.
 * `data-ctl-gone` (the `="false"` half) is listed separately since it reads
 * as a deliberate negative state rather than a mistake.
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
 * Both readers must still fire, not just the verdicts: deleting the
 * UnoCSS-variant reader once left the control at 7/7 and the run green,
 * because every fixture attribute also appears in a plain CSS-shaped
 * selector, so the per-attribute map alone couldn't tell which reader fired.
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
