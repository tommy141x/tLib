/**
 * One UnoCSS preset for every bundle here, parameterised by dialect and tokens.
 *
 * Eleven `uno.config.ts` files had grown into near-duplicates of each other: the
 * same shadcn colour map, the same `bg-background` rule, the same radius steps,
 * the same two transformers, each copied and then drifted. The drift is the
 * problem -- a component moved between projects renders differently for reasons
 * that are in a config file nobody opened.
 *
 * ## The dialect argument is not a version number
 *
 * `target: "nui"` means presetWind3 and `target: "web"` means presetWind4, and
 * the split is permanent rather than a migration in progress.
 *
 * A NUI page runs inside the game client's CEF, which is Chrome 103. Wind4
 * compiles every colour utility to `color-mix(in oklab, <colour>
 * var(--un-*-opacity), transparent)` and ships its default palette as `oklch()`
 * literals; both landed in Chromium 111, so CEF parses them as invalid and drops
 * the declaration. Layout utilities are unaffected, which is what makes the
 * failure confusing -- the UI renders with correct geometry and no colour at
 * all: transparent surfaces, `currentColor` borders, default-white text. Wind3
 * emits `rgb(... / var(--un-*-opacity))`, which CEF 103 understands.
 *
 * The same split decides how a colour token is spelled. A NUI stylesheet
 * declares `--background` as a bare HSL triplet so Wind3's alpha machinery can
 * compose it, and the theme therefore reads it as `hsl(var(--background))`. A
 * web stylesheet declares a complete colour and the theme reads
 * `var(--background)`. Getting this backwards is silent: every colour utility
 * resolves to an invalid value and is dropped.
 *
 * ## Why the caller passes its own `unocss`
 *
 * Measured across the eleven bundles, the installed unocss is 66.6.7, 66.7.4,
 * 66.7.5, 66.10.0, 66.10.4 or 66.10.5 depending on the project. If this module
 * imported `unocss` itself, every project's sub-presets would come from ONE
 * copy resolved next to this file while its `createGenerator` came from another
 * -- a second rule table, silently, in ten of the eleven. So the module is
 * handed the caller's own namespace import and builds the presets from that.
 * The `unocss` entry in this package is a peer/type dependency for exactly that
 * reason; nothing here may import it at runtime.
 *
 * ## What is deliberately NOT here
 *
 * `presetWebFonts`. It is the only thing that emits `@font-face`, and every face
 * it emitted was a `fonts.gstatic.com` URL -- a request a game client cannot
 * make, and one a web bundle should not make either. Faces are self-hosted
 * through `selfHostWebFonts` in this same directory. `theme.fontFamily` stays
 * with the consuming project because no two of them ship the same stack, and
 * `safelist` likewise: it is a statement about what one bundle renders
 * dynamically, and a shared one would be a list that only ever grows.
 */
import type { Preset } from "unocss";

export type TPresetTarget = "nui" | "web";

/** The parts of the `unocss` namespace this factory builds a preset out of. */
export interface UnocssModule {
  presetWind3: (...args: never[]) => Preset;
  presetWind4: (...args: never[]) => Preset;
  presetAttributify: (...args: never[]) => Preset;
  presetTypography: (...args: never[]) => Preset;
  transformerDirectives: (...args: never[]) => unknown;
  transformerVariantGroup: (...args: never[]) => unknown;
}

/** A colour value, or a `DEFAULT`/named family of them, as UnoCSS reads them. */
export type TColorValue = string | { [key: string]: TColorValue };

export interface TPresetTokens {
  /**
   * Extra colour families, merged over the shared shadcn set. Values are used
   * verbatim, so a project adding one spells it the way its own target does --
   * `hsl(var(--x))` for nui, `var(--x)` for web.
   */
  colors?: Record<string, TColorValue>;
  /** Replaces the target's default radius steps outright rather than merging. */
  borderRadius?: Record<string, string>;
  /** Named animations, for projects that ship their own `@keyframes`. */
  animation?: Record<string, string>;
}

