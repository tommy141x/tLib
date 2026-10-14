/**
 * The module material, and the one place a product binds itself to it.
 * Fourteen values were byte-identical across all three products' `render.ts` and
 * every one of them is structural -- the glass, the bezel, the unlit segment, the
 * four inks. Every value that DIFFERED was a state colour, i.e. a meaning, so
 * those stay with the product and are passed at the call site.
 * The greys are TRUE greys, R = G = B, no exceptions: an earlier olive/phosphor
 * cast read as a display but put a green tinge over every key including ones with
 * no state at all. Colour appears ONLY as state, and in instrument colours rather
 * than web ones -- a deck sits in peripheral vision, where a saturated hue reads
 * as an alert whether or not anything is wrong.
 * The canvas is 144x144 but a key is 72x72 PHYSICAL, so everything is downscaled
 * 2:1 before a human sees it. What survives is one big thing, one medium thing,
 * one small thing; that is the whole information budget of a key.
 */

import {
  BAND,
  type CardSpec,
  type CardTheme,
  card as drawCard,
  hero as drawHero,
  type Hero,
  keyDoc,
  type Shell,
} from "./card.ts";
import {
  glyphRow as drawGlyphRow,
  invertField as drawInvertField,
  ledRow as drawLedRow,
  stateRule as drawStateRule,
  stepRow as drawStepRow,
  unlitField as drawUnlitField,
  type GlyphSpec,
  hairline,
  type LedSpec,
} from "./marks.ts";
import {
  levelBar as drawLevelBar,
  signalBars as drawSignalBars,
  sweepBar as drawSweepBar,
  type SignalGeom,
} from "./meters.ts";
import { keySurface, type Surface, type SurfaceInk } from "./surface.ts";
import { fitText as drawFitText, label as drawLabel, legend as drawLegend } from "./text.ts";

/**
 * The structural greys of one recessed LCD module.
 */
export interface KeyMaterial {
  /** Glass base. The gradient in {@link keyDoc} does the real work; this is its floor. */
  bg: string;
  /** An unpowered module — no backlight behind the glass. */
  bgOff: string;
  /** Alarm wash behind the glass. */
  bgWarn: string;
  /** Unlit segment fill — a dark block that is present but not energised. */
  card: string;
  /** Text knocked out of a lit field. Near-black so it survives any backlight. */
  ink: string;
  /** Ink — primary. */
  text: string;
  /** Ink — secondary. */
  dim: string;
  /** Unlit / disabled / off-segment ink. */
  faint: string;
  /** Idle / inactive chrome — a state rule with nothing to say. */
  idle: string;
  /** The black surround. */
  bezel: string;
  /** Top of the glass gradient — a true grey, no cast. */
  glassTop: string;
  /** Recess lip and outer edge stroke. */
  edge: string;
  /** Tint applied to the glass top stop under a warning. */
  warnTop: string;
  /** Brighter ink, for the one line on a key that is the answer. Neutral white. */
  inkHi: string;
}

/** The material all three products measured identically. See the header. */
export const LCD_MATERIAL: KeyMaterial = {
  bg: "#090909",
  bgOff: "#060606",
  bgWarn: "#190a08",
  card: "#242424",
  ink: "#0d0d0d",
  text: "#d2d2d2",
  dim: "#8a8a8a",
  faint: "#4a4a4a",
  idle: "#3a3a3a",
  bezel: "#070707",
  glassTop: "#171717",
  edge: "#2b2b2b",
  warnTop: "#26100c",
  inkHi: "#f4f4f4",
};

/**
 * The structural half of a material, in {@link keySurface}'s terms.
 */
export function materialInk(m: KeyMaterial): SurfaceInk {
  return { ink: m.ink, card: m.card, text: m.text, faint: m.faint, edge: m.edge };
}

/** The module shell, in {@link keyDoc}'s terms. */
export function materialShell(m: KeyMaterial): Shell {
  return { bezel: m.bezel, glassTop: m.glassTop, bg: m.bg, edge: m.edge };
}

/** What a product tells {@link bindKey} about itself. Exactly the two things that varied. */
export interface BindOptions {
  /**
   * The product's accent — the chevron on a stepping hero, and `markColor` on
   * the card theme. A state colour, which is why it is an argument.
   */
  accent: string;
  /**
   * The glass top stop that goes with a given floor.
   */
  glassTop?: (bg: string) => string;
}

