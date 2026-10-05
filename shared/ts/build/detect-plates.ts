/**
 * Derive key geometry from the Stream Deck plate photographs into `plates.json`.
 *
 * The alternative was hand-measuring 29 rectangles in an image editor and typing
 * them in. That is wrong the moment a plate is re-exported at a different size or
 * crop, and wrong silently — keys land slightly off their wells and the composite
 * still looks plausible at a glance.
 *
 * Detection leans on the one thing that is reliably true of these renders: a key
 * face is much darker than the body it sits in, and the body is much darker than
 * the chrome bezel ringing each key. So: threshold to "very dark", take connected
 * components, and keep the ones whose bounding box is key-shaped.
 *
 * ── Why this is in tLib ─────────────────────────────────────────────────────
 *
 * It describes ELGATO HARDWARE, not any one product: the Mini has the same six
 * wells in the same places whatever is drawn in them. tELS and tRadio each had a
 * byte-identical 264-line copy, kept in step by a README asking the next person
 * to copy it across again. That is exactly the drift this file now cannot have:
 * one implementation, so a tuning fix reaches both galleries.
 *
 * ── Why the decoder is injected ─────────────────────────────────────────────
 *
 * `decode` turns the file's bytes into RGBA pixels, and it is a PARAMETER rather
 * than an `import sharp` here. sharp is a native-binary dependency that tLib has
 * no other use for, and only one of the two consumers depends on it: tRadio does,
 * tELS deliberately does not and only ever needs the TYPES below so its `run.ts`
 * can read `plates.json`. Importing sharp at this level would put a native build
 * in tLib's dependency tree to serve a gallery tool, and would stop tELS
 * type-checking its own scripts.
 *
 * ── Why `build/` and NOT `deck/` ────────────────────────────────────────────
 *
 * `shared/ts/deck` is MANAGED VENDORING: `deck-render-sync.ts` copies every `.ts`
 * directly under it into each Stream Deck plugin's `src/lib/deck/`, because a
 * separate rollup cannot resolve `@tlib/shared`. Its contract is therefore "code the
 * PLUGIN bundles need", and this is not that: it is a build-time tool run from a
 * resource's `scripts/`, it imports `node:fs` and `node:crypto`, and no plugin
 * bundles a line of it. Vendoring it would ship a filesystem tool into a program a
 * customer installs on their own machine.
 *
 * `build/` is where the rest of the gallery tooling already lives — `hud-gallery.ts`,
 * `prop-editor-gallery.ts`, `nui-chromium.ts` — and the sync glob does not reach it.
 *
 * It is a tool, not part of a gallery run — a gallery reads the JSON and verifies
 * it still matches the plate it was measured from.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlateGeometry {
  /** File under `plates/`. */
  file: string;
  /** Human name for the hardware this plate depicts. */
  device: string;
  width: number;
  height: number;
  /** sha256 of the plate, so the gallery can refuse to use stale geometry. */
  sha256: string;
  /** Key wells in reading order (left→right, top→bottom). */
  keys: Rect[];
  /** The Stream Deck+ touch strip, when the plate has one. */
  lcd?: Rect;
  /** Encoder dial centres, left→right, when the plate has them. */
  dials?: { cx: number; cy: number; r: number }[];
}

export interface PlateSpec {
  file: string;
  device: string;
  keys: number;
  cols: number;
  dials: number;
  lcd: boolean;
}

/** Expected hardware per plate. Detection must produce exactly this. */
export const PLATE_SPECS: readonly PlateSpec[] = [
  { file: "mini.png", device: "Stream Deck Mini", keys: 6, cols: 3, dials: 0, lcd: false },
  { file: "mk2.png", device: "Stream Deck MK.2", keys: 15, cols: 5, dials: 0, lcd: false },
  { file: "plus.png", device: "Stream Deck +", keys: 8, cols: 4, dials: 4, lcd: true },
];

/** Straight RGBA, four bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

/** Decodes an encoded image's bytes to RGBA. See the header for why it is injected. */
export type DecodeRgba = (bytes: Uint8Array) => Promise<RgbaImage>;

/**
 * Connected components of a boolean mask, via an explicit stack.
 *
 * Recursion blows the stack on a 1448x1086 plate — the body of the device is one
 * component of well over a million pixels.
 */