export interface TPresetOptions {
  target: TPresetTarget;
  /** The caller's own `import * as unocss from "unocss"`. See the note above. */
  unocss: UnocssModule;
  tokens?: TPresetTokens;
  /**
   * How a colour token is spelled, when it is not the target's usual one.
   *
   * Defaults to `"hsl-triplet"` for nui and `"value"` for web, because that is
   * what each dialect's stylesheets declare. It is a separate axis rather than a
   * consequence of `target` because tRadio's dispatch panel is both: it is on
   * presetWind3 -- it renders inside a CEF iframe as well as a browser -- while
   * its `gen-admin-tokens.ts` emits complete colours, so it needs
   * `var(--border)` and not `hsl(var(--border))`. Passing the wrong one produces
   * no error and no colour.
   */
  colorSyntax?: "hsl-triplet" | "value";
  /**
   * Whether to define `bg-background` at all. Defaults to `target === "nui"`.
   *
   * The dispatch panel opts out: its background is painted by the page, not by a
   * utility, and it never declared `--background-opacity`.
   */
  backgroundRule?: boolean;
  /**
   * Whether to contribute the shared colour and radius tokens at all.
   *
   * On by default, and every consumer is now on it -- tDetector and tRadar
   * opted back in (82e322c, 8094116) ahead of adopting the shared prop editor,
   * whose components name shared tokens (`bg-card`, `text-muted-foreground`,
   * `border-border`) rather than the arbitrary values those two used to inline.
   *
   * Enabling it on a bundle that names no tokens is a no-op, which is why that
   * opt-in shipped with byte-identical CSS: UnoCSS only generates the names a
   * bundle actually references. The colour arrives with the components, not
   * with the flag.
   *
   * The historical objection -- that `rounded-sm` would be rewritten from the
   * preset's `0.125rem` to `calc(var(--radius) - 4px)` against an undeclared
   * `--radius`, invalidating the declaration and silently removing the corner
   * -- no longer applies: both bundles now `@import` tLib's
   * `shared/css/theme-tokens.css`, which declares `--radius` along with the
   * bare HSL triplets the `"hsl-triplet"` colour syntax expects.
   */
  sharedTokens?: boolean;
  /**
   * Presets inserted immediately after the dialect preset.
   *
   * That position, rather than the end, because it is where the projects that
   * need one already had it -- solid-starter and tg-new both run
   * `presetAnimations()` there -- and a preset's theme merges over the ones
   * before it. Moving it changes generated CSS.
   */
  extraPresets?: Preset[];
  /** Attribute-mode utilities. On by default; tDetector and tRadar had none. */
  attributify?: boolean;
  /**
   * Prose classes. On by default; pass an options object to extend them, e.g.
   * `{ cssExtend: PROSE_SHADCN_TOKENS }`.
   */
  typography?: boolean | Record<string, unknown>;
  /**
   * Whether `bg-background` also carries the backdrop-filter variables.
   *
   * nui only, and on by default. The NUI shells paint their panel background
   * through a blurred backdrop, driven by `--backdrop-blur`/`--backdrop-saturate`
   * so a layout can turn the blur off without restyling the surface. tAFK opts
   * out: it draws over a clear screen, where a backdrop filter costs a
   * compositing pass for nothing.
   */
  backdropBackground?: boolean;
}

/** The families every bundle here has, in both dialects, with no `-foreground`. */
const SHARED_COLORS = ["border", "input", "ring", "background", "foreground"] as const;

/** The families that also carry a `-foreground` pair. */
const SHARED_COLOR_PAIRS = [
  "primary",
  "secondary",
  "destructive",
  "muted",
  "accent",
  "popover",
  "card",
] as const;

function colorTree(syntax: "hsl-triplet" | "value"): Record<string, TColorValue> {
  const value = (token: string) =>
    syntax === "hsl-triplet" ? `hsl(var(--${token}))` : `var(--${token})`;
  const colors: Record<string, TColorValue> = {};
  for (const name of SHARED_COLORS) colors[name] = value(name);
  for (const name of SHARED_COLOR_PAIRS) {
    colors[name] = { DEFAULT: value(name), foreground: value(`${name}-foreground`) };
  }
  return colors;
}

/**
 * The radius steps.
 *
 * nui gets the three shadcn steps, which is what its components ask for. web
 * gets the full scale keyed off `--radius`, so one token moves every corner
 * rather than only the three named steps while bare `rounded` and `rounded-xl`
 * stay at the preset's fixed rem values. `full` is absent from both on purpose:
 * a pill is a shape, not a radius.
 */
function radiusSteps(target: TPresetTarget): Record<string, string> {
  if (target === "nui") {
    return {
      lg: "var(--radius)",
      md: "calc(var(--radius) - 2px)",
      sm: "calc(var(--radius) - 4px)",
    };
  }
  return {
    xs: "calc(var(--radius) * 0.25)",
    sm: "calc(var(--radius) * 0.5)",
    md: "calc(var(--radius) * 0.75)",
    lg: "var(--radius)",
    xl: "calc(var(--radius) * 1.5)",
    "2xl": "calc(var(--radius) * 2)",
    "3xl": "calc(var(--radius) * 3)",
    "4xl": "calc(var(--radius) * 4)",
  };
}

