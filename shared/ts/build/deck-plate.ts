/**
 * The device plate every deck gallery composites its key faces onto.
 *
 * THIS EXISTS BECAUSE THE PREVIOUS PLATES WERE ELGATO'S OWN PRODUCT RENDERS, wordmark
 * and all, used as the backdrop of storefront artwork for paid resources. Depicting the
 * hardware a plugin runs on is fair; shipping the manufacturer's photography inside our
 * own commercial listing, and committing it to three repositories, is a different thing,
 * and nobody had ever decided to do it — the images were copied from tRadio with a note
 * saying they "describe Elgato hardware".
 *
 * So the plate is drawn here instead, from the SAME geometry those images were measured
 * for (`plates.json`), which is what makes the swap invisible downstream: every key rect,
 * the LCD strip and the four dials land exactly where the gallery already puts them. The
 * body is a generic six/fifteen/eight-key deck with no mark on it.
 *
 * SVG rather than a headless page: `shoot()` needs the brand face and an opaque frame, and
 * a plate needs neither — it needs an alpha channel and exact pixel geometry. sharp
 * rasterises this directly, which also keeps the output byte-reproducible.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dial {
  cx: number;
  cy: number;
  r: number;
}

export interface PlateSpec {
  width: number;
  height: number;
  /** The device silhouette, measured from the alpha channel of the plate it replaces. */
  body: Rect;
  keys: Rect[];
  lcd?: Rect;
  dials?: Dial[];
}

/** Corner radius of the body, as a fraction of its short side. The hardware is softer than
 *  a key well and harder than a pill; 0.035 matches the silhouette being replaced. */
const BODY_RADIUS = 0.035;

function well(r: Rect, i: number): string {
  // Each well is drawn three times: the recess it sits in, the key face, and a one-pixel
  // bright edge along the top. The gallery composites a key IMAGE over the face, so the
  // face only shows through where a key is missing or translucent -- the recess and the
  // edge are what make a composited key look seated rather than pasted on.
  const rad = Math.round(Math.min(r.w, r.h) * 0.16);
  return `
    <rect x="${r.x - 7}" y="${r.y - 7}" width="${r.w + 14}" height="${r.h + 14}"
          rx="${rad + 5}" fill="url(#recess)"/>
    <rect x="${r.x - 3}" y="${r.y - 3}" width="${r.w + 6}" height="${r.h + 6}"
          rx="${rad + 2}" fill="none" stroke="url(#bezel)" stroke-width="3"/>
    <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rad}" fill="#07090b"/>
    <rect x="${r.x + 2}" y="${r.y + 2}" width="${r.w - 4}" height="${Math.round(r.h * 0.42)}"
          rx="${rad}" fill="url(#gloss)" opacity=".5" id="k${i}"/>`;
}

export function deckPlateSvg(spec: PlateSpec): string {
  const { body } = spec;
  const rad = Math.round(Math.min(body.w, body.h) * BODY_RADIUS);

  const lcd = spec.lcd
    ? `
    <rect x="${spec.lcd.x - 6}" y="${spec.lcd.y - 6}" width="${spec.lcd.w + 12}"
          height="${spec.lcd.h + 12}" rx="14" fill="url(#recess)"/>
    <rect x="${spec.lcd.x}" y="${spec.lcd.y}" width="${spec.lcd.w}" height="${spec.lcd.h}"
          rx="9" fill="#05070a"/>`
    : "";

  // Dials get a cap, a knurled rim and a top light, in that order. The gallery draws nothing
  // over them, so unlike the key wells this is the finished part.
  const dials = (spec.dials ?? [])
    .map(
      (d) => `
    <circle cx="${d.cx}" cy="${d.cy}" r="${d.r + 6}" fill="url(#recess)"/>
    <circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="url(#dial)"/>
    <circle cx="${d.cx}" cy="${d.cy}" r="${d.r - 1}" fill="none" stroke="#000" stroke-opacity=".55"/>
    <circle cx="${d.cx}" cy="${d.cy}" r="${Math.round(d.r * 0.62)}" fill="#0d1013"/>
    <ellipse cx="${d.cx}" cy="${d.cy - Math.round(d.r * 0.45)}" rx="${Math.round(d.r * 0.55)}"
             ry="${Math.round(d.r * 0.22)}" fill="url(#gloss)" opacity=".35"/>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}">
  <defs>
    <!-- A matte charcoal case. Light enough that a black key face reads as recessed into
         it: at the first values tried (#2b2f33 down to #121517) the body and the wells were
         within a few levels of each other and the whole plate read as one dark rectangle. -->
    <linearGradient id="case" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#383d43"/>
      <stop offset=".42" stop-color="#282c31"/>
      <stop offset="1" stop-color="#1a1d21"/>
    </linearGradient>
    <linearGradient id="recess" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0c0e"/>
      <stop offset="1" stop-color="#15181b"/>
    </linearGradient>
    <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6c747b" stop-opacity=".85"/>
      <stop offset=".5" stop-color="#2a2f34" stop-opacity=".5"/>
      <stop offset="1" stop-color="#8a939b" stop-opacity=".55"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="dial" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3f44"/>
      <stop offset="1" stop-color="#1a1d20"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity=".55"/>
    </filter>
  </defs>
  <g filter="url(#drop)">
    <rect x="${body.x}" y="${body.y}" width="${body.w}" height="${body.h}" rx="${rad}" fill="url(#case)"/>
    <rect x="${body.x + 1.5}" y="${body.y + 1.5}" width="${body.w - 3}" height="${body.h - 3}"
          rx="${rad - 1}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="3"/>
    <rect x="${body.x + 3}" y="${body.y + 3}" width="${body.w - 6}" height="${Math.round(body.h * 0.1)}"
          rx="${rad}" fill="url(#gloss)" opacity=".7"/>
  </g>
  ${spec.keys.map(well).join("")}
  ${lcd}
  ${dials}
</svg>`;
}