/** The primitives of this package, already bound to one product's surface. */
export interface BoundKey {
  /** The surface every bound primitive draws onto. */
  surface: Surface;
  /** The shell {@link BoundKey.svg} wraps a body in. */
  shell: Shell;
  /** The material this was bound to. */
  material: KeyMaterial;
  /** The glass top stop for a floor — {@link BindOptions.glassTop}, resolved. */
  glassTopFor: (bg: string) => string;

  /**
   * Wrap raw SVG body into a full document + data URI.
   */
  svg: (body: string, bg?: string) => string;

  /** Centred free text that shrinks to fit, then truncates. `y` is a BASELINE. */
  fitText: (
    text: string,
    opts: {
      y: number;
      max: number;
      min?: number;
      weight?: number;
      fill?: string;
      maxWidth?: number;
      mono?: boolean;
    }
  ) => string;

  /**
   * A small uppercase tracked caption — the band naming what a key IS.
   */
  label: (text: string, y: number, fill?: string, opts?: { maxWidth?: number }) => string;

  /**
   * A machine word, in the panel's own voice — "ON", "LOCKED", "STAGE 2".
   *
   * Uppercase, always. Equipment legends are uppercase, and all three decks had
   * drifted into drawing "on", "hold" and "press → select" in lowercase next to
   * keys saying "OFF" — which is what makes the lowercase ones read as leftover
   * placeholder text rather than as part of the panel.
   */
  legend: (
    text: string,
    y: number,
    fill?: string,
    opts?: { max?: number; min?: number; maxWidth?: number }
  ) => string;

  /**
   */
  stateRule: (fillColor: string, y?: number) => string;

  /**
   * An inverted LCD field: a filled block with the text knocked out of it.
   *
   * **The load-bearing primitive of this design.** A real segment LCD cannot tint
   * a word — it has no per-glyph colour, only lit and unlit segments — so it shows
   * an active state by *inverting the field*. That is why a latched key reads as
   * hardware and a coloured word reads as a game, and why it survives the 2:1
   * downscale as a shape where a tinted word turns to smear. Reach for it before
   * reaching for a fill colour.
   */
  invertField: (
    text: string,
    opts: {
      cy: number;
      fill: string;
      size?: number;
      track?: number;
      ink?: string;
      padX?: number;
      height?: number;
      maxWidth?: number;
      upper?: boolean;
    }
  ) => string;

  /** The unlit twin of {@link BoundKey.invertField} — same box, outline instead of fill. */
  unlitField: (
    text: string,
    opts: {
      cy: number;
      size?: number;
      track?: number;
      padX?: number;
      height?: number;
      fill?: string;
      maxWidth?: number;
    }
  ) => string;

  /** A row of small indicator lamps for boolean flags. */
  ledRow: (items: LedSpec[], x: number, y: number, spacing?: number, r?: number) => string;

  /** The flag row across the top of the card, drawn as lit/unlit segment chips. */
  glyphRow: (items: GlyphSpec[], y?: number, bounds?: { left?: number; right?: number }) => string;

  /** The hairline a segment LCD puts under its flag row. */
  glyphRule: (y?: number) => string;

  /**
   * A caption with a chevron beside it, laid out as ONE centred group.
   */
  stepRow: (
    text: string,
    opts: {
      dir: "left" | "right" | "up" | "down";
      cy: number;
      max?: number;
      min?: number;
      fill?: string;
      markFill?: string;
      maxWidth?: number;
    }
  ) => string;

  /** Draw a {@link Hero} at the hero baseline. Never overflows the canvas. */
  hero: (spec: Hero, fill?: string, maxWidth?: number) => string;

  /**
   * A segmented 0–1 meter — the LCD's way of showing a continuous value.
   *
   * Segments, not a filled pill. A smooth bar is the one shape on a deck that
   * cannot be made to look like equipment: real panel meters are discrete, and at
   * 72px a rounded gradient bar is the thing that most reads as a web progress
   * indicator. `y` is the bar's BOTTOM edge.
   */
  levelBar: (
    value: number,
    opts: {
      y: number;
      x?: number;
      width?: number;
      count?: number;
      fill: string;
      height?: number;
    }
  ) => string;

