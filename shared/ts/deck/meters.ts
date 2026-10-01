/**
 * Segmented meters — the three ways a deck key shows a quantity.
 *
 * All three are SEGMENTED rather than continuous, and that is the 72px budget
 * talking again: a 4px-tall continuous bar downscales to two pixels of mush,
 * while a segment row still reads as "about two thirds" even when you cannot
 * count the individual blocks. It is also what a segment display can physically
 * do, so the constraint and the idiom agree.
 *
 * Each takes a `y` that is its BOTTOM edge and grows upward, so a caller places
 * meters against the band below them rather than having to know their height.
 */

import type { Surface } from "./surface.ts";

/**
 * A level meter: 0..1, filled from the left.
 *
 * `level` is clamped, so a caller who passes a percentage by mistake gets a full
 * bar rather than segments drawn off the side of the key.
 */
export function levelBar(
	s: Surface,
	level: number,
	opts: { y: number; x?: number; width?: number; count?: number; fill: string; height?: number },
): string {
	const count = opts.count ?? 14;
	const x = opts.x ?? s.inset + 2;
	const width = opts.width ?? s.width - (s.inset + 2) * 2;
	const h = opts.height ?? 10;
	const gap = 2;
	const w = (width - gap * (count - 1)) / count;
	const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
	const lit = Math.round(clamped * count);
	let out = "";
	for (let i = 0; i < count; i++) {
		out +=
			`<rect x="${x + i * (w + gap)}" y="${opts.y - h}" width="${w}" height="${h}" ` +
			`fill="${i < lit ? opts.fill : s.card}"/>`;
	}
	return out;
}

/**
 * A scanner's channel-sweep bar: a row of segments with the swept position lit.
 *
 * This is what replaced a magnifying-glass icon. A magnifier means "search" in
 * app iconography and means nothing on radio hardware — what a scanner actually
 * shows is a bank of channel segments with activity moving across it. It also
 * survives the 2:1 downscale, which a 7px-stroked circle and its diagonal handle
 * did not.
 *
 * `active` is the lit segment index, or `null` for a sweep that is genuinely off,
 * where every segment sits unlit. Note that a HELD sweep should still pass an
 * index (in the hold colour): parking the bar with nothing lit reads as a dead
 * row of pixels rather than as "stopped here", which is the one thing the bar
 * exists to say.
 */
export function sweepBar(
	s: Surface,
	active: number | null,
	opts: { y: number; x?: number; width?: number; count?: number; fill: string; height?: number },
): string {
	const count = opts.count ?? 9;
	const x = opts.x ?? s.inset + 4;
	const width = opts.width ?? s.width - (s.inset + 4) * 2;
	const h = opts.height ?? 26;
	const gap = 3;
	const w = (width - gap * (count - 1)) / count;
	let out = "";
	for (let i = 0; i < count; i++) {
		const lit = active !== null && i === active;
		// Segments either side of the lit one carry a trailing glow, which is what
		// makes a static image read as a sweep in motion rather than as one lit bar.
		const near = active !== null && Math.abs(i - active) === 1;
		out +=
			`<rect x="${x + i * (w + gap)}" y="${opts.y - h}" width="${w}" height="${h}" ` +
			`fill="${lit ? opts.fill : s.card}" opacity="${lit ? 1 : near ? 0.85 : 0.55}"/>`;
	}
	return out;
}

/** Geometry for one signal-strength meter. */
export interface SignalGeom {
	/** Bar width. */
	w?: number;
	/** Gap between bars. */
	gap?: number;
	/** Height of the shortest bar. */
	base?: number;
	/** How much taller each successive bar is. */
	step?: number;
	/** How many bars. */
	count?: number;
}

/**
 * The compact staircase meter that rides at the right of a flag row.
 *
 * Wider bars with a smaller gap than a footer-sized meter: at true 72px a 2px gap
 * closes up and the bars read as one block, so it is the GAP that has to survive
 * the downscale, not the bar.
 */
export const SIGNAL_GEOM_ROW: SignalGeom = { w: 4, gap: 2.5, base: 4, step: 2.6 };

/** Total width of {@link signalBars}, so callers can right-align without guessing. */
export function signalBarsWidth(g: SignalGeom = {}): number {
	const w = g.w ?? 5;
	const gap = g.gap ?? 2;
	const count = g.count ?? 5;
	return count * w + (count - 1) * gap;
}

/**
 * Signal-strength bars, drawn as a rising staircase from `x`, `y` (bottom-left).
 *
 * `count` defaults to five. It is a parameter because the number of bars is a
 * product fact, not a drawing fact — and getting it wrong is not hypothetical:
 * one of these renderers drew three bars for its whole shipped life against an
 * engine emitting 1..5, so the top of the range was literally undrawable and
 * three different states rendered identically.
 */
export function signalBars(
	s: Surface,
	level: number,
	x: number,
	y: number,
	on: string,
	g: SignalGeom = {},
): string {
	let out = "";
	const w = g.w ?? 5;
	const gap = g.gap ?? 2;
	const base = g.base ?? 6;
	const step = g.step ?? 4.5;
	const count = g.count ?? 5;
	for (let i = 0; i < count; i++) {
		const h = base + i * step;
		out +=
			`<rect x="${x + i * (w + gap)}" y="${y - h}" width="${w}" height="${h}" ` +
			`fill="${i < level ? on : s.card}"/>`;
	}
	return out;
}
