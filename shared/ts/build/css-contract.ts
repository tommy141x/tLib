import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Two build-time gates over a bundle's HAND-WRITTEN CSS, which `check:classes`
 * already walks but reads only for which names exist:
 *
 *   1. A consumer re-declaring a class `shared/css/surface.css` already defines.
 *      A local `.panel` or `.prop-input` in the same layer, further down the
 *      sheet, silently wins -- so the shared recipe is present, inert, and
 *      indistinguishable from absent.
 *   2. A `box-shadow` with a nonzero BLUR. `NUI_BLOCKLIST` keeps `shadow-*`
 *      UTILITIES out of every nui bundle and provably works, but it is an UnoCSS
 *      blocklist and cannot see hand-written CSS -- which is exactly where the
 *      blurred shadows survived.
 *
 * Both are part of `runDeadClassCheck` rather than a new script because that is
 * the one gate every resource already runs, and it already has the file walk.
 */

/** `shared/css/surface.css`, located from this module rather than from a cwd. */
export const SURFACE_CSS = resolve(import.meta.dir, "../../css/surface.css");

/**
 * tLib's own `shared/css` directory. Every CSS file under it is skipped on the
 * CONSUMER side of gate 1, because it is the definition side.
 */
const TLIB_SHARED_CSS = resolve(import.meta.dir, "../../css");

export interface CssRule {
  /** The selector list, whitespace-collapsed. */
  selector: string;
  /** The declaration block, braces excluded. */
  body: string;
  file: string;
  /** 1-based line of the start of the selector. */
  line: number;
}

/**
 * Every style rule in a stylesheet, with at-rules descended into.
 */
export function cssRules(css: string, file = "<string>"): CssRule[] {
  const rules: CssRule[] = [];
  // Line numbers are counted as we go rather than recomputed per rule: a
  // `lastIndexOf("\n")` scan per rule turned a 300-rule sheet quadratic.
  let line = 1;
  let i = 0;
  let prelude = "";
  let preludeLine = 1;
  // Depth of blocks we are inside whose prelude was an at-rule we descended
  // into; a style rule's own block is read as a body, never descended into.
  const open: { atRule: boolean }[] = [];

  const skipTo = (end: string): void => {
    const at = css.indexOf(end, i);
    const stop = at === -1 ? css.length : at + end.length;
    for (let k = i; k < stop; k++) if (css[k] === "\n") line++;
    i = stop;
  };

  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "/" && css[i + 1] === "*") {
      i += 2;
      skipTo("*/");
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < css.length && css[i] !== ch) {
        if (css[i] === "\\") i++;
        if (css[i] === "\n") line++;
        i++;
      }
      i++;
      prelude += css.slice(start, i);
      continue;
    }
    if (ch === "{") {
      const selector = prelude.replace(/\s+/g, " ").trim();
      if (selector.startsWith("@")) {
        // An at-rule. Descend, so the rules inside a `@layer`/`@media` are seen.
        open.push({ atRule: true });
        prelude = "";
        i++;
        continue;
      }
      // A style rule. Read its body whole, counting nested braces so that a
      // `@media` inside it (or a CSS-nested child) cannot end it early.
      const bodyStart = ++i;
      let depth = 1;
      while (i < css.length && depth > 0) {
        if (css[i] === "/" && css[i + 1] === "*") {
          i += 2;
          skipTo("*/");
          continue;
        }
        if (css[i] === '"' || css[i] === "'") {
          const q = css[i];
          i++;
          while (i < css.length && css[i] !== q) {
            if (css[i] === "\\") i++;
            if (css[i] === "\n") line++;
            i++;
          }
          i++;
          continue;
        }
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        else if (css[i] === "\n") line++;
        i++;
      }
      rules.push({ selector, body: css.slice(bodyStart, i - 1), file, line: preludeLine });
      prelude = "";
      continue;
    }
    if (ch === "}") {
      open.pop();
      prelude = "";
      i++;
      continue;
    }
    if (ch === ";") {
      // A statement at this level -- `@import`, `@layer a, b;`, or a
      // declaration inside an at-rule block. Not a selector either way.
      prelude = "";
      i++;
      continue;
    }
    if (ch === "\n") line++;
    if (!prelude.trim() && /\S/.test(ch)) preludeLine = line;
    prelude += ch;
    i++;
  }
  return rules;
}

