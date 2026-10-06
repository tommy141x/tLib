import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Two build-time gates over a bundle's HAND-WRITTEN CSS.
 *
 * `check:classes` already walks every `.css` file a bundle ships -- that is how
 * a `.tlib-nui-*` or `lcd-*` class avoids needing an allowlist entry. It reads
 * those files only to learn which names EXIST, though, and throws the rest
 * away. Both gates here are things that were measured in those same bytes and
 * that nothing could see:
 *
 *   1. A consumer re-declaring a class that `shared/css/surface.css` already
 *      defines. `surface.css` IS the surface recipe and the type scale, and
 *      from the commit that re-exported it out of `theme-tokens.css` every
 *      consumer gets it. A local `.panel` or `.prop-input` in the same layer,
 *      further down the sheet, silently wins -- so the shared recipe is present,
 *      inert, and indistinguishable from absent. Before the re-export the same
 *      names simply meant the two sheets had forked; after it they mean a
 *      shadowed rule. Either way the collision is the thing to see.
 *
 *   2. A `box-shadow` with a nonzero BLUR. `NUI_BLOCKLIST` in `uno-preset.ts`
 *      keeps `shadow-*` UTILITIES out of every nui bundle and provably works --
 *      there is not one `.shadow-` rule in any of the seven built sheets. It is
 *      an UnoCSS blocklist, though, so it cannot see a line of hand-written CSS,
 *      and hand-written CSS is exactly where the blurred shadows survived.
 *
 * Both are deliberately part of `runDeadClassCheck` rather than a new script:
 * that is the one gate every resource already runs in its own `verify`, built
 * from the consumer's own config, and it already has the file walk. A separate
 * script would have to be wired into seven `package.json` files by seven
 * different hands to reach the same bundles.
 */

/** `shared/css/surface.css`, located from this module rather than from a cwd. */
export const SURFACE_CSS = resolve(import.meta.dir, "../../css/surface.css");

/**
 * tLib's own `shared/css` directory.
 *
 * Every CSS file under it is skipped on the CONSUMER side of gate 1, because it
 * is the definition side: `surface.css` declaring `.panel` is not a collision
 * with itself, and tLib's `client/web` passes `../../shared/ts` as a `cssRoot`
 * so that the stylesheets declaring its `mp-*` hooks are in scope.
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
 *
 * A regex cannot do this: the rules that matter here are nested inside
 * `@layer components { ... }` (which is the whole point of surface.css), and
 * `.segment:hover:not([aria-pressed="true"]):not([aria-disabled="true"])`
 * carries both brackets and parentheses with a quoted `"true"` inside them. A
 * brace-counting walk that also tracks strings and comments is shorter than the
 * regex that would get those two right.
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
 * each comma-separated selector, and nothing else.
 *
 * This distinction is the whole accuracy of gate 1. `.panel { … }` redefines
 * tLib's panel; `.panel .toolbar { … }` styles something INSIDE a panel and is
 * the normal, correct way for a consumer to use the shared recipe. Reading
 * every class in the selector would report the second as a collision, and a
 * gate that fires on correct code gets switched off.
 *
 * Pseudo-classes, pseudo-elements and attribute selectors are stripped from the
 * compound first, so `.prop-input:focus-visible` and
 * `.list-row[data-state="open"]` both resolve to the class they qualify -- a
 * consumer overriding only the focus state of `.prop-input` has still forked it.
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

let surfaceNames: Set<string> | undefined;

/**
 * The classes `shared/css/surface.css` declares.
 *
 * Read from the file rather than listed here, because a list is the failure
 * mode this whole module is about: the seven names in the audit that found this
 * (`.panel`, `.prop-input`, `.section-label`, `.list-row`, `.segment`,
 * `.field-hint`, `.row-action`) are already eight -- `.segment-track` was in
 * surface.css and not in the list. A name added to surface.css tomorrow is
 * guarded with no edit here.
 *
 * ── Only a LONE class counts ──
 *
 * A subject of two classes contributes neither. The one case in surface.css is
 * `.list-row.selected`, and harvesting both put bare `selected` into the
 * guarded set -- which then reported tELS's own unrelated `.selected`, a
 * generic state word that surface.css never styles on its own. A state modifier
 * only has meaning compounded onto the thing it modifies, so a consumer
 * declaring `.selected` has not forked anything. Measured on the first sweep of
 * all nine bundles: it was the only false positive in the whole corpus.
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
   * Surface class names this bundle is allowed to re-declare. Each entry needs
   * a reason at the call site; there are none today and the gate is meant to be
   * satisfied by deleting the local rule, not by listing it.
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

export function findSurfaceCollisions(options: CssContractOptions): SurfaceCollision[] {
  const surface = surfaceClassNames();
  const allowed = new Set(options.allowSurfaceCollisions ?? []);
  const hits = new Map<string, string[]>();
  for (const file of localCssFiles(options.cssRoots)) {
    for (const rule of cssRules(readFileSync(file, "utf8"), file)) {
      for (const name of subjectClasses(rule.selector)) {
        if (!surface.has(name) || allowed.has(name)) continue;
        const sites = hits.get(name) ?? [];
        sites.push(`${rel(file)}:${rule.line}`);
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
 *
 * Blur is the part CEF cannot composite: a blurred shadow over a moving 3D scene
 * costs a compositor pass every frame, which is the measurement written up at
 * `shared/css/surface.css:52-58`. A zero-blur shadow is hard-edged, composites
 * like a border, and is load-bearing in four places in tLib that this gate must
 * not fire on:
 *
 *   menu.css:905       `inset 3px 0 currentColor`        a left edge bar
 *   menu.css:941       `inset 0 0 0 999px #8882`         a flat tint overlay
 *   nui.css:221,224    `inset 0 0 0 999px rgb(…)`        the same, hover/active
 *   global.css:127,136 `0 0 0 2px hsl(var(--background))` a slider-thumb halo
 *
 * The audit this gate came from proposed `box-shadow:[^;]*[1-9][0-9]*px [1-9]`.
 * Checked against the corpus, that regex is sound on everything tLib ships --
 * all four pass it -- but it UNDER-fires on the one that matters most: tELS's
 * `inset 0 0 8px rgba(255,255,255,.2)` is a real blur and the regex needs a
 * digit after `8px `, where a letter stands. It also over-fires in principle,
 * on any hard-edged two-offset shadow (`inset 2px 4px #000` matches `4px` after
 * `2px `), which nothing in the corpus happens to use. Parsing the length list
 * and testing the third value gets both right; both divergences are asserted in
 * `scripts/css-contract-control.ts` so this paragraph cannot quietly go stale.
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
