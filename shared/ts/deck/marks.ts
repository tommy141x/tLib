/**
 * The shapes a deck key draws: fields, chips, lamps, rules and arrows.
 *
 * ── The one idea behind all of it ──
 *
 * A segment LCD has no per-glyph colour. It cannot tint a word — it can only
 * light a segment or not — so the way real hardware says "this is active" is to
 * **invert the field**: fill the block and knock the text out of it. That is why
 * a latched key drawn with {@link invertField} reads as equipment and the same
 * key drawn with coloured text reads as a game.
 *
 * It is also, measured at true 72px, the single most legible thing a key can
 * draw: an inverted block survives the 2:1 downscale as a *shape*, where coloured
 * text degrades into a smear. Reach for an inverted field before reaching for a
 * fill colour.
 *
 * ── Boxes centre on a centre, never on a baseline ──
 *
 * Every primitive here that draws a box around text takes `cy`, the box's
 * vertical CENTRE, and positions the text with `capBaseline`. The modules this
 * replaces hung boxes off text baselines with hardcoded offsets (`y - h + 4`,
 * `y - 1`, `y + h * 0.36`), each of which was correct at exactly one font size
 * and wrong at every other. Do not add a magic offset here; if something sits
 * wrong, the centre is wrong.
 */

import { CAP, capBaseline, esc, estimateWidth, fitToWidth, SANS, trackedCentre } from "./metrics.ts";
import { centreX, contentWidth, type Surface } from "./surface.ts";

/**
 * An inverted LCD field: a filled block with the text knocked out of it.
 *
 * The block is sized to the text, not the other way round, so it is always
 * exactly as wide as it needs to be and can never clip what it contains.
 */
export function invertField(
	s: Surface,
	text: string,
	opts: {
		/** The block's vertical CENTRE. Not a text baseline. */
		cy: number;
		fill: string;
		size?: number;
		track?: number;
		ink?: string;
		padX?: number;
		height?: number;
		maxWidth?: number;
		/**
		 * Upper-case the text. Defaults to true, because the overwhelming majority
		 * of inverted fields hold a legend — "ON", "LATCH", "SELECT" — and a legend
		 * is the product talking, which this package does in caps.
		 *
		 * Pass `false` when the field holds the PLAYER's data. A tone or pattern
		 * name inverted on the touch strip came out "PRIORITY" while the key
		 * directly above it drew "Priority" from the same string: the same fact
		 * told two ways, six inches apart. Case is a property of the string's
		 * author, not of the box it happens to be drawn in.
		 */
		upper?: boolean;
	},
): string {
	const track = opts.track ?? 2.5;
	const padX = opts.padX ?? 12;
	const maxWidth = opts.maxWidth ?? contentWidth(s);
	const raw = String(text ?? "");
	const fitted = fitToWidth(opts.upper === false ? raw : raw.toUpperCase(), {
		max: opts.size ?? 13,
		min: 9,
		maxWidth: maxWidth - padX * 2,
		weight: 800,
		tracking: track,
	});

	// Trailing tracking is added after the last glyph too, so a tracked string is
	// that much wider on its right than on its left. Drop the trailing gap from
	// the block width and shift the text centre by half of it, or the word sits
	// visibly left inside its own block.
	const w = Math.min(maxWidth, fitted.width - track + padX * 2);
	const h = opts.height ?? Math.round(fitted.size * CAP) + 10;
	const x = centreX(s) - w / 2;
	return (
		`<rect x="${x}" y="${opts.cy - h / 2}" width="${w}" height="${h}" rx="2" fill="${opts.fill}"/>` +
		`<text x="${trackedCentre(centreX(s), track)}" y="${capBaseline(opts.cy, fitted.size)}" ` +
		`text-anchor="middle" font-family="${SANS}" font-size="${fitted.size}" font-weight="800" ` +
		`letter-spacing="${track}" fill="${opts.ink ?? s.ink}">${esc(fitted.text)}</text>`
	);
}

