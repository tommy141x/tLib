import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds utility class names that generate no CSS at all.
 *
 * This exists because UnoCSS has no failure mode for a class it does not
 * recognise -- it simply emits nothing, so a typo, a preset-only utility or a
 * Tailwind-v4 spelling used under the wrong preset looks completely normal in
 * source and silently does nothing in the browser. Measured: `bg-linear-to-r`
 * (Wind4-only) left tLib's colour-picker hue track with no gradient, and 271
 * Tailwind-v4 spellings across the four Wind4 web projects meant none of their
 * form primitives had any invalid-state styling.
 *
 * The harvesting here is tWeb's `check-uno-classes.ts`, which predates this
 * module and was the better implementation of the same idea -- `classList`
 * keys, `${...}` interpolations, cva variant keys and the unambiguous/composed
 * split are all its work, each with a bug behind it. This module generalises it
 * so the nine other bundles stop going unchecked, and adds one thing it wanted:
 * class names are read out of the project's own CSS rather than listed by hand.
 * Its allowlist had two blocks its own comments admit had gone stale, which is
 * the failure mode a hand-kept list always has.
 */
export interface DeadClassOptions {
  /**
   * The consuming project's own generator, already built from its own
   * uno.config.ts. It is passed in rather than constructed here so the check
   * runs against the exact preset and version that project ships -- the whole
   * point is to catch preset-specific spellings, which a generator built from
   * some other config would get wrong.
   */
  uno: { parseToken(token: string): Promise<unknown> };
  /** Directories to scan for .ts/.tsx sources, relative to cwd or absolute. */
  roots: string[];
  /**
   * Directories to scan for .css files. Every `.class-name` selector found is
   * treated as defined, so hand-written CSS (tLib's `tlib-nui-*` family, the
   * radio's `lcd-*`) needs no entry in any list.
   */
  cssRoots?: string[];
  /** Tokens that are valid regardless of what the generator says. */
  extraAlive?: (string | RegExp)[];
  /**
   * Hooks that are only exempt under a given path. A bare prefix exemption
   * applied everywhere silently covers a real typo on an unrelated class that
   * happens to start the same way.
   */
  scopedAlive?: { dir: string; pattern: RegExp }[];
  /** Files whose every string literal is a class list, e.g. a shared styles.ts. */
  wholeFileIsClasses?: string[];
  /**
   * Files to skip. Defaults to test and spec files: their class strings are
   * assertions about markup, never part of a shipped bundle, so a dead class
   * there is not a rendering bug.
   */
  excludeFiles?: RegExp;
}

export interface DeadClass {
  token: string;
  files: string[];
}

/**
 * `group` and `peer` are markers, not utilities: they exist so `group-hover:`
 * and `peer-checked:` have something to bind to, and they correctly generate no
 * CSS of their own. The named form `group/drawer` is the same marker, scoped so
 * a nested group can be addressed unambiguously -- listing each name by hand
 * would be a checker that punishes the pattern it should be neutral about.
 */
const MARKER_CLASSES = new Set(["group", "peer", "dark"]);
const NAMED_MARKER = /^(?:group|peer)\/[\w-]+$/;

/**
 * Looks like a utility rather than an ordinary word.
 *
 * Applied only to tokens from a COMPOSED region, where not every string is a
 * class: `cn(buttonVariants({ size: "lg" }), "px-0")` contributes both. A real
 * typo always carries one of these marks; `lg`, `solid` and `base` do not.
 * Tokens from a plain `class="..."` are unambiguous and skip this filter, so a
 * misspelt bare word there is still caught.
 */