/**
 * The class names a selector list actually STYLES -- the rightmost compound of
 * each comma-separated selector, and nothing else. This distinction is the whole
 * accuracy of gate 1: `.panel { }` redefines tLib's panel, while
 * `.panel .toolbar { }` styles something INSIDE a panel and is the correct way
 * to use the shared recipe. Pseudo-classes and attribute selectors are stripped
 * from the compound first.
 */
export function subjectClasses(selectorList: string): string[] {
  const out = new Set<string>();
  for (const selector of splitSelectorList(selectorList)) {
    const compound = lastCompound(selector);
    // `:not(.foo)` and `[data-x=".bar"]` must not contribute: blank every
    // bracketed or parenthesised run before harvesting.
    const bare = compound
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^()]*\)/g, "")
      .replace(/::?[\w-]+/g, "");
    for (const m of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function lastCompound(selector: string): string {
  let depth = 0;
  for (let i = selector.length - 1; i >= 0; i--) {
    const ch = selector[i]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") depth--;
    else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) {
      return selector.slice(i + 1);
    }
  }
  return selector;
}

/**
 * The classes `shared/css/surface.css` declares -- read from the file rather
 * than listed here, because a list is the failure mode this module is about. A
 * subject of two classes contributes NEITHER name: harvesting both put bare
 * `selected` into the guarded set, which then reported an unrelated consumer
 * class. A state modifier only has meaning compounded onto what it modifies.
 */

/** Memoised, because every consumer file re-asks and the answer cannot change mid-run. */
let surfaceNames: Set<string> | undefined;

/**
 * The classes `shared/css/surface.css` declares.
 */
export function surfaceClassNames(): Set<string> {
  if (surfaceNames) return surfaceNames;
  const css = readFileSync(SURFACE_CSS, "utf8");
  const names = new Set<string>();
  for (const rule of cssRules(css, SURFACE_CSS)) {
    for (const selector of splitSelectorList(rule.selector)) {
      const classes = subjectClasses(selector);
      if (classes.length === 1 && classes[0]) names.add(classes[0]);
    }
  }
  surfaceNames = names;
  return surfaceNames;
}

export interface SurfaceCollision {
  /** The surface class the consumer re-declared. */
  name: string;
  /** `file:line` of each local rule that styles it, project-relative. */
  sites: string[];
}

export interface ShadowFinding {
  /** `file:line`, project-relative. */
  site: string;
  selector: string;
  /** The offending `box-shadow` value. */
  value: string;
}

export interface CssContractOptions {
  /** Directories to walk for `.css`, relative to cwd or absolute. */
  cssRoots: string[];
  /**
   */
  allowSurfaceCollisions?: string[];
  /** Selectors whose blurred shadow is intentional. Same rule: none today. */
  allowShadowSelectors?: string[];
}