/**
 * The unlit twin of {@link invertField} — same box, outline instead of fill.
 *
 * Shared rather than redrawn per action so a key's layout cannot shift between
 * its lit and unlit states. Laying the two out independently is exactly how a
 * key ends up jumping a pixel or two as a state latches, which reads as a
 * rendering fault.
 *
 * Draws at the size it is given rather than shrinking to fit, which is the one
 * place this package deliberately does not auto-size. The lit and unlit twins
 * must agree on their box, and a shrink rule that fires on one state's string
 * and not the other's is precisely how they stop agreeing. Callers pair this
 * with {@link invertField} on short machine words whose length they control; the
 * block width is still clamped to `maxWidth`, so it cannot leave the glass.
 */
export function unlitField(
	s: Surface,
	text: string,
	opts: {
		cy: number;
		size?: number;
		track?: number;
		padX?: number;
		height?: number;
		fill?: string;
		maxWidth?: number;
	},
): string {
	const size = opts.size ?? 13;
	const track = opts.track ?? 2.5;
	const padX = opts.padX ?? 12;
	const maxWidth = opts.maxWidth ?? contentWidth(s);
	const raw = String(text ?? "").toUpperCase();
	// Trailing tracking dropped from the width, exactly as in `invertField` — the
	// two boxes must be measured the same way or they are not twins.
	const w = Math.min(maxWidth, estimateWidth(raw, size, 800, track) - track + padX * 2);
	const h = opts.height ?? Math.round(size * CAP) + 10;
	const x = centreX(s) - w / 2;
	return (
		`<rect x="${x + 0.5}" y="${opts.cy - h / 2 + 0.5}" width="${w - 1}" height="${h - 1}" rx="2" ` +
		`fill="none" stroke="${s.card}" stroke-width="1"/>` +
		`<text x="${trackedCentre(centreX(s), track)}" y="${capBaseline(opts.cy, size)}" ` +
		`text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="800" ` +
		`letter-spacing="${track}" fill="${opts.fill ?? s.faint}">${esc(raw)}</text>`
	);
}

/**
 * The state rule across the top of the glass.
 *
 * A lit hairline with a short energised segment at its left, in the LCD's own
 * idiom. This replaced a bright full-width accent strip, which was the single
 * most app-like thing on these decks: it carried exactly the same information
 * (what state is this key in) at many times the visual shout. Pass the product's
 * idle colour for a key with nothing to say.
 */
export function stateRule(s: Surface, fillColor: string, y: number, idleColor: string): string {
	const lit = fillColor !== idleColor;
	return (
		`<rect x="${s.inset}" y="${y}" width="${contentWidth(s)}" height="1" fill="${s.edge}"/>` +
		(lit
			? `<rect x="${s.inset}" y="${y - 1}" width="34" height="3" rx="1" fill="${fillColor}"/>` +
				`<rect x="${s.inset}" y="${y - 3}" width="34" height="7" rx="2" fill="${fillColor}" opacity="0.18"/>`
			: "")
	);
}

/** The hairline a segment LCD puts under its flag row. */
export function hairline(s: Surface, y: number): string {
	return `<rect x="${s.inset}" y="${y}" width="${contentWidth(s)}" height="1" fill="${s.edge}"/>`;
}

/** One flag in the status row — a segment chip, not an LED and not a word. */
export interface GlyphSpec {
	/** Short text in the LCD's own shorthand: "SCN", "A", "H". Two or three chars. */
	text: string;
	/** Lit (filled chip) or unlit (outline only). */
	on: boolean;
	/** Colour when lit. Defaults to the surface's primary ink. */
	color?: string;
}

/**
 * The flag row, drawn as lit/unlit segment chips.
 *
 * **Chips, not words.** Drawing these flags as bare text failed twice for the
 * same reason: at 13px in a 26px cell three-letter glyphs merged into one run,
 * and once that was fixed by shrinking the face, a true-72px render showed the
 * whole row degrade into mush. Both are the same bug — glyph detail does not
 * survive a 2:1 downscale.
 *
 * A chip does, because it is a *shape*: lit reads as a solid block whether or not
 * you can resolve the letters inside it, and unlit reads as an outline. That is
 * also exactly how a segment LCD behaves, so the fix and the idiom agree.
 *
 * Always draws every chip, lit or not, so a key's layout never shifts as flags
 * change. A row that reflows on each event is unreadable at a glance, which is
 * the only way a deck key is ever read.
 */