const REPORTABLE = /[-:[/.]/;

const CSS_CLASS_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * `class="..."`, `class: "..."`, class={`...`} -- the plain forms, where the
 * value is a single literal. Each quote style gets its own alternative so a
 * template literal containing double quotes is captured whole rather than being
 * cut at the first inner quote.
 */
const CLASS_ATTR_OPEN = /class\s*[:=]\s*\{?\s*(["'`])/g;

/**
 * The value of every `class=` attribute, scanned to its real terminator.
 *
 * A template literal cannot be matched with `` `([^`]*)` ``: its `${...}` may
 * contain a template of its own, and the inner one's backtick closes the match
 * early. Measured on tRadio's DisplayLine --
 * ``class={`display-container${props.class ? ` ${props.class}` : ""}`}`` -- the
 * capture ended mid-expression and the report named
 * `display-container${props.class`, which is not a class anywhere in the source.
 */
function classAttrValues(code: string): string[] {
  const values: string[] = [];
  for (const m of code.matchAll(CLASS_ATTR_OPEN)) {
    const quote = m[1]!;
    const start = m.index + m[0].length;
    if (quote !== "`") {
      const end = code.indexOf(quote, start);
      if (end !== -1) values.push(code.slice(start, end));
      continue;
    }
    // A stack, because template and expression contexts nest arbitrarily:
    // "`" means we are reading literal text, "}" means we are inside a `${`.
    const stack: string[] = ["`"];
    let i = start;
    let end = -1;
    while (i < code.length && stack.length > 0) {
      const ch = code[i]!;
      if (stack[stack.length - 1] === "`") {
        if (ch === "\\") i += 2;
        else if (ch === "`") {
          stack.pop();
          if (stack.length === 0) end = i;
          i++;
        } else if (ch === "$" && code[i + 1] === "{") {
          stack.push("}");
          i += 2;
        } else i++;
        continue;
      }
      if (ch === "`" || ch === "{") {
        stack.push(ch === "`" ? "`" : "}");
        i++;
      } else if (ch === "}") {
        stack.pop();
        i++;
      } else if (ch === '"' || ch === "'") {
        i++;
        while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
        i++;
      } else i++;
    }
    if (end !== -1) values.push(code.slice(start, end));
  }
  return values;
}

/** Quoted strings inside a `${...}` interpolation -- these are real class names too. */
const NESTED_STRING = /["']([^"']*)["']/g;

/**
 * Solid's other way of setting classes: `classList={{ "bg-accent": cond }}`.
 * The keys are class names and are invisible to CLASS_ATTR -- which is exactly
 * the blind spot a conditional style hides in, since the branch not taken in
 * the reviewed screenshot is the one whose typo nobody sees.
 */
const CLASS_LIST_KEY = /["'`]([^"'`]+)["'`]\s*:/g;

/**
 * Regions whose string literals are class lists, matched by balancing their own
 * delimiter so nesting does not truncate them. `class={...}` covers every
 * `cn()` call site; `cva(...)` covers the component recipes, where the most
 * reused classes live and a silent typo costs the most.
 */
const REGIONS: { opener: RegExp; open: string; close: string; nestedObjects?: "arguments" }[] = [
  // In a `class={...}` the only nested object literal is an argument: either a
  // recipe's variant selection, `buttonVariants({ size: "icon-sm" })`, or the
  // clsx conditional form, `cn({ "is-open": open() })` -- whose values are
  // booleans and whose keys `STRING_OR_KEY` already skips. Neither holds a class
  // name, so the whole literal is blanked before harvesting. Without this,
  // `cn(buttonVariants({ variant: "ghost", size: "icon-md" }), "px-0")` reported
  // `icon-md`, a variant name that is correct as written and generates no CSS by
  // design. Measured: six such findings across solid-starter and tg-new.
  { opener: /class\s*=\s*\{/g, open: "{", close: "}", nestedObjects: "arguments" },
  // NOT applied to `cva(...)`: there the nested objects ARE the recipe, and
  // `variants: { size: { sm: "h-6" } }` is where most of a component's class
  // names live.
  { opener: /\bcva\s*\(/g, open: "(", close: ")" },
];

/**
 * A string immediately followed by `:` is a cva variant KEY, not a class.
 *
 * The body admits the other two quote characters. Restricting it to
 * `[^"'\`\\]` meant a string containing a different quote could never be matched
 * whole, so the scan resynchronised on the INNER quote and handed over its
 * contents: `"[&_svg:not([class*='size-'])]:size-4"` -- the shadcn idiom for
 * "unless the caller already sized the icon" -- reported a bare `size-`, and the
 * same shape produced `h-`, `w-`, `flex-` and `text-`. The apostrophe case the
 * old class was written for (`label: "don't"`) is handled better by matching the
 * whole string too: `don't` carries no utility punctuation and is dropped, and
 * the tokens after it are no longer swallowed.
 */
const STRING_OR_KEY = /(["'`])((?:[^\\]|\\.)*?)\1(\s*:)?/g;

/**
 * Stands in for a removed `${...}`. Not whitespace, so it stays fused to
 * whatever it touched: `home-page-indicator-${props.direction}` collapses to one
 * token carrying the marker rather than to the prefix `home-page-indicator-`,
 * and `isClassShaped` then drops it. A partially-known class name is not a
 * finding -- the class the browser sees is decided at runtime and this check
 * cannot know it.
 */
const INTERPOLATION = "\u0000";

/**
 * Replaces every `${...}` with INTERPOLATION, handing each expression to `onExpr`.
 *
 * Brace-matched rather than `[^}]*`, because an expression regularly contains
 * braces of its own. Measured: ``class={`display-container${props.class ? `
 * ${props.class}` : ""}`}`` ends its match at the INNER `}`, so the remaining
 * `` ` : ""}`` fused onto the prefix and the report named a token that is not in
 * the source. That is the shape of finding that gets a check switched off.
 */
function replaceInterpolations(value: string, onExpr: (expr: string) => void): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "$" || value[i + 1] !== "{") {
      out += value[i++];
      continue;
    }
    let depth = 0;
    let end = i + 1;
    for (; end < value.length; end++) {
      if (value[end] === "{") depth++;
      else if (value[end] === "}" && --depth === 0) break;
    }
    if (end >= value.length) {
      out += value[i++];
      continue;
    }
    onExpr(value.slice(i + 2, end));
    out += INTERPOLATION;
    i = end + 1;
  }
  return out;
}

/**
 * Blanks every object literal nested inside a `class={...}` region.
 *
 * The region's own outermost `{` is the JSX expression container and is kept;
 * anything braced inside it is an argument object -- a recipe's variant
 * selection or clsx's conditional form -- and holds no class names. Blanked
 * with spaces rather than removed so nothing fuses across the hole.
 *
 * Strings are skipped while scanning, so a `${...}` inside a template literal
 * is not mistaken for an object and blanked out from under `classAttrValues`.
 */
function blankNestedObjects(region: string): string {
  const out = region.split("");
  let depth = 0;
  let i = 0;
  while (i < region.length) {
    const ch = region[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      i++;
      while (i < region.length && region[i] !== quote) i += region[i] === "\\" ? 2 : 1;
      i++;
      if (depth > 1) for (let j = start; j < i && j < region.length; j++) out[j] = " ";
      continue;
    }
    if (ch === "{") {
      depth++;
      // depth 1 is the JSX expression container itself.
      if (depth > 1) out[i] = " ";
      i++;
      continue;
    }
    if (ch === "}") {
      if (depth > 1) out[i] = " ";
      depth--;
      i++;
      continue;
    }
    if (depth > 1) out[i] = " ";
    i++;
  }
  return out.join("");
}

/**
 * Blanks the body of a `cva(...)` recipe's `defaultVariants` object.
 *
 * Every other object in a recipe holds class names; this one holds variant
 * NAMES, and the shadcn convention hyphenates them -- `align: "inline-start"`,
 * `placement: "top-end"` -- which makes them indistinguishable from a utility by
 * shape. Both were reported against solid-starter and tg-new, and both are
 * correct as written. Matched by its reserved key rather than by position
 * because it is the only object in the recipe with that meaning.
 */
function blankDefaultVariants(region: string): string {
  const out = region.split("");
  for (const m of region.matchAll(/\bdefaultVariants\s*:\s*\{/g)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < region.length; i++) {
      const ch = region[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      if (i > m.index + m[0].length - 1) out[i] = " ";
    }
  }
  return out.join("");
}

/**
 * Blanks a string literal that is an operand of a comparison.
 *
 * `cn("transition-shadow", phase() === "typing-email" && activeRing)` puts a
 * state-machine member inside a class region, and `"typing-email"` is
 * kebab-case, so it is reported as a class that generates no CSS. It is a union
 * member declared as `type Phase = "typing-email" | ...` a few lines up. Two of
 * them in solid-starter, the same two in tg-new. The comparison is what proves
 * the literal is a value rather than a class name, so the operator is matched
 * rather than the literal's shape.
 */
function blankComparisonOperands(region: string): string {
  const out = region.split("");
  let i = 0;
  while (i < region.length) {
    const quote = region[i];
    if (quote !== '"' && quote !== "'") {
      i++;
      continue;
    }
    // Walk the literal rather than matching it: a regex body that admits the
    // other quote characters -- which this module's string matcher has to, so
    // that `"don't"` matches whole -- backtracks across neighbouring literals
    // to reach an operator, and blanks every class between them.
    const start = i;
    i++;
    while (i < region.length && region[i] !== quote) i += region[i] === "\\" ? 2 : 1;
    i = Math.min(i + 1, region.length);
    const before = region.slice(0, start).trimEnd();
    const after = region.slice(i).trimStart();
    if (/(?:^|[^=!<>])[=!]==?$/.test(before) || /^[=!]==?(?![=])/.test(after)) {
      for (let j = start; j < i; j++) out[j] = " ";
    }
  }
  return out.join("");
}

/** Comments discuss class names that were rejected -- that is documentation. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Returns the source of every region opened by `opener`, brace-matched rather
 * than regex-matched since the bodies nest and a non-greedy match stops at the
 * first inner close.
 */
function matchedBlocks(code: string, opener: RegExp, open: string, close: string): string[] {
  const blocks: string[] = [];
  for (const m of code.matchAll(opener)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      const ch = code[i];
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        blocks.push(code.slice(m.index, i + 1));
        break;
      }
    }
  }
  return blocks;
}

const GROUP_PREFIX_CHAR = /[\w[\]@:./-]/;

/**
 * Splits on whitespace that is not inside brackets or parens, so a utility like
 * `grid-cols-[minmax(0,13rem)_minmax(0,68ch)]` survives as one token.
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "[" || ch === "(") depth++;
    // Clamped at zero. Harvesting can hand this an unbalanced fragment, and an
    // unclamped `]` drove depth negative so every later space counted as
    // "inside brackets" -- the rest of the fragment then fused into one giant
    // pseudo-token like `],\n        destructive: [`.
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Expands `hover:(bg-x text-y)` into `hover:bg-x hover:text-y`.
 *
 * Every project here runs transformerVariantGroup, so this syntax is valid in
 * source but is not a class name the generator is ever handed. Splitting on
 * whitespace instead produces fragments like `hover:(bg-x` and `text-y)`, dead
 * by construction, which was the single largest source of noise in this report.
 *
 * UnoCSS exports `expandVariantGroup` and this deliberately does not use it.
 * Measured against it on seven cases, the two agree on six; on the seventh it
 * rewrites `min-w-(--reference-width)` -- a Tailwind-v4 spelling that is one of
 * the exact bugs this module is for -- into `min-w---reference-width`. That is
 * faithful to what the transformer does at build time, but it is the wrong
 * thing to REPORT: the token the author has to find and fix is the one they
 * typed, not a mangling of it that appears nowhere in their source.
 */
export function expandVariantGroups(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "(" || value[i - 1] !== ":") {
      out += value[i++];
      continue;
    }
    // Walk back over the variant prefix, e.g. the `lg:` of `lg:(...)`.
    let start = i - 1;
    while (start > 0 && GROUP_PREFIX_CHAR.test(value[start - 1] ?? "")) start--;
    // A balanced scan, not `[^()]*` -- the group body regularly contains
    // parens, and `lg:(grid-cols-[minmax(0,13rem)_...] justify-center)` was
    // being cut at the first `)` inside minmax, reporting both halves as dead.
    let depth = 0;
    let end = i;
    for (; end < value.length; end++) {
      if (value[end] === "(") depth++;
      else if (value[end] === ")" && --depth === 0) break;
    }
    if (end >= value.length) {
      out += value[i++];
      continue;
    }
    const prefix = value.slice(start, i);
    const inner = expandVariantGroups(value.slice(i + 1, end));
    out = out.slice(0, out.length - prefix.length);
    out += splitTopLevel(inner)
      .map((part) => `${prefix}${part}`)
      .join(" ");
    i = end + 1;
  }
  return out;
}

/**
 * Rejects fragments that cannot be a class name.
 *
 * Harvesting is regex-based and will occasionally pair a closing quote with the
 * next opening one, handing over the source in between -- `],\n destructive: [`
 * and bare `[` both reached the report that way. A class name has balanced
 * brackets, no whitespace, and starts with a letter, a `!` or the `[` of an
 * arbitrary variant like `[&_svg]:h-lh`.
 */
function isClassShaped(token: string): boolean {
  if (!token || /\s/.test(token)) return false;
  // Part of the name is computed, so the rendered class is unknowable here.
  if (token.includes(INTERPOLATION)) return false;
  // A surviving `${` means the fragment was cut mid-expression by whichever
  // matcher produced it -- the region scan reads template literals with a
  // non-greedy regex and stops at a nested backtick. Source, not a class.
  if (token.includes("${")) return false;
  // A bare variant with nothing to apply it to. An apostrophe inside a string
  // (`label: "don't"`) makes the quote matcher pair across it and hand over the
  // source in between, which arrives as fragments like `more:` and `y:`.
  if (token.endsWith(":")) return false;
  let depth = 0;
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;
  // The leading `*:` / `**:` of Tailwind's child and descendant variants is the
  // one class-legal opener that is not a letter, a `!`, a `[` or an `@`. Without
  // it `**:[svg]:text-destructive!` was dropped before it could be checked --
  // and it IS dead under presetWind4, while its `dark:`-prefixed twin on the
  // next line was reported, so the file read as half-broken for no reason.
  return /^!?(?:\*{1,2}:)?[a-zA-Z[@]/.test(token);
}

function tokenise(value: string): string[] {
  return splitTopLevel(expandVariantGroups(value)).filter(isClassShaped);
}

function walk(dir: string, test: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full, test);
    return test.test(entry.name) ? [full] : [];
  });
}

