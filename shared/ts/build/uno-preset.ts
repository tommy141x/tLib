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
   * Whether `bg-background` also carries the compositor-effect variables.
   *
   * nui only, and **off** by default since 0.12.1.
   *
   * It used to default ON, with a doc claiming the NUI shells painted their
   * panel background through a filtered backdrop. They do not. Every shell here
   * paints an opaque `--card` fill behind a `--border` edge -- that is the whole
   * recipe written down in `shared/css/surface.css`, and the reason is in the
   * same file: FiveM's CEF does not composite a filtered surface usefully, so
   * it costs a compositor pass per frame over a moving 3D scene and puts
   * nothing on the screen. tAFK was recorded as "the one that opts out, for a
   * performance reason"; it was in fact the only bundle whose config agreed with
   * the policy.
   *
   * So the default is now the policy, and the flag is the deviation. A `web`
   * consumer that genuinely wants it -- a real browser DOES composite this --
   * passes `backdropBackground: true` together with `backgroundRule: true`.
   */
  backdropBackground?: boolean;
  /**
   * Keeps the elevation/translucency families on a `target: "nui"` bundle.
   *
   * **This is ONE documented exception, not a switch.** Nine bundles build with
   * `target: "nui"` and eight of them must keep the ban non-negotiable: for them
   * these families are bytes that paint nothing, and the extractor reading a
   * COMMENT about one is enough to emit it (see `NUI_BLOCKLIST`). Do not reach
   * for this flag to make a gate go green.
   *
   * The one caller is `tRadio/server/web`, the dispatch panel -- the only
   * DUAL-HOME app here. It is served to a real browser AND embedded in a CEF
   * iframe in game, and it is on `target: "nui"` for the Wind3 reason recorded
   * in its own config (CEF 103 drops `color-mix`/`oklch`), not because NUI is
   * its only home. In the browser half these families composite properly and
   * the design uses them: translucent modal scrims, raised modal/toast edges,
   * and the deliberate indicator glows in `DispatchSidebar`, `Zone` and `User`.
   *
   * Accepted cost: in the CEF half they still will not paint. They are carried
   * for the browser audience, and the game half simply renders the flat surface
   * underneath -- which is the same recipe every other bundle ships.
   */
  nuiElevationException?: boolean;
}

/**
 * The utility families a nui bundle may not contain, at all.
 *
 * Promoted out of `tUnit/client/web/uno.config.ts`, which had worked out the
 * whole argument and then applied it to one bundle of nine.
 *
 * Two separate reasons, and the second is the one that makes this a build rule
 * rather than a review note:
 *
 *  1. CEF does not composite elevation or a translucency effect usefully. The
 *     measurement is in `shared/css/surface.css`; the short version is that a
 *     24px-radius elevation over a moving 3D scene costs a compositor pass every
 *     frame and buys nothing visible, and that every focus affordance in this
 *     stack is therefore an `outline`.
 *
 *  2. UnoCSS's extractor reads raw file text and cannot tell code from a
 *     COMMENT, so a sentence that NAMES one of these utilities in order to
 *     explain why it was removed is itself enough to emit the rule. Measured in
 *     the built stylesheets before this landed: `.shadow`, `.shadow-sm`,
 *     `.shadow-md`, `.shadow-lg` and `.blur` were present in bundles whose
 *     source contained no such class -- only prose about one. That is dead CSS
 *     rather than a visible defect, which is worse: it defeats the one check
 *     anybody runs on a built file ("search the CSS for a blurred box-shadow")
 *     and makes it cry wolf until someone stops running it.
 *
 * Each entry allows an arbitrary variant prefix (`hover:`, `group-focus:`,
 * `lg:`), because a variant is part of the raw candidate the blocklist is
 * matched against and a prefixed spelling is otherwise waved straight through.
 *
 * `ring-*` is here as of 2026-10-05, and the delay before adding it was the
 * whole point rather than an oversight. UnoCSS composes `box-shadow` out of
 * `var(--un-ring-offset-shadow), var(--un-ring-shadow), var(--un-shadow)` and
 * only the last of the three is the blurred one, so a ring is not elevation --
 * but under presetWind3 it is still a `box-shadow`, and a box-shadow painted
 * outward from an element that fills an `overflow: hidden` ancestor is clipped
 * to nothing. MEASURED in Chromium 103 by `scripts/probe-focus-paint.ts`: in
 * that geometry the outward box-shadow a `ring-2` compiles to paints 0 accent
 * pixels, and so does the same outline pushed to a POSITIVE offset, while the
 * outline at `-1px` paints 404. The fix is therefore to make focus an outline,
 * which `shared/ts/ui/*` already was.
 *
 * Blocking this list before the consumers that still spelt focus with a ring
 * had followed would have DELETED their focus indication rather than corrected
 * it, so it waited for them. The condition was a count, not a date:
 *
 *                      2026-10-05 before   after
 *   tRadio/server/web           ~37          1   (exempt; see below)
 *   tELS/client/web             ~17          0
 *   tAFK/client/web             ~16          0
 *   tRadio/client/web             4          0   (already 0 when re-counted)
 *   tCAD/client/web               2          0
 *   tLib, tUnit, tDetector, tRadar: none throughout
 *
 * Counted with `(?<![\w-])ring-[a-z0-9/.\[\]#%+-]+` over `.ts`/`.tsx`/`.css`,
 * which excludes prose and the `ring` COLOUR token (`border-ring`,
 * `outline-ring/40`) exactly as an anchored `(?:^|:)ring(?:-|$)` would. All four
 * blocklisted bundles are at zero and every migrated affordance is proven to
 * paint; `bun run probe:focus` re-measures all ten on demand.
 *
 * ⚠️ `tRadio/server/web`'s residual 1 is `components/CallQueue.tsx`, deliberately
 * not migrated with the rest: that file was checked out and in flight in another
 * session. It does not matter here, because that bundle is the only DUAL-HOME app
 * -- a CEF iframe AND a real browser, where its elevation genuinely composites --
 * and it is the single caller of `nuiElevationException`, which exempts it from
 * this list entirely. See that option's doc. Everything else in it was migrated
 * anyway, and for a reason worth keeping: in the CEF half a ring there was
 * clipped just as it is anywhere else, and its Ark `Switch.Control` spelt focus
 * `focus-visible:` on a part that is a div and is never the focused element, so
 * that control had no focus affordance in EITHER home.
 *
 * A side effect worth knowing: the anchored pattern also matches a BARE `ring`,
 * which is what the extractor emits for the English word in a comment. Nothing
 * uses `ring` as a utility, and `.ring` was measurably present in tCAD's built
 * sheet from the phrase "a managed focus ring" alone -- so that is reason 2
 * above, caught rather than conceded.
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
    // nui only. A web bundle runs in a real browser, which composites all three
    // families perfectly well; the ban is a CEF fact, not a taste.
    //
    // `nuiElevationException` is the single dual-home carve-out documented on the
    // option itself -- tRadio's dispatch panel, which is on this target for the
    // Wind3 reason and is also served to a browser. Eight other nui bundles pass
    // nothing here and keep the ban.
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