  /**
   * A scanner's channel-sweep bar: a row of segments with the swept position lit.
   *
   * `active` is the lit segment index, or `null` for a sweep that is genuinely off.
   */
  sweepBar: (
    active: number | null,
    opts: {
      y: number;
      x?: number;
      width?: number;
      count?: number;
      fill: string;
      height?: number;
    }
  ) => string;

  /** Signal-strength bars, or nothing when hidden. */
  signalBars: (level: number, x: number, y: number, on: string, g?: SignalGeom) => string;

  /**
   * The card theme for this material, with the product's accent already in it.
   *
   * `over` is for an exceptional state that recolours the card without touching
   * its geometry — pass `undefined` for any field to keep the default.
   */
  theme: (over?: { inkHi?: string; markColor?: string; stateInk?: string }) => CardTheme;

  /**
   * The one card a product's deck keys are built from.
   *
   * Owning the geometry here rather than in each action is what keeps a dozen keys
   * looking like one product. Actions choose content and colour; they do not
   * choose where the hero sits. `bg` defaults to the glass floor and brings its
   * own top stop.
   */
  card: (theme: CardTheme, spec: Omit<CardSpec, "bgTop"> & { bg?: string }) => string;
}

/**
 * Bind every primitive in this package to one product's material.
 *
 * The returned functions close over a single {@link Surface}. That is the
 * point — a product has exactly one key geometry — but it means the Stream
 * Deck+ touch strip, which is the same instrument at a different aspect ratio,
 * needs its own binding off `stripSurface` rather than this one. Reuse
 * {@link BoundKey.material} for it; a second copy of the palette for the strip
 * is how the strip came to look like a different product in the first place.
 */
export function bindKey(m: KeyMaterial, opts: BindOptions): BoundKey {
  const surface = keySurface(materialInk(m));
  const shell = materialShell(m);
  const glassTopFor = opts.glassTop ?? ((bg: string) => (bg === m.bgWarn ? m.warnTop : m.glassTop));

  const svg = (body: string, bg: string = m.bg): string =>
    keyDoc(surface, shell, body, { bg, top: glassTopFor(bg) });

  const theme: BoundKey["theme"] = (over = {}) => ({
    surface,
    shell,
    idle: m.idle,
    inkHi: over.inkHi ?? m.inkHi,
    dim: m.dim,
    markColor: over.markColor ?? opts.accent,
    stateInk: over.stateInk ?? m.text,
  });

  return {
    surface,
    shell,
    material: m,
    glassTopFor,
    svg,
    fitText: (text, o) => drawFitText(surface, text, o),
    label: (text, y, fill = m.dim, o = {}) => drawLabel(surface, text, y, fill, o),
    legend: (text, y, fill = m.dim, o = {}) => drawLegend(surface, text, y, fill, o),
    stateRule: (fillColor, y = 30) => drawStateRule(surface, fillColor, y, m.idle),
    invertField: (text, o) => drawInvertField(surface, text, o),
    unlitField: (text, o) => drawUnlitField(surface, text, o),
    ledRow: (items, x, y, spacing = 20, r = 7) => drawLedRow(surface, items, x, y, spacing, r),
    glyphRow: (items, y = BAND.glyphs, bounds = {}) => drawGlyphRow(surface, items, y, bounds),
    glyphRule: (y = BAND.glyphs) => hairline(surface, y + 8),
    stepRow: (text, o) =>
      drawStepRow(surface, text, {
        ...o,
        fill: o.fill ?? m.inkHi,
        markFill: o.markFill ?? opts.accent,
      }),
    hero: (spec, fill = m.inkHi, maxWidth = surface.width - 24) =>
      drawHero(surface, spec, fill, { maxWidth }),
    levelBar: (value, o) => drawLevelBar(surface, value, o),
    sweepBar: (active, o) => drawSweepBar(surface, active, o),
    signalBars: (level, x, y, on, g = {}) => drawSignalBars(surface, level, x, y, on, g),
    theme,
    card: (t, spec) => {
      const bg = spec.bg ?? m.bg;
      return drawCard(t, { ...spec, bg, bgTop: glassTopFor(bg) });
    },
  };
}
