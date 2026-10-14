/**
 * One UnoCSS preset for every bundle here, parameterised by dialect and tokens.
 *
 * `target: "nui"` is presetWind3 and `target: "web"` is presetWind4; the split is
 * permanent, because NUI runs in CEF 103 and Wind4's `color-mix`/`oklch` output is
 * dropped there as invalid — correct layout, no colour at all.
 *
 * Rationale for every option, the nui blocklist and what is deliberately absent:
 * docs/internal/uno-preset.md
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
   * How a colour token is spelled. Defaults to `"hsl-triplet"` for nui and
   * `"value"` for web, matching what each dialect's stylesheets declare. Passing
   * the wrong one produces no error and no colour.
   */
  colorSyntax?: "hsl-triplet" | "value";
  /**
   * Whether to define `bg-background` at all. Defaults to `target === "nui"`.
   * tRadio's dispatch panel opts out — its background is painted by the page.
   */
  backgroundRule?: boolean;
  /**
   * Whether to contribute the shared colour and radius tokens. On by default, and
   * a no-op on a bundle that names none of them.
   */
  sharedTokens?: boolean;
  /**
   * Presets inserted immediately after the dialect preset. That position is
   * load-bearing: a preset's theme merges over the ones before it, so moving it
   * changes generated CSS.
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
   * Whether `bg-background` also carries the compositor-effect variables. nui
   * only, and off by default since 0.12.1 — CEF does not composite a filtered
   * surface usefully, so it costs a pass per frame and shows nothing. A `web`
   * consumer passes this with `backgroundRule: true`.
   */
  backdropBackground?: boolean;
  /**
   * Keeps the elevation/translucency families on a `target: "nui"` bundle.
   *
   * One documented exception, not a switch: the single caller is tRadio's
   * dispatch panel, the only dual-home app, served to a real browser as well as
   * a CEF iframe. Do not reach for it to make a gate go green.
   */
  nuiElevationException?: boolean;
}

/**
 * The utility families a nui bundle may not contain at all: CEF does not composite
 * them, and UnoCSS's extractor cannot tell code from a comment, so prose naming one
 * is enough to emit the rule. Measured history and the per-bundle migration counts:
 * docs/internal/uno-preset.md. `bun run probe:focus` re-measures on demand.
 */
const NUI_BLOCKLIST = [
  // Elevation, in both namespaces, with or without a variant prefix.
  /(?:^|:)(?:drop-)?shadow(?:-|$)/,
  // The translucency effect, and the standalone chain that feeds it.
  /(?:^|:)backdrop-/,
  /(?:^|:)blur(?:-|$)/,
  // Focus, and every other hard edge, is an `outline`. Anchored, so the `ring`
  // COLOUR token survives -- `border-ring` and `outline-ring/40` are how the
  // settled spelling names its colour and must keep resolving.
  /(?:^|:)ring(?:-|$)/,
];

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
 * nui gets the three shadcn steps; web gets the full scale keyed off `--radius`, so
 * one token moves every corner. `full` is absent from both on purpose: a pill is a
 * shape, not a radius.
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
 * Nesting inverts both the theme merge and the rule sort, which drops `--radius`
 * from the output and stops the `bg-background` override winning — visible only in
 * the generated stylesheet, never in the config.
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
    backdropBackground = false,
    nuiElevationException = false,
  } = options;

  const presets: Preset[] = [target === "nui" ? unocss.presetWind3() : unocss.presetWind4()];
  presets.push(...extraPresets);
  if (attributify) presets.push(unocss.presetAttributify());
  if (typography) {
    presets.push(
      typeof typography === "object"
        ? unocss.presetTypography(typography as never)
        : unocss.presetTypography()
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
    // nui only: a web bundle runs in a real browser, which composites these fine.
    ...(target === "nui" && !nuiElevationException
      ? { blocklist: NUI_BLOCKLIST as Preset["blocklist"] }
      : {}),
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
 * Repaints presetTypography's prose defaults in the shadcn tokens. Without it a
 * dark theme gets dark body text on a dark surface, and only inside prose — which
 * reads as an MDX bug rather than a theme one. Opt-in: some consumers ship the
 * preset's own palette on purpose.
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