/**
 * Returns a LIST of presets, not one preset with the others nested inside it.
 *
 * Measured: nesting `presetWind3()` inside this preset inverted both orderings
 * that matter. A nested preset's theme merges OVER its parent's, so every
 * `rounded-*` utility came out at presetWind3's fixed rem values --
 * `border-radius:0.5rem` in place of `border-radius:var(--radius)` -- and the
 * whole `--radius` token stopped reaching the CSS. And a parent preset's rules
 * sort before its children's, so the `bg-background` override moved from the end
 * of the sheet to the start and stopped winning against the preset's own
 * `bg-*`. Both were visible in the generated stylesheet and neither would have
 * been visible in the config.
 *
 * As a flat list the shared entry comes last, which is where a config-level
 * `rules`/`theme` block sat before, and the output is byte-identical.
 */
export function tPreset(options: TPresetOptions): Preset[] {
  const {
    target,
    unocss,
    tokens = {},
    colorSyntax = target === "nui" ? "hsl-triplet" : "value",
    backgroundRule = target === "nui",
    sharedTokens = true,
    extraPresets = [],
    attributify = true,
    typography = true,
    backdropBackground = true,
  } = options;

  const presets: Preset[] = [target === "nui" ? unocss.presetWind3() : unocss.presetWind4()];
  presets.push(...extraPresets);
  if (attributify) presets.push(unocss.presetAttributify());
  if (typography) {
    presets.push(
      typeof typography === "object"
        ? unocss.presetTypography(typography as never)
        : unocss.presetTypography(),
    );
  }

  // nui only. Under Wind4 `bg-background` already resolves from theme.colors,
  // and overriding it here would drop the opacity machinery the web bundles use.
  const rules = backgroundRule
    ? [
        [
          "bg-background",
          {
            "background-color": "hsl(var(--background) / var(--background-opacity, 1))",
            ...(backdropBackground
              ? {
                  "backdrop-filter": "var(--backdrop-blur, none) var(--backdrop-saturate, none)",
                  "-webkit-backdrop-filter":
                    "var(--backdrop-blur, none) var(--backdrop-saturate, none)",
                }
              : {}),
          },
        ] as const,
      ]
    : [];

  presets.push({
    name: "@tlib/uno-preset",
    transformers: [
      unocss.transformerDirectives(),
      unocss.transformerVariantGroup(),
    ] as Preset["transformers"],
    rules: rules as unknown as Preset["rules"],
    theme: sharedTokens
      ? {
          colors: { ...colorTree(colorSyntax), ...tokens.colors },
          borderRadius: tokens.borderRadius ?? radiusSteps(target),
          ...(tokens.animation ? { animation: tokens.animation } : {}),
        }
      : {
          ...(tokens.colors ? { colors: tokens.colors } : {}),
          ...(tokens.borderRadius ? { borderRadius: tokens.borderRadius } : {}),
          ...(tokens.animation ? { animation: tokens.animation } : {}),
        },
  });
  return presets;
}

/**
 * Repaints presetTypography's prose defaults in the shadcn tokens.
 *
 * Without it `.prose` keeps the preset's own greys, which are fixed colours: a
 * dark theme gets dark body text on a dark surface, and only inside prose, so it
 * reads as an MDX bug rather than a theme one. Lives here because solid-starter
 * and tg-new had byte-identical copies of it, which is the drift this module
 * exists to prevent; it is opt-in rather than default because tWeb and
 * tgstudios-v2 ship the preset's own palette on purpose.
 */
export const PROSE_SHADCN_TOKENS = {
  "h1,h2,h3,h4,h5,h6,th": { color: "var(--foreground)" },
  "p,li,dt,dd": { color: "var(--foreground)" },
  a: { color: "var(--primary)" },
  strong: { color: "var(--foreground)" },
  em: { color: "inherit" },
  code: { color: "var(--foreground)" },
  pre: { "background-color": "var(--muted)" },
  blockquote: {
    "border-color": "var(--border)",
    color: "var(--muted-foreground)",
    "font-style": "italic",
  },
  "blockquote p": { color: "var(--muted-foreground)" },
  figcaption: { color: "var(--muted-foreground)" },
  hr: { "border-color": "var(--border)" },
  "thead th": { color: "var(--foreground)" },
  "tbody td": { color: "var(--foreground)" },
} as const;