export function components(mask: Uint8Array, w: number, h: number, minArea: number): Rect[] {
  const seen = new Uint8Array(w * h);
  const out: Rect[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;

    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;

      // 4-connectivity is enough and keeps diagonal chrome speckle from
      // welding two neighbouring keys into one blob.
      const push = (q: number) => {
        if (!mask[q] || seen[q]) return;
        seen[q] = 1;
        stack.push(q);
      };
      if (x > 0) push(p - 1);
      if (x + 1 < w) push(p + 1);
      if (y > 0) push(p - w);
      if (y + 1 < h) push(p + w);
    }

    if (area >= minArea) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

/**
 * Every key yields two concentric blobs — the dark well the key sits in, and the
 * key face inside it, separated by the glossy highlight around the face's edge.
 * Keep the outer one and drop anything nested inside it.
 *
 * The outer well is the stable measurement: across the Mini's six keys it varies
 * by 3px (265-268 wide), while the inner faces range 215-238 because the gloss
 * bites into each one differently. Measuring the face directly would make one key
 * in six visibly larger than its neighbours in the composite.
 */
export function dropNested(rects: Rect[]): Rect[] {
  const contains = (a: Rect, b: Rect) =>
    a !== b && b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  return rects.filter((r) => !rects.some((other) => contains(other, r)));
}

/**
 * The illuminated face inside a key well, as a fraction of the well.
 *
 * Measured, not chosen: the inner blobs above average 82% of their well's width
 * across all three plates. This is where a rendered key image actually goes — a
 * Stream Deck key image fills the lit face, not the moulding around it.
 */
export const FACE_RATIO = 0.82;

export function faceOf(well: Rect): Rect {
  const w = Math.round(well.w * FACE_RATIO);
  const h = Math.round(well.h * FACE_RATIO);
  return {
    x: Math.round(well.x + (well.w - w) / 2),
    y: Math.round(well.y + (well.h - h) / 2),
    w,
    h,
  };
}

/** Reading order: group into rows by vertical overlap, then sort each row by x. */
export function readingOrder(rects: Rect[]): Rect[] {
  const rows: Rect[][] = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y)) {
    const row = rows.find((candidate) => {
      const ref = candidate[0];
      // Same row if their vertical spans overlap by more than half a key.
      const overlap = Math.min(ref.y + ref.h, r.y + r.h) - Math.max(ref.y, r.y);
      return overlap > Math.min(ref.h, r.h) * 0.5;
    });
    if (row) row.push(r);
    else rows.push([r]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** One plate, measured. `file` is the full path; `spec.file` is only its basename. */
export async function measurePlate(
  spec: PlateSpec,
  file: string,
  decode: DecodeRgba
): Promise<PlateGeometry> {
  const buf = await fs.promises.readFile(file);
  const img = await decode(buf);
  const w = img.width;
  const h = img.height;
  const data = img.data;

  // "Dark and actually part of the device" — the plates are cutouts, so fully
  // transparent surround is near-black too and would otherwise be one huge
  // component touching every key.
  const dark = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 200) continue;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (lum < 26) dark[p] = 1;
  }

  // A key is a good fraction of the plate; anything tiny is bezel speckle or the
  // gap between the Elgato logo's glyphs.
  const blobs = dropNested(components(dark, w, h, (w * h) / 900));

  const square = blobs.filter((r) => {
    const ar = r.w / r.h;
    return ar > 0.72 && ar < 1.38 && r.w > w / 24;
  });
  const wide = blobs.filter((r) => r.w / r.h > 3);

  const keys = readingOrder(square).map(faceOf);
  if (keys.length !== spec.keys) {
    throw new Error(
      `${spec.file}: detected ${keys.length} key wells, expected ${spec.keys}. ` +
        `Blobs found: ${blobs.length} (square ${square.length}, wide ${wide.length}). ` +
        `Re-tune the thresholds in detect-plates.ts rather than hand-editing plates.json.`
    );
  }

  const geo: PlateGeometry = {
    file: spec.file,
    device: spec.device,
    width: w,
    height: h,
    sha256: createHash("sha256").update(buf).digest("hex"),
    keys,
  };

  // Below the keys the Plus has three wide dark regions, top to bottom: the LCD
  // touch strip, the recess the dials sit in, and the shadow under the device.
  // Order them by y and take them positionally — picking the strip by area chose
  // the dial recess instead (225k px vs the strip's 165k), which put the touch
  // strip's overlay around the dials.
  const below = wide
    .filter((r) => r.y > Math.max(...keys.map((k) => k.y + k.h)))
    .sort((a, b) => a.y - b.y);

  if (spec.lcd) {
    if (!below.length) throw new Error(`${spec.file}: expected an LCD touch strip, found none.`);
    // The well and the screen inside it are one continuous dark region — unlike
    // the keys, there is no nested blob to find, so the screen cannot be
    // measured. Derive it from the real hardware instead: a Stream Deck+ touch
    // strip is 800x100, and drawing dial feedback at the well's own 5.2:1 would
    // stretch it to half again its true height.
    const well = below[0];
    const lcdW = Math.round(well.w * 0.95);
    const lcdH = Math.round(lcdW * (100 / 800));
    geo.lcd = {
      x: Math.round(well.x + (well.w - lcdW) / 2),
      y: Math.round(well.y + (well.h - lcdH) / 2),
      w: lcdW,
      h: lcdH,
    };
  }

  if (spec.dials > 0) {
    // Dials are polished metal, far too bright for the dark mask, so they are
    // located from the recess that holds them rather than detected directly.
    const recess = below[1];
    if (!recess) throw new Error(`${spec.file}: expected a dial recess below the touch strip.`);
    const lastRow = keys.slice(-spec.cols);
    const pitch = (lastRow[lastRow.length - 1].x - lastRow[0].x) / (spec.cols - 1);
    geo.dials = lastRow.map((k) => ({
      cx: Math.round(k.x + k.w / 2),
      cy: Math.round(recess.y + recess.h / 2),
      r: Math.round(pitch * 0.33),
    }));
  }

  return geo;
}

/** Every plate in `PLATE_SPECS`, measured out of `platesDir`, in order. */
export async function measurePlates(
  platesDir: string,
  decode: DecodeRgba,
  specs: readonly PlateSpec[] = PLATE_SPECS
): Promise<PlateGeometry[]> {
  const out: PlateGeometry[] = [];
  for (const spec of specs) {
    out.push(await measurePlate(spec, path.join(platesDir, spec.file), decode));
  }
  return out;
}

/** The exact bytes of `plates.json`. Tabs and the trailing newline are part of it. */
export function platesJson(plates: PlateGeometry[]): string {
  return `${JSON.stringify({ plates }, null, "\t")}\n`;
}

/** One human-readable line per plate, for a CLI to print. */
export function summarisePlate(p: PlateGeometry): string {
  const k = p.keys[0];
  return (
    `${p.device.padEnd(18)} ${p.width}x${p.height}  ${p.keys.length} keys ` +
    `(first ${k.w}x${k.h} at ${k.x},${k.y})` +
    `${p.lcd ? `  lcd ${p.lcd.w}x${p.lcd.h}` : ""}${p.dials ? `  ${p.dials.length} dials` : ""}`
  );
}
