/**
 * Text primitives for deck key art.
 *
 * Three ways to put words on a key, and choosing between them is a content
 * decision, not a styling one:
 *
 *   - {@link fitText} — free text whose case belongs to a human. Channel names,
 *     talker names, unit callsigns, codeplug legends. Shrinks, then ellipsises.
 *   - {@link legend} — a machine word the product is saying. "SCANNING", "HOLD",
 *     "NO LINK". Always uppercased, always tracked. Never route user content
 *     through this: forcing a player's channel name to caps is the product
 *     shouting their own data back at them.
 *   - {@link label} — a small tracked caption above the primary value.
 *
 * Nothing here can render past the surface edge. Every function measures with
 * {@link fitToWidth} and truncates rather than overflowing.
 */

import { esc, estimateWidth, fitToWidth, MONO, SANS, trackedCentre } from "./metrics.ts";
import { centreX, contentWidth, type Surface } from "./surface.ts";

/**
 * A centred, auto-shrinking, hard-truncating line of free text.
 *
 * `y` is a BASELINE. For text that sits inside a box, do not use this — use the
 * box primitive, which centres its contents on a cap-centre. Mixing the two is
 * what put words low in their own backgrounds.
 *
 * The defaults (weight 600, min 12, 1px shrink step) are the reference
 * implementation's, not an opinion — they are what the reviewed tRadio key art
 * was drawn at, and changing any of them reflows labels on a shipped deck.
 */
export function fitText(
  s: Surface,
  text: string,
  opts: {
    y: number;
    max: number;
    min?: number;
    weight?: number;
    fill?: string;
    maxWidth?: number;
    mono?: boolean;
    step?: number;
  }
): string {
  const weight = opts.weight ?? 600;
  const maxWidth = opts.maxWidth ?? contentWidth(s);
  const raw = String(text ?? "");
  const fitted = fitToWidth(raw, {
    max: opts.max,
    min: opts.min ?? 12,
    maxWidth,
    weight,
    tracking: 0,
    step: opts.step ?? 1,
  });
  return (
    `<text x="${centreX(s)}" y="${opts.y}" text-anchor="middle" ` +
    `font-family="${opts.mono ? MONO : SANS}" font-size="${fitted.size}" ` +
    `font-weight="${weight}" fill="${opts.fill ?? s.text}">${esc(fitted.text)}</text>`
  );
}

/**
 * A small tracked caption. `y` is a baseline.
 *
 * Uppercased, because this band names a grouping the product chose — a zone, a
 * bank, a band — rather than anything a player typed.
 */
export function label(
  s: Surface,
  text: string,
  y: number,
  fill?: string,
  opts: { maxWidth?: number } = {}
): string {
  const weight = 700;
  const tracking = 1.6;
  const maxWidth = opts.maxWidth ?? contentWidth(s) - 4;
  const fitted = fitToWidth(String(text ?? "").toUpperCase(), {
    max: 14,
    min: 10,
    maxWidth,
    weight,
    tracking,
  });
  return (
    `<text x="${trackedCentre(centreX(s), tracking)}" y="${y}" text-anchor="middle" ` +
    `font-family="${SANS}" font-size="${fitted.size}" font-weight="${weight}" ` +
    `letter-spacing="${tracking}" fill="${fill ?? s.faint}">${esc(fitted.text)}</text>`
  );
}

/**
 * A machine word, in the panel's own voice. `y` is a baseline.
 *
 * Always uppercase. The decks had drifted into drawing "Scanning" next to "TX" on
 * the same band, which reads as app copy rather than as an instrument legend —
 * and the mixed case was only ever visible next to its all-caps neighbours, which
 * is to say never in isolation and always on the assembled deck.
 *
 * **User content must not go through this.** A channel or talker name keeps the
 * case its author typed; use {@link fitText}.
 */
export function legend(
  s: Surface,
  text: string,
  y: number,
  fill?: string,
  opts: { max?: number; min?: number; maxWidth?: number } = {}
): string {
  const weight = 700;
  const tracking = 1.2;
  const maxWidth = opts.maxWidth ?? contentWidth(s) - 2;
  const fitted = fitToWidth(String(text ?? "").toUpperCase(), {
    max: opts.max ?? 15,
    min: opts.min ?? 10,
    maxWidth,
    weight,
    tracking,
  });
  return (
    `<text x="${trackedCentre(centreX(s), tracking)}" y="${y}" text-anchor="middle" ` +
    `font-family="${SANS}" font-size="${fitted.size}" font-weight="${weight}" ` +
    `letter-spacing="${tracking}" fill="${fill ?? s.faint}">${esc(fitted.text)}</text>`
  );
}

/**
 * A measured value with an optional unit, laid out as one centred group.
 *
 * The unit rides small and the number stays big. Shrinking a speed because "MPH"
 * was appended makes the part the user actually reads smaller in order to protect
 * the part they don't — which is why this is a separate primitive from
 * {@link fitText} rather than a string concatenation at the call site.
 */
export function valueWithUnit(
  s: Surface,
  value: string,
  unit: string | undefined,
  opts: {
    y: number;
    max: number;
    min?: number;
    fill?: string;
    unitFill?: string;
    mono?: boolean;
    /** Unit size in px. FIXED, not a fraction of the value — see below. */
    unitSize?: number;
    maxWidth?: number;
  }
): string {
  const weight = 700;
  const family = opts.mono ? MONO : SANS;
  const maxWidth = opts.maxWidth ?? contentWidth(s);
  const min = opts.min ?? 14;
  const raw = String(value ?? "");
  if (!unit) {
    return fitText(s, raw, {
      y: opts.y,
      max: opts.max,
      min,
      weight,
      fill: opts.fill,
      mono: opts.mono,
      maxWidth,
    });
  }

  const unitTrack = 0.8;
  const gap = 6;
  // The unit is a FIXED size, deliberately. Scaling it with the value means a
  // long reading shrinks its own unit out of legibility at exactly the moment
  // the key is busiest — and the unit is three letters that have to stay
  // readable at 72px whatever the number beside them is doing.
  const unitSize = opts.unitSize ?? 14;
  // The unit's share is reserved off the top, so the number is sized against
  // what is genuinely left rather than competing with it for width.
  const unitW = estimateWidth(unit, unitSize, weight, unitTrack) + gap;
  const valueMax = maxWidth - unitW;
  let size = opts.max;
  while (size > min && estimateWidth(raw, size, weight, 0) > valueMax) size -= 1;

  const valueW = estimateWidth(raw, size, weight, 0);
  const startX = centreX(s) - (valueW + unitW) / 2;
  return (
    `<text x="${startX}" y="${opts.y}" text-anchor="start" font-family="${family}" ` +
    `font-size="${size}" font-weight="${weight}" fill="${opts.fill ?? s.text}">${esc(raw)}</text>` +
    `<text x="${startX + valueW + gap}" y="${opts.y}" text-anchor="start" font-family="${SANS}" ` +
    `font-size="${unitSize}" font-weight="${weight}" letter-spacing="${unitTrack}" ` +
    `fill="${opts.unitFill ?? s.faint}">${esc(unit)}</text>`
  );
}