function walkCss(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walkCss(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

function localCssFiles(cssRoots: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of cssRoots) {
    for (const file of walkCss(root)) {
      const full = resolve(file);
      // tLib's own shared/css is the definition side, never a collision with
      // itself; `${sep}` so a sibling directory named `cssX` cannot match.
      if (full === TLIB_SHARED_CSS || full.startsWith(TLIB_SHARED_CSS + sep)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      files.push(full);
    }
  }
  return files;
}

const rel = (file: string): string => {
  const cwd = resolve(".");
  return (file.startsWith(cwd + sep) ? file.slice(cwd.length + 1) : file).replace(/\\/g, "/");
};

/**
 * The class a selector REDECLARES, as opposed to one it merely mentions.
 *
 * Exactly one name, and only when the selector is a single compound built on a
 * single class. `.panel`, `.panel:hover` and `.prop-input[data-state="open"]`
 * qualify; everything else returns nothing.
 */
function redeclaredSurfaceClass(selector: string, surface: Set<string>): string | undefined {
  // One selector only -- a list is handled by the caller, since each entry in it
  // stands or falls separately.
  if (lastCompound(selector) !== selector.trim()) return undefined;
  const classes = subjectClasses(selector);
  if (classes.length !== 1) return undefined;
  const name = classes[0];
  return name && surface.has(name) ? name : undefined;
}

export function findSurfaceCollisions(options: CssContractOptions): SurfaceCollision[] {
  const surface = surfaceClassNames();
  const allowed = new Set(options.allowSurfaceCollisions ?? []);
  const hits = new Map<string, string[]>();
  for (const file of localCssFiles(options.cssRoots)) {
    for (const rule of cssRules(readFileSync(file, "utf8"), file)) {
      for (const selector of splitSelectorList(rule.selector)) {
        const name = redeclaredSurfaceClass(selector, surface);
        if (!name || allowed.has(name)) continue;
        const sites = hits.get(name) ?? [];
        const site = `${rel(file)}:${rule.line}`;
        if (!sites.includes(site)) sites.push(site);
        hits.set(name, sites);
      }
    }
  }
  return [...hits]
    .map(([name, sites]) => ({ name, sites }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A `box-shadow` whose OFFSET and SPREAD may be anything but whose BLUR must be
 * zero.
 */
const LENGTH = /^[+-]?(?:\d*\.)?\d+(?:px|r?em|v[wh]|%|pt|ch|ex|q|cm|mm|in|pc)?$/i;

export function blurredShadow(value: string): string | undefined {
  // One `box-shadow` property may hold a comma-separated LIST of shadows; any
  // one of them blurring is enough. tELS:373 is exactly that case.
  for (const shadow of splitSelectorList(value)) {
    const tokens = shadow
      // Blank `rgba(0,0,0,.3)` and `hsl(var(--x) / .4)`: their numbers are not
      // lengths, and a naive split would read `.3` as a blur radius.
      .replace(/[\w-]*\((?:[^()]|\([^()]*\))*\)/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const lengths = tokens.filter((t) => LENGTH.test(t));
    // offset-x, offset-y, blur, spread. Blur is the third, and absent means 0.
    const blur = lengths[2];
    if (blur !== undefined && Number.parseFloat(blur) !== 0) return shadow.trim();
  }
  return undefined;
}

export function findBlurredShadows(options: CssContractOptions): ShadowFinding[] {
  const allowed = new Set(options.allowShadowSelectors ?? []);
  const findings: ShadowFinding[] = [];
  for (const file of localCssFiles(options.cssRoots)) {
    for (const rule of cssRules(readFileSync(file, "utf8"), file)) {
      if (allowed.has(rule.selector)) continue;
      for (const m of rule.body.matchAll(/(?<![\w-])box-shadow\s*:\s*([^;}]+)/gi)) {
        const offender = blurredShadow(m[1] ?? "");
        if (offender) {
          findings.push({
            site: `${rel(file)}:${rule.line}`,
            selector: rule.selector,
            value: offender,
          });
        }
      }
    }
  }
  return findings;
}

export function formatSurfaceCollisions(found: SurfaceCollision[]): string {
  if (found.length === 0) return "No surface.css class collisions.";
  const lines = found.map(({ name, sites }) => `  .${name.padEnd(20)} ${sites.join(", ")}`);
  return [
    `${found.length} class name(s) re-declare a rule from shared/css/surface.css:`,
    "",
    ...lines,
    "",
    "surface.css is re-exported from theme-tokens.css, so this bundle already has",
    "these rules. A local copy in the same layer, further down the sheet, wins --",
    "the shared recipe is present and inert. Delete the local rule, or if it is",
    "genuinely a different thing, give it a different name.",
  ].join("\n");
}

export function formatBlurredShadows(found: ShadowFinding[]): string {
  if (found.length === 0) return "No blurred box-shadow in hand-written CSS.";
  const lines = found.map(({ site, selector, value }) => `  ${site}  ${selector}\n      ${value}`);
  return [
    `${found.length} blurred box-shadow(s) in hand-written CSS:`,
    "",
    ...lines,
    "",
    "`NUI_BLOCKLIST` keeps `shadow-*` utilities out of every nui bundle because",
    "CEF cannot composite a blur usefully over a moving scene. It is an UnoCSS",
    "blocklist and cannot see this file. Use an `outline`, a `border`, or a",
    "zero-blur shadow -- offset and spread are fine, the blur is not.",
  ].join("\n");
}
