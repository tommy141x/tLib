/**
 * The Stream Deck+ touch strip, drawn in the same instrument language as the keys.
 *
 * The dials used to ship against Elgato's STOCK layouts, handing the firmware
 * `{title, value, indicator}` and letting it draw -- which is why the strip looked
 * like a different product sitting under the keys. A custom layout with a single
 * full-bleed `pixmap` makes it ours, and the cell then goes through exactly the
 * same primitives as a key, so it cannot drift from them.
 *
 * It is NOT a short, wide key, for two physical reasons. There is NO 2:1
 * downscale here -- a cell is drawn and displayed at 200x100 -- so glyph detail
 * that dies on a key survives, and the cell can afford a real value rather than a
 * shape. And at half the height there is no room for the key's four bands: the
 * cell gets three. The extra width is spent on a BIGGER value, not more lines.
 */

import { bandCentre, type Shell } from "./card.ts";
import { invertField, type LedSpec, ledRow } from "./marks.ts";
import { levelBar } from "./meters.ts";
import { contentWidth, type Surface } from "./surface.ts";
import { fitText, legend, valueWithUnit } from "./text.ts";

/**
 * Wrap a body into one encoder cell document.
 */
export function stripDoc(
  s: Surface,
  shell: Shell,
  body: string,
  opts: { bg?: string; top?: string; divider?: boolean } = {}
): string {
  const bg = opts.bg ?? shell.bg;
  const top = opts.top ?? shell.glassTop;
  const { width: w, height: h } = s;
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bg}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    body +
    (opts.divider === false
      ? ""
      : `<rect x="${w - 1}" y="${h * 0.16}" width="1" height="${h * 0.68}" fill="${shell.edge}"/>`) +
    `</svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(doc)}`;
}

/**
 * Vertical rhythm for a strip cell. Text baselines, like {@link BAND}.
 */
export const STRIP_BAND = {
  /** What this dial controls. A machine legend. */
  title: 24,
  /** The value. */
  hero: 64,
  /** Meter bottom edge / state line baseline. */
  foot: 88,
} as const;

/** What one encoder cell shows. */
export interface StripSpec {
  /** What the dial controls — "VOLUME", "CHANNEL", "PATTERN". Always a legend. */
  title: string;
  titleColor?: string;
  /**
   * The value, as free text whose case belongs to whoever authored it.
   */
  value: string;
  valueColor?: string;
  /** A unit riding small beside a measured value. */
  unit?: string;
  /** Draw the value with monospaced digits, so a counting readout does not reflow. */
  mono?: boolean;
  /** Invert the value's field — the display's way of saying "active"/"latched". */
  invert?: boolean;
  /** 0..1, drawn as a segmented level bar along the bottom. */
  meter?: number | null;
  meterColor?: string;
  /** A state line along the bottom, when there is no meter. Always a legend. */
  status?: string;
  statusColor?: string;
  /**
   * Draw the status as an inverted field rather than as text.
   */
  statusInvert?: boolean;
  /** Indicator lamps at the bottom-left, drawn instead of a status line. */
  lamps?: LedSpec[];
  /** Override the glass for an exceptional state. */
  bg?: string;
  bgTop?: string;
  /** Extra SVG appended last. */
  extra?: string;
}

/** The per-product colours {@link stripCard} needs beyond the surface's ink. */
export interface StripTheme {
  surface: Surface;
  shell: Shell;
  inkHi: string;
  dim: string;
}

/**
 * One encoder cell, in the same language as the keys.
 */
export function stripCard(theme: StripTheme, spec: StripSpec): string {
  const s = theme.surface;
  let body = legend(s, spec.title, STRIP_BAND.title, spec.titleColor ?? theme.dim, {
    max: 15,
    min: 11,
  });

  const valueFill = spec.valueColor ?? theme.inkHi;
  if (spec.invert) {
    body += invertField(s, spec.value, {
      cy: bandCentre(STRIP_BAND.hero, 30),
      fill: valueFill,
      size: 26,
      track: 3,
      padX: 16,
      maxWidth: contentWidth(s),
      upper: false,
    });
  } else if (spec.unit) {
    body += valueWithUnit(s, spec.value, spec.unit, {
      y: STRIP_BAND.hero,
      max: 34,
      min: 16,
      fill: valueFill,
      unitFill: theme.dim,
      mono: spec.mono,
    });
  } else {
    body += fitText(s, spec.value, {
      y: STRIP_BAND.hero,
      max: 34,
      min: 14,
      weight: 800,
      fill: valueFill,
      mono: spec.mono,
    });
  }

  if (typeof spec.meter === "number") {
    body += levelBar(s, spec.meter, {
      y: STRIP_BAND.foot,
      height: 7,
      count: 18,
      fill: spec.meterColor ?? valueFill,
    });
  } else if (spec.lamps?.length) {
    body += ledRow(s, spec.lamps, s.inset + 8, STRIP_BAND.foot - 4, 22, 7);
  } else if (spec.status) {
    body += spec.statusInvert
      ? invertField(s, spec.status, {
          cy: bandCentre(STRIP_BAND.foot, 14),
          fill: spec.statusColor ?? s.text,
          size: 11,
          padX: 10,
        })
      : legend(s, spec.status, STRIP_BAND.foot, spec.statusColor ?? theme.dim, { max: 13 });
  }

  if (spec.extra) body += spec.extra;
  return stripDoc(s, theme.shell, body, { bg: spec.bg, top: spec.bgTop });
}

/**
 * The "no link" cell — the strip's version of an unpowered module.
 *
 * Matches {@link import("./card.ts").offlineCard}: glass present, backlight off,
 * no lit ink anywhere.
 *
 * thing on it.
 */
export function offlineStrip(
  s: Surface,
  shell: Shell,
  title: string,
  opts: { bg?: string } = {}
): string {
  return stripDoc(
    s,
    shell,
    legend(s, title, STRIP_BAND.title, s.faint, { max: 15, min: 11 }) +
      fitText(s, "NO LINK", {
        y: STRIP_BAND.hero - 4,
        max: 17,
        min: 12,
        weight: 700,
        fill: s.faint,
      }),
    { bg: opts.bg, top: opts.bg }
  );
}