export function glyphRow(
	s: Surface,
	items: GlyphSpec[],
	y: number,
	/** Horizontal bounds the chips must stay inside — narrowed when a meter shares the row. */
	bounds: { left?: number; right?: number } = {},
): string {
	if (!items.length) return "";
	const left = bounds.left ?? s.inset;
	const right = bounds.right ?? s.width - s.inset;
	const span = right - left;

	const longest = items.reduce((n, it) => Math.max(n, it.text.length), 0);
	// Chip width is driven by the longest label so every chip in a row matches —
	// ragged chip widths read as a rendering fault rather than as flags.
	const size = longest > 2 ? 9 : 10;
	const track = 0.3;
	const ideal = estimateWidth("M".repeat(longest), size, 800, track) + 9;
	const gap = 3;
	const cell = Math.min(ideal + gap, span / items.length);
	const chipW = Math.max(8, cell - gap);
	const chipH = Math.round(size * CAP) + 7;
	const startX = left + (span - cell * items.length) / 2;

	// `y` is the row's baseline in band terms; the chips are boxes, so they centre
	// on the cap-centre of that baseline.
	const cy = y - (size * CAP) / 2;
	const baseline = capBaseline(cy, size);

	let out = "";
	items.forEach((it, i) => {
		const x = startX + i * cell;
		const c = it.color ?? s.text;
		const tx = x + chipW / 2 + track / 2;
		if (it.on) {
			out +=
				`<rect x="${x}" y="${cy - chipH / 2}" width="${chipW}" height="${chipH}" rx="1.5" fill="${c}"/>` +
				`<text x="${tx}" y="${baseline}" text-anchor="middle" font-family="${SANS}" ` +
				`font-size="${size}" font-weight="800" letter-spacing="${track}" fill="${s.ink}">${esc(it.text)}</text>`;
		} else {
			out +=
				`<rect x="${x + 0.5}" y="${cy - chipH / 2 + 0.5}" width="${chipW - 1}" height="${chipH - 1}" rx="1.5" ` +
				`fill="none" stroke="${s.card}" stroke-width="1"/>` +
				`<text x="${tx}" y="${baseline}" text-anchor="middle" font-family="${SANS}" ` +
				`font-size="${size}" font-weight="800" letter-spacing="${track}" fill="${s.faint}">${esc(it.text)}</text>`;
		}
	});
	return out;
}

/** A single indicator lamp, optionally carrying a tiny glyph. */
export interface LedSpec {
	on: boolean;
	onColor: string;
	glyph?: string;
}

/**
 * A row of small indicator lamps for boolean flags.
 *
 * Rectangular rather than circular: at true 72px a 7px circle and a 7px square
 * are the same four pixels, but the rectangle keeps a readable aspect and reads
 * as a panel lamp rather than a dot. Explicitly left-anchored so placement next
 * to other content is predictable — the item count is bounded by known flags,
 * not by user text, so hand placement is safe here.
 */
export function ledRow(
	s: Surface,
	items: LedSpec[],
	x: number,
	y: number,
	spacing = 20,
	r = 7,
): string {
	let out = "";
	let cx = x;
	const w = r * 1.7;
	const h = r * 0.95;
	for (const it of items) {
		const c = it.onColor;
		out +=
			`<rect x="${cx - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="1.5" ` +
			`fill="${it.on ? c : s.card}" stroke="${it.on ? c : s.faint}" stroke-width="1"/>` +
			(it.on
				? `<rect x="${cx - w / 2 - 2}" y="${y - h / 2 - 2}" width="${w + 4}" height="${h + 4}" rx="3" fill="${c}" opacity="0.15"/>`
				: "");
		if (it.glyph) {
			// Sized to the lamp's height, then centred on the lamp's centre. An
			// earlier version offset the baseline by a fraction of the BOX height
			// while sizing the glyph from the lamp, so the letter drifted out of its
			// lamp as soon as a caller passed a different `r`.
			const gs = Math.min(h + 1, w - 2);
			out +=
				`<text x="${cx}" y="${capBaseline(y, gs)}" text-anchor="middle" font-family="${SANS}" ` +
				`font-size="${gs}" font-weight="800" fill="${it.on ? s.ink : s.faint}">${esc(it.glyph)}</text>`;
		}
		cx += spacing;
	}
	return out;
}

