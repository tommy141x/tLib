/**
 * Theme-shipped fonts: emitting them, and refusing to let one go missing quietly.
 *
 * `./manifest.ts` is the on-disk CONTRACT — what a theme module may declare about
 * the fonts it carries. This file is the two things every consumer of that
 * contract needs and must not reimplement:
 *
 *   1. `themeFontFaceCss` — the `@font-face` text, so a theme's own faces
 *      register at runtime beside whatever the app bundles.
 *   2. `unresolvedFontFamilies` — the answer to "does this theme's font token
 *      name a family anything can actually resolve?"
 *
 * (2) exists because a font token is a STACK, and a stack has a built-in silent
 * failure: the browser walks it and uses the first family it can match, so naming
 * a family that is registered nowhere reports nothing anywhere -- no console
 * warning, no network error if there was no URL to fetch, no cue beyond the page
 * being in the wrong typeface.
 *
 * `document.fonts.status` CANNOT detect this, and it is the obvious thing to reach
 * for: measured, it reads `loaded` even when a face's URL 404s. The only sound
 * runtime check is a rendered-width comparison against the fallback, which is a
 * test harness's job. So this checks the DECLARATION instead.
 *
 * EVERY named family is checked, not just the first: a stack whose second entry
 * catches it still means the author believes the panel is in a typeface it is not.
 * Generic keywords are always resolvable by definition.
 */
import { MODULE_THEME_FONT_DIR, type ModuleThemeFont } from "./manifest.ts";

/**
 * The CSS generic font families, from css-fonts-4. A stack entry that is one of
 * these is resolved by the engine itself and is never a missing font.
 */
export const FONT_GENERIC_FAMILIES = [
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
] as const;

/** CSS family names match ASCII case-insensitively, and inner runs of space collapse. */
export function normalizeFontFamily(family: string): string {
  return family.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Split a font-stack value into its family names, quotes stripped.
 */
export function parseFontStack(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\" && i + 1 < value.length) {
        current += value[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);

  return out.map((f) => f.trim().replace(/\s+/g, " ")).filter((f) => f.length > 0);
}

/** True for a stack entry the engine resolves on its own. */
export function isGenericFontFamily(family: string): boolean {
  const n = normalizeFontFamily(family);
  return (FONT_GENERIC_FAMILIES as readonly string[]).some((g) => g === n);
}

/** The distinct families a set of declared faces provides. */
export function providedFontFamilies(fonts: readonly ModuleThemeFont[]): string[] {
  const seen = new Map<string, string>();
  for (const font of fonts) {
    const key = normalizeFontFamily(font.family);
    if (!seen.has(key)) seen.set(key, font.family);
  }
  return [...seen.values()];
}

export interface ThemeFontProblem {
  /** The font token whose value named it, e.g. `--font-sans`. */
  token: string;
  /** The family that nothing can resolve, as the theme spelled it. */
  family: string;
  /** The whole stack the token was set to, for the message. */
  stack: string;
}

/**
 * Every named family in `tokens` that neither the app nor the theme can resolve.
 *
 * @param tokens      font token name -> the stack it is set to
 * @param provided    families the THEME ships (`providedFontFamilies`)
 */
export function unresolvedFontFamilies(args: {
  tokens: Readonly<Record<string, string>>;
  provided: readonly string[];
  resolvable: readonly string[];
}): ThemeFontProblem[] {
  const known = new Set<string>();
  for (const f of args.provided) known.add(normalizeFontFamily(f));
  for (const f of args.resolvable) known.add(normalizeFontFamily(f));

  const problems: ThemeFontProblem[] = [];
  const reported = new Set<string>();

  for (const [token, stack] of Object.entries(args.tokens)) {
    if (typeof stack !== "string" || !stack.trim()) continue;
    for (const family of parseFontStack(stack)) {
      if (isGenericFontFamily(family)) continue;
      const key = normalizeFontFamily(family);
      if (known.has(key)) continue;
      const dedupe = `${token}|${key}`;
      if (reported.has(dedupe)) continue;
      reported.add(dedupe);
      problems.push({ token, family, stack });
    }
  }
  return problems;
}

/**
 * The one sentence every tier says, so four gates cannot describe one defect
 * four ways.
 */
export function themeFontProblemMessage(args: {
  themeName: string;
  themeId: string;
  problem: ThemeFontProblem;
  resolvable: readonly string[];
  provided: readonly string[];
}): string {
  const { problem } = args;
  const carried = args.resolvable.length ? args.resolvable.join(", ") : "none";
  const ships = args.provided.length
    ? `ships ${args.provided.join(", ")}`
    : "ships no fonts of its own";
  return (
    `theme "${args.themeName}" (${args.themeId}): ${problem.token} is ` +
    `${JSON.stringify(problem.stack)}, and the font family ${JSON.stringify(problem.family)} is ` +
    `resolvable nowhere — the app carries ${carried}, and this theme ${ships}. ` +
    `Nothing will report this at render time: the browser walks the stack and ` +
    `silently paints the first family it CAN match, so the panel renders in the ` +
    `wrong typeface and looks like it is working. Fix it either way round — put ` +
    `the .woff2 and its licence in the theme's ${MODULE_THEME_FONT_DIR}/ directory ` +
    `and declare it in module.json under theme.fonts, or name a family the app ` +
    `already carries.`
  );
}

/**
 * `@font-face` rules for a theme's declared faces.
 *
 * @param baseUrl  where the theme's `fonts/` directory is served from, WITHOUT
 *                 a trailing slash. A URL the consumer computes, because only it
 *                 knows how its theme modules are served.
 *
 * Three fixed choices, all deliberate:
 *
 *   · `font-display: swap`. The point of shipping a font is that the text is in
 *     it; `block` would hide the panel's text for up to 3s on a cold load, and
 *     `optional` would let the browser decide not to use the theme's font at all
 *     on a slow connection — a silent wrong typeface, which is the bug.
 *   · no `unicode-range`. Subsetting is a CDN byte optimisation; these bytes come
 *     off the operator's own disk on the same origin as the panel.
 *   · the family is quoted and the filename URL-encoded. The family is validated
 *     against `FONT_FAMILY_FORBIDDEN` at manifest level, so this is belt-and-
 *     braces for a face that reached here without passing through that.
 */
export function themeFontFaceCss(baseUrl: string, fonts: readonly ModuleThemeFont[]): string {
  const base = baseUrl.replace(/\/+$/, "");
  return fonts
    .map((font) => {
      const url = `${base}/${MODULE_THEME_FONT_DIR}/${encodeURIComponent(font.file)}`;
      return [
        "@font-face {",
        `  font-family: "${font.family.replace(/["\\]/g, "")}";`,
        `  font-style: ${font.style ?? "normal"};`,
        `  font-weight: ${font.weight ?? "400"};`,
        "  font-display: swap;",
        `  src: url("${url}") format("woff2");`,
        "}",
      ].join("\n");
    })
    .join("\n\n");
}
