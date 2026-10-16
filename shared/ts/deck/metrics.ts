/**
 * Type metrics for Stream Deck key art, and the text measurement built on them.
 *
 * Why this is shared
 *
 * tRadio, tELS and tRadar each drew their own deck keys from their own copy of a
 * render module. The copies agreed on the design language by convention and prose
 * comment only, so when two of these constants turned out to be WRONG the error
 * was sitting in three places at once and got fixed in one. This module exists so
 * that cannot happen again: the numbers below are measured, and they are measured
 * once.
 *
 * The measurement
 *
 * Taken with a canvas `measureText` probe in the same Chromium 103 build that
 * rasterises the keys, against the real {@link SANS} stack and the actual strings
 * the decks draw ("PD DISPATCH", "STANDING BY", "911 ACCEPT", "TAKEDOWN"). Not
 * derived from any family's nominal metrics, and emphatically not guessed — both
 * values here were previously guessed and both were wrong, in ways that produced
 * text clipped at the key edge and text sitting low inside its own background.
 *
 * Re-measure if the font stack changes. Nothing else in this package may invent
 * a type metric.
 */

/**
 * The legend face — a CONDENSED grotesque, not a UI font.
 *
 * A humanist interface face (Segoe UI and friends) is wide, round and
 * soft-cornered, drawn to be friendly in a dialog box. Equipment legends are the
 * opposite: narrow, flat-sided, tightly tracked, drawn to fit a long word onto a
 * small panel. Bahnschrift is Windows' DIN, which is what this kind of gear is
 * actually lettered in.
 *
 * The fallbacks matter because this is not only rendered on Windows — Stream Deck
 * runs on macOS too, so the chain goes Windows DIN → macOS DIN → the condensed
 * Helvetica/Arial both platforms have → a UI face last. Every entry is a SYSTEM
 * font. Nothing here ships a webfont, because a key image is rasterised by
 * whatever engine the host has and a missing webfont would silently reflow every
 * label on someone else's machine.
 */
export const SANS =
  "Bahnschrift, 'DIN Alternate', 'DIN Condensed', 'Helvetica Neue Condensed', " +
  "'HelveticaNeue-CondensedBold', 'Arial Narrow', 'Segoe UI', Helvetica, Arial, sans-serif";

/** For digits that must not reflow as they count — clocks, frequencies, speeds. */
export const MONO = "Consolas, 'SF Mono', 'Cascadia Code', monospace";

/**
 * Average advance per character, as a fraction of font-size.
 *
 * **Weight-independent, which is the surprise.** The estimator used to branch
 * `weight >= 700 ? 0.62 : 0.56`, on the reasonable assumption that a bolder face
 * is a wider one. Measured, Bahnschrift returns *the same* advance at 600, 700
 * and 800: it is a variable font whose weight axis does not change advance width,
 * and the renderer never synthesises a wider bold. So there is one number, and
 * branching on weight only introduced error.
 *
 * The error mattered. With the old factors a bold string was estimated 9% narrow
 * and a regular string 21% narrow, so a "shrink until it fits" routine believed
 * text fit when it did not: labels were sized too large, ran past their block and
 * off the key edge.
 */
export const PER_CHAR = 0.556;

/**
 * Cap height as a fraction of font-size (measured: 0.72; caps have ~0.01 descent,
 * i.e. none).
 *
 * Everything on a deck key is uppercase, so glyphs occupy `baseline - 0.72em` to
 * `baseline` and their optical centre is **0.36em above the baseline** — not at
 * it. Centring text in a filled block by putting its *baseline* at the block's
 * centre parks every word visibly low inside its own background. That was the
 * single most common misalignment across all three decks.
 */
export const CAP = 0.72;

/**
 * The baseline that optically centres uppercase text of `size` on `cy`.
 *
 * Use this any time text is drawn inside a shape. Never hand-tune a magic offset
 * — that is how `y - 1` and `y + h * 0.36` got into the original modules, and
 * each was correct at exactly one font size.
 */
export function capBaseline(cy: number, size: number): number {
  return cy + (size * CAP) / 2;
}

/**
 * Advance width of `text` at a given size and tracking, in px.
 *
 * `weight` is accepted and ignored — see {@link PER_CHAR}. It stays in the
 * signature because every caller passes the weight it is about to render at, and
 * dropping the parameter would quietly change what each call site means if the
 * face is ever swapped for one whose bold *is* wider.
 */
