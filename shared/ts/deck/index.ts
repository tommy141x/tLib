/**
 * Shared Stream Deck key art — the drawing language behind tRadio, tELS and tRadar.
 *
 * What this package owns, and what it does not
 *
 * It owns **how things are drawn**: the measured type metrics, the vertical
 * rhythm, what an inverted field is, how a chip row lays out, how a meter
 * segments, where a box sits relative to a baseline. Get those wrong in one place
 * and all three decks are wrong the same way, which is the point — they were
 * previously wrong in three places independently.
 *
 * It does **not** own what a key means. State colours, which flags a product
 * shows and what its keys say all stay with the product. tELS is a lightbar,
 * tRadar is a radar gun and tRadio is a radio; they should share a material, not
 * a vocabulary. The seam is {@link Surface} (structural greys only) plus a colour
 * argument on every primitive that expresses a state.
 *
 * It owns **the material itself** — `material.ts`. That sentence above was true
 * of the drawing but not of the greys: the fourteen structural values were
 * measured byte-identical in all three products and duplicated anyway, so they
 * now live here, and {@link bindKey} supplies the {@link Surface} the primitives
 * all take as argument one. What a product still writes for itself is its state
 * colours, its exceptional washes, and how its own cards are composed.
 *
 * Consuming it
 *
 * The three `.sdPlugin` builds are deliberately hermetic — no workspace, file: or
 * link: dependencies, so each one can be zipped and handed to Elgato's packager on
 * a machine that has never seen this monorepo. They therefore consume a **vendored
 * copy** written by each repo's `deck-render:sync` script, with `deck-render:check`
 * proving byte-for-byte that the copy still matches this source. Everything else
 * in-tree can import `@tlib/shared/deck` directly.
 *
 * Where to start
 *
 * `card(theme, spec)` composes a key; `stripCard(theme, spec)` composes a Stream
 * Deck+ encoder cell. Reach for the primitives below only when a key needs
 * something the card does not offer — and when it does, prefer adding to the card
 * over hand-placing a shape in an action, because hand-placed shapes are how the
 * three copies drifted in the first place.
 */

export {
  BAND,
  bandCentre,
  type CardSpec,
  type CardTheme,
  capBaseline,
  card,
  centreX,
  HERO,
  type Hero,
  hairline,
  hero,
  heroCentre,
  keyDoc,
  offlineCard,
  type Shell,
} from "./card.ts";
export {
  chevron,
  type GlyphSpec,
  glyphRow,
  invertField,
  type LedSpec,
  ledRow,
  stateRule,
  stepRow,
  unlitField,
} from "./marks.ts";
export {
  type BindOptions,
  type BoundKey,
  bindKey,
  type KeyMaterial,
  LCD_MATERIAL,
  materialInk,
  materialShell,
} from "./material.ts";
export {
  levelBar,
  SIGNAL_GEOM_ROW,
  type SignalGeom,
  signalBars,
  signalBarsWidth,
  sweepBar,
} from "./meters.ts";
export {
  CAP,
  esc,
  estimateWidth,
  fitToWidth,
  MONO,
  PER_CHAR,
  SANS,
  trackedCentre,
  trackedWidth,
  truncateToWidth,
} from "./metrics.ts";
export {
  offlineStrip,
  STRIP_BAND,
  type StripSpec,
  type StripTheme,
  stripCard,
  stripDoc,
} from "./strip.ts";
export {
  contentWidth,
  KEY_SIZE,
  keySurface,
  STRIP_CELL,
  type Surface,
  type SurfaceInk,
  stripSurface,
} from "./surface.ts";
export { fitText, label, legend, valueWithUnit } from "./text.ts";