export async function findDeadClasses(options: DeadClassOptions): Promise<DeadClass[]> {
  const {
    uno,
    roots,
    cssRoots = roots,
    extraAlive = [],
    scopedAlive = [],
    wholeFileIsClasses = [],
    excludeFiles = /\.(?:test|spec)\.[cm]?tsx?$/,
  } = options;

  // Hand-written CSS is not UnoCSS's responsibility, so harvest every selector
  // the project defines itself and treat those names as declared.
  const declared = new Set<string>();
  for (const root of cssRoots) {
    for (const file of walk(root, /\.css$/)) {
      for (const match of readFileSync(file, "utf8").matchAll(CSS_CLASS_SELECTOR)) {
        if (match[1]) declared.add(match[1]);
      }
    }
  }

  const isExtraAlive = (token: string) =>
    extraAlive.some((rule) => (typeof rule === "string" ? rule === token : rule.test(token)));

  const found = new Map<string, Set<string>>();
  const verdicts = new Map<string, boolean>();

  for (const root of roots) {
    for (const file of walk(root, /\.[cm]?tsx?$/)) {
      if (excludeFiles.test(file)) continue;
      const path = file.replace(/\\/g, "/");
      const code = stripComments(readFileSync(file, "utf8"));
      const wholeFile = wholeFileIsClasses.some((w) => path.endsWith(w));

      /** Tokens from an unambiguous class list. Checked exactly as written. */
      const tokens = new Set<string>();
      /** Tokens from a composed region, where not every string is a class. */
      const loose = new Set<string>();

      for (const raw of classAttrValues(code)) {
        // `${...}` holds an expression, not a class -- but a string literal
        // inside it (a fallback like `props.class ?? "bg-accent"`) is a class,
        // so harvest those before dropping the interpolation.
        //
        // They go to `loose`, not `tokens`: an interpolation is just as likely
        // to compare against a non-class string, and
        // `${configIssue() === "channel_invalid_coverage_required" ...}` in
        // tRadio's PageZones put exactly that in the report. Requiring utility
        // punctuation costs only a bare-word fallback like `?? "flex"`.
        const stripped = replaceInterpolations(raw, (expr) => {
          for (const s of expr.matchAll(NESTED_STRING)) {
            for (const t of tokenise(s[1] ?? "")) loose.add(t);
          }
        });
        for (const t of tokenise(stripped)) tokens.add(t);
      }

      for (const block of matchedBlocks(code, /classList\s*=\s*\{/g, "{", "}")) {
        for (const m of block.matchAll(CLASS_LIST_KEY)) {
          // A single key may still hold several classes: `"flex gap-2": cond`.
          for (const t of tokenise(m[1] ?? "")) tokens.add(t);
        }
      }

      const regions = wholeFile
        ? [code]
        : REGIONS.flatMap(({ opener, open, close, nestedObjects }) =>
            matchedBlocks(code, opener, open, close).map((block) =>
              blankComparisonOperands(
                blankDefaultVariants(
                  nestedObjects === "arguments" ? blankNestedObjects(block) : block,
                ),
              ),
            ),
          );
      for (const region of regions) {
        for (const m of region.matchAll(STRING_OR_KEY)) {
          if (m[3]) continue; // an object key -- a cva variant name, not a class
          const value = replaceInterpolations(m[2] ?? "", () => {});
          for (const t of tokenise(value)) (wholeFile ? tokens : loose).add(t);
        }
      }
      for (const t of loose) if (!tokens.has(t) && REPORTABLE.test(t)) tokens.add(t);

      for (const token of tokens) {
        if (MARKER_CLASSES.has(token) || NAMED_MARKER.test(token)) continue;
        if (declared.has(token) || isExtraAlive(token)) continue;
        if (scopedAlive.some((s) => path.includes(s.dir) && s.pattern.test(token))) continue;

        let alive = verdicts.get(token);
        if (alive === undefined) {
          alive = Boolean(await uno.parseToken(token));
          verdicts.set(token, alive);
        }
        if (alive) continue;

        const files = found.get(token) ?? new Set<string>();
        files.add(file);
        found.set(token, files);
      }
    }
  }

  return [...found]
    .map(([token, files]) => ({ token, files: [...files].sort() }))
    .sort((a, b) => a.token.localeCompare(b.token));
}

/**
 * The whole `check:classes` script: find, report, set the exit status.
 *
 * ── Why this is here and not copied into each bundle ──
 *
 * UnoCSS has no failure mode for a class it does not recognise — it emits
 * nothing, so a typo, or a spelling from the *other* preset, reads as perfectly
 * normal source and silently does nothing in the browser. That is what the
 * check exists for, and the three lines that turn `findDeadClasses` into a
 * usable gate (print, then exit non-zero on a finding) were copied verbatim
 * into seven bundles — five of them byte-identical files. Adding anything to
 * the protocol, a count or a machine-readable mode, meant seven edits.
 *
 * ── Why the caller constructs the generator ──
 *
 * `uno` is taken as an argument rather than built from a config here, and that
 * is load-bearing rather than tidiness. The point of the check is that it
 * reflects *the preset this bundle actually ships*: a generator built against
 * tLib's own `unocss` would answer for tLib's resolved version and tLib's
 * presets, not the consumer's. So `createGenerator` stays in the consumer,
 * beside the `uno.config.ts` it reads, and only the protocol is shared.
 *
 * `roots` defaults to `["src"]` because every caller passes exactly that; the
 * bundles that need more — tLib reaches into `shared/ts` for the stylesheets
 * that define its `mp-*` hooks, tRadio's dispatch panel excludes the theme
 * SDK's uncompiled starter template — pass their own options and explain why
 * at the call site, which is where that reasoning belongs.
 */
export async function runDeadClassCheck(
  options: Omit<DeadClassOptions, "roots"> & { roots?: string[] },
): Promise<void> {
  const dead = await findDeadClasses({ roots: ["src"], ...options });
  console.log(formatDeadClasses(dead));
  if (dead.length > 0) process.exit(1);
}

export function formatDeadClasses(dead: DeadClass[]): string {
  if (dead.length === 0) return "No dead utility classes.";
  const lines = dead.map(({ token, files }) => {
    const shown = files.map((file) => file.split(/[\\/]/).slice(-2).join("/"));
    const suffix = shown.length > 3 ? `, +${shown.length - 3} more` : "";
    return `  ${token.padEnd(46)} ${shown.slice(0, 3).join(", ")}${suffix}`;
  });
  return `${dead.length} class name(s) generate no CSS:\n\n${lines.join("\n")}`;
}