export function estimateWidth(
  text: string,
  size: number,
  _weight: number,
  tracking: number
): number {
  return text.length * size * PER_CHAR + Math.max(0, text.length - 1) * tracking;
}

/**
 * Cut `text` to at most `end` UTF-16 units without splitting a surrogate pair.
 *
 * A bare `slice` cuts between the two halves of an astral character and leaves a
 * LONE SURROGATE, which is not a legal XML character — so the key's SVG fails to
 * parse and the Stream Deck draws nothing at all. Not hypothetical: FiveM player
 * names carry emoji routinely, and a talker name is the one string on these keys
 * that is unsanitised human input long enough to need truncating.
 */
function sliceToUnits(text: string, end: number): string {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  // A high surrogate in the final slot means its pair is the character we are
  // about to cut off. Drop both.
  const cut = last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
  return text.slice(0, cut);
}

/** Binary-search the longest prefix (plus an ellipsis) that fits `maxWidth`. */
export function truncateToWidth(
  text: string,
  size: number,
  maxWidth: number,
  weight: number,
  tracking: number
): string {
  const ELLIPSIS = "…";
  if (!text.length) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = `${sliceToUnits(text, mid).trimEnd()}${ELLIPSIS}`;
    if (estimateWidth(candidate, size, weight, tracking) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const head = sliceToUnits(text, lo).trimEnd();
  return head ? `${head}${ELLIPSIS}` : ELLIPSIS;
}

/**
 * Shrink `size` until `text` fits `maxWidth`, then truncate if it still doesn't.
 *
 * Returned together because callers need both: the block around the text has to
 * be sized from the size that was actually chosen, not the one that was asked
 * for. Splitting these was how boxes and their contents drifted apart.
 *
 * `step` is the shrink increment, default 0.5. It is a parameter rather than a
 * constant because it is **visible in the output**: a 1px step lands on a
 * different size than a 0.5px one for the same string, so changing it silently
 * reflows every auto-sized label on a deck. Callers pass the step their key art
 * was designed and reviewed at.
 */
export function fitToWidth(
  text: string,
  opts: {
    max: number;
    min: number;
    maxWidth: number;
    weight: number;
    tracking: number;
    step?: number;
  }
): { text: string; size: number; width: number } {
  const step = opts.step ?? 0.5;
  let size = opts.max;
  while (size > opts.min && estimateWidth(text, size, opts.weight, opts.tracking) > opts.maxWidth) {
    size -= step;
  }
  const out =
    estimateWidth(text, size, opts.weight, opts.tracking) > opts.maxWidth
      ? truncateToWidth(text, size, opts.maxWidth, opts.weight, opts.tracking)
      : text;
  return { text: out, size, width: estimateWidth(out, size, opts.weight, opts.tracking) };
}

/**
 * Characters that are not legal anywhere in an XML 1.0 document, plus any
 * surrogate left unpaired.
 *
 * Escaping the five markup characters is not enough, because the failure mode of
 * the rest is total: an SVG carrying one C0 control or one lone surrogate does
 * not parse, so the Stream Deck draws an EMPTY key rather than a key with an odd
 * character in it. Everything these keys put on screen that a human typed — a
 * channel name out of a codeplug, a player's name off the wire — can contain
 * both, and neither is visible in the string that caused it.
 *
 * Tab, newline and carriage return are legal XML and are left alone; the text
 * primitives draw single lines, so they render as nothing rather than as damage.
 */
const XML_ILLEGAL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape text for inclusion in SVG markup. */
export function esc(s: string): string {
  return s
    .replace(XML_ILLEGAL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The horizontal centre for text drawn with letter-spacing.
 *
 * SVG adds the tracking after the LAST glyph as well, so a tracked string is that
 * much wider on its right than on its left and `text-anchor="middle"` puts it
 * half a gap left of where it looks like it should be. Small, and visible the
 * moment a tracked line sits above an untracked one.
 */
export function trackedCentre(centre: number, tracking: number): number {
  return centre + tracking / 2;
}

/** The drawn width of a tracked string — its advance less the trailing gap. */
export function trackedWidth(advance: number, tracking: number): number {
  return advance - tracking;
}