/**
 * A solid engraved chevron.
 *
 * Replaces the `◀`/`▶`/`▲`/`▼` characters step keys used to be labelled with.
 * Those are emoji-adjacent glyphs whose shape, weight and vertical centring are
 * all at the mercy of whichever font resolves them — they never sat on the line
 * with the letters beside them, and on a machine missing the glyph they draw
 * tofu. A drawn triangle is the same mark everywhere and reads as a legend cut
 * into a panel.
 */
export function chevron(
	dir: "left" | "right" | "up" | "down",
	x: number,
	y: number,
	size: number,
	fill: string,
): string {
	const h = size / 2;
	const pts =
		dir === "left"
			? `${x + h},${y - h} ${x + h},${y + h} ${x - h},${y}`
			: dir === "right"
				? `${x - h},${y - h} ${x - h},${y + h} ${x + h},${y}`
				: dir === "up"
					? `${x - h},${y + h} ${x + h},${y + h} ${x},${y - h}`
					: `${x - h},${y - h} ${x + h},${y - h} ${x},${y + h}`;
	return `<polygon points="${pts}" fill="${fill}"/>`;
}

/**
 * A label with a chevron beside it, laid out as ONE centred group.
 *
 * Step keys used to centre the text on the canvas and pin the chevron to the
 * key's edge. Both halves were individually centred and the pair was not: the
 * arrow floated off on its own with a wide gap between it and the word it belongs
 * to, and the empty side of the key made the whole thing look mis-registered.
 * Measuring the text first and laying the two out as a unit is the only way the
 * group reads as one mark.
 *
 * `cy` is the group's optical centre, so it lines up with a band rather than with
 * a baseline.
 */
export function stepRow(
	s: Surface,
	text: string,
	opts: {
		dir: "left" | "right" | "up" | "down";
		cy: number;
		max?: number;
		min?: number;
		fill?: string;
		markFill?: string;
		maxWidth?: number;
	},
): string {
	// 700, matching `HERO.text`, and the case is left alone — this draws a HERO,
	// not a legend. It used to force upper case at weight 800, which meant the
	// same channel or pattern name rendered "INTERSECTION" on a stepping key and
	// "Intersection" on the key beside it. Uppercasing belongs to `invertField`
	// and `legend`, where the product is talking; a hero is the player's own data
	// and keeps the case they typed.
	const weight = 700;
	const mark = 15;
	// 12, not the 7 this started at: at 7 the triangle touched the first letter and
	// the pair read as one damaged glyph rather than as an arrow and a word.
	const gap = 12;
	const maxWidth = opts.maxWidth ?? contentWidth(s) - 2;
	const fitted = fitToWidth(String(text ?? ""), {
		max: opts.max ?? 25,
		min: opts.min ?? 13,
		maxWidth: maxWidth - mark - gap,
		weight,
		tracking: 0,
	});

	const totalW = fitted.width + gap + mark;
	const left = centreX(s) - totalW / 2;
	const leads = opts.dir === "left" || opts.dir === "up";
	const markCx = leads ? left + mark / 2 : left + fitted.width + gap + mark / 2;
	const textCx = leads ? left + mark + gap + fitted.width / 2 : left + fitted.width / 2;
	return (
		chevron(opts.dir, markCx, opts.cy, mark, opts.markFill ?? s.text) +
		`<text x="${textCx}" y="${capBaseline(opts.cy, fitted.size)}" text-anchor="middle" ` +
		`font-family="${SANS}" font-size="${fitted.size}" font-weight="${weight}" ` +
		`fill="${opts.fill ?? s.text}">${esc(fitted.text)}</text>`
	);
}
