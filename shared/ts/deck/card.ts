/**
 * The module shell and the card built on it — the part that makes a deck read as
 * one instrument rather than as N one-off key designs.
 *
 * ── The material ──
 *
 * Every key is one recessed LCD module: neutral grey glass in a black bezel,
 * near-white ink, hairline segment rules. Not a flat card with a coloured bar
 * across the top — that reads as a phone app, which is the note this design
 * answers.
 *
 * The glass is a TRUE grey (R = G = B). An earlier pass tinted glass and ink
 * olive to imitate a transflective display; it did read as a display, but it put
 * a green cast over every key including ones with nothing to say, and a green
 * cast on white text is the most noticeable kind of wrong. Products supply their
 * own {@link Shell}, but the greys in it should be true greys.
 *
 * ── Fixed dark, deliberately ──
 *
 * Deck art does not follow the player's in-game theme. Two reasons, and the
 * second is load-bearing:
 *
 *   1. A Stream Deck sits in room light next to a monitor, not behind the
 *      product's bezel. A light-theme key is a white rectangle glaring in
 *      peripheral vision for a whole session.
 *   2. Key images are pushed over USB and cached by the Stream Deck app. Making
 *      them theme-reactive means re-pushing every key on a theme change, and a
 *      deck key that lags the product by a frame reads as broken. Fixed art is
 *      always correct.
 */

import { CAP, capBaseline } from "./metrics.ts";
import { type GlyphSpec, glyphRow, hairline, invertField, stateRule, stepRow } from "./marks.ts";
import {
	type SignalGeom,
	SIGNAL_GEOM_ROW,
	signalBars,
	signalBarsWidth,
} from "./meters.ts";
import { centreX, contentWidth, type Surface } from "./surface.ts";
import { fitText, label as drawLabel, legend, valueWithUnit } from "./text.ts";

/** Bezel, glass and edge treatment. One product, one shell. */
export interface Shell {
	/** The black surround. */
	bezel: string;
	/** Top stop of the glass gradient. */
	glassTop: string;
	/** Glass floor — the bottom stop, and the default background. */
	bg: string;
	/** Recess lip and outer edge stroke. */
	edge: string;
}

/**
 * Wrap a body into a full key document + data URI.
 *
 * This is the chokepoint every key type passes through, which is why the module
 * material lives here rather than in a helper each action has to remember to
 * call. `bg`/`top` override the glass for exceptional states (alarm, emergency).
 */
export function keyDoc(
	s: Surface,
	shell: Shell,
	body: string,
	opts: { bg?: string; top?: string } = {},
): string {
	const bg = opts.bg ?? shell.bg;
	const top = opts.top ?? shell.glassTop;
	const { width: w, height: h } = s;
	const doc =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
		`<defs>` +
		`<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
		`<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bg}"/></linearGradient>` +
		`<linearGradient id="s" x1="0" y1="0" x2="0.65" y2="1">` +
		`<stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>` +
		`<stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/></linearGradient>` +
		`</defs>` +
		// bezel, glass, recess lip, body, edge, then a raking glare over everything
		`<rect width="${w}" height="${h}" rx="16" fill="${shell.bezel}"/>` +
		`<rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="7" fill="url(#g)"/>` +
		`<rect x="6" y="6" width="${w - 12}" height="3" fill="#000" opacity="0.5"/>` +
		body +
		`<rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="7" fill="none" stroke="${shell.edge}" stroke-width="1"/>` +
		`<rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="7" fill="url(#s)"/>` +
		`</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(doc)}`;
}

/**
 * Vertical rhythm for a key card, top → bottom. Text BASELINES.
 *
 * Four stops, and there is no fifth. See the 72px budget in `surface.ts`: a
 * legend band naming the key and a band for right-aligned secondary data both
 * existed in the study and both were unreadable on real hardware.
 *
 * Anything with a BOX in it lays out on a cap-centre instead — use
 * {@link bandCentre} to convert. A baseline says nothing about how far a shape
 * centred on it extends, which is how a 21px badge ended up drawn 3px past the
 * bottom of the glass.
 */
export const BAND = {
	/** Flag chips + signal meter. */
	glyphs: 22,
	/** Small tracked caption. The zone / bank / band. */
	label: 52,
	/** The primary value. The channel / pattern / speed. */
	hero: 92,
	/** State line. */
	status: 122,
	/** Small print. Rarely used; the status line usually suffices. */
	footer: 136,
} as const;

/** The cap-centre of text of `size` drawn on a band baseline. */
export function bandCentre(baseline: number, size: number): number {
	return baseline - (size * CAP) / 2;
}

/**
 * What the hero band is being asked to draw.
 *
 * A content CLASS rather than a string, because "shrink until it fits" is the
 * right rule for a channel name and the wrong rule for a measured value. A
 * frequency like `856.1125`, or a speed like `120` with an `MPH` suffix, should
 * keep its digits at full size and let the suffix ride small — shrinking the
 * number because a three-letter unit was appended makes the part the user
 * actually reads smaller in order to protect the part they don't.
 */
export type Hero =
	/** Free text — a channel or zone name. Shrinks, then truncates. */
	| { kind: "text"; text: string }
	/** A measured value with an optional unit. The value stays big; the unit rides small. */
	| { kind: "value"; value: string; unit?: string; mono?: boolean }
	/** Two stacked lines, for when one long name reads better broken than shrunk. */
	| { kind: "stack"; top: string; bottom: string }
	/** An inverted field — the display's way of saying "active". */
	| { kind: "invert"; text: string };

/**
 * The hero band's type sizes, per content kind.
 *
 * Reviewed numbers, not derived ones. An earlier draft of this package computed
 * each kind's size from a single `max` — invert at `max - 6`, stack at
 * `max - 12` — which is tidier and produces different art. These are the sizes
 * the shipped key set was actually drawn and signed off at, so they are written
 * out literally and changing one is a visible change to every deck.
 *
 * `HERO_CY` is the optical centre a 32px hero's caps would occupy. Boxed heroes
 * (invert, step) centre on it so that latching a state does not move the band.
 */
export const HERO = {
	/** Free text. */
	text: { max: 32, min: 13, weight: 700 },
	/** Two stacked lines, offset from the hero baseline. */
	stack: { max: 25, min: 12, weight: 700, top: -16, bottom: 12 },
	/** A measured value. Monospaced, so a counting readout does not reflow. */
	value: { max: 38, min: 14, unitSize: 14 },
	/** An inverted field. */
	invert: { size: 20, track: 3, padX: 14 },
	/** A stepping caption drawn beside a chevron. */
	step: { max: 26 },
} as const;

/** The cap-centre a 32px hero occupies on a given baseline. */
export function heroCentre(baseline: number = BAND.hero): number {
	return bandCentre(baseline, 32);
}

/** Draw a {@link Hero} at the hero baseline. Never overflows the surface. */
export function hero(
	s: Surface,
	spec: Hero,
	fill: string,
	opts: { y?: number; maxWidth?: number } = {},
): string {
	const y = opts.y ?? BAND.hero;
	const maxWidth = opts.maxWidth ?? contentWidth(s);
	switch (spec.kind) {
		case "invert":
			// Centred on where the hero TEXT's caps would sit, so an inverted hero and
			// a plain one occupy the same optical band and the key does not jump as a
			// state latches.
			return invertField(s, spec.text, { cy: heroCentre(y), fill, ...HERO.invert });
		case "value":
			return valueWithUnit(s, spec.value, spec.unit, {
				y,
				max: HERO.value.max,
				min: HERO.value.min,
				unitSize: HERO.value.unitSize,
				fill,
				// Monospaced by default: this band is frequencies, counts and clocks,
				// and a proportional face makes them jitter as the digits change.
				mono: spec.mono ?? true,
				maxWidth,
			});
		case "stack":
			return (
				fitText(s, spec.top, {
					y: y + HERO.stack.top,
					max: HERO.stack.max,
					min: HERO.stack.min,
					weight: HERO.stack.weight,
					fill,
					maxWidth,
				}) +
				fitText(s, spec.bottom, {
					y: y + HERO.stack.bottom,
					max: HERO.stack.max,
					min: HERO.stack.min,
					weight: HERO.stack.weight,
					fill,
					maxWidth,
				})
			);
		default:
			return fitText(s, spec.text, {
				y,
				max: HERO.text.max,
				min: HERO.text.min,
				weight: HERO.text.weight,
				fill,
				maxWidth,
			});
	}
}

/** Everything the shared card can draw. Every field is optional. */
export interface CardSpec {
	/** State-rule colour — the fastest "what state is this key in" signal. */
	accent?: string;
	/** Flag chip row. */
	glyphs?: GlyphSpec[];
	/**
	 * Signal strength, drawn as a compact meter at the right of the flag row.
	 * `null`/omitted draws no meter and gives the chips the full width back.
	 */
	signal?: number | null;
	signalGeom?: SignalGeom;
	/** Small tracked caption above the hero. */
	label?: string;
	labelColor?: string;
	/** The primary value. */
	hero?: Hero;
	heroColor?: string;
	/** A drawn chevron beside the hero, for keys that step through a list. */
	heroStep?: "left" | "right" | "up" | "down";
	/** Secondary line under the hero. */
	status?: string;
	statusColor?: string;
	/** Draw the status line as an inverted field rather than as text. */
	statusInvert?: boolean;
	/** Extra SVG appended last (badges, bars). */
	extra?: string;
	/** Override the glass for an exceptional state. */
	bg?: string;
	bgTop?: string;
}

/** The per-product colours {@link card} needs beyond the surface's structural ink. */
export interface CardTheme {
	surface: Surface;
	shell: Shell;
	/** The state-rule colour meaning "nothing to say" — rules of this colour draw unlit. */
	idle: string;
	/** Brighter ink, for the one line on a key that is the answer. */
	inkHi: string;
	/** Secondary ink, for the status line. */
	dim: string;
	/** Chevron colour for a stepping hero. */
	markColor: string;
	/**
	 * Ink for the card's two *state* marks — the signal meter and an inverted
	 * status field. Defaults to the surface's primary ink.
	 *
	 * Separate from {@link CardTheme.inkHi} because these are not the answer the
	 * key is giving, they are annunciators beside it: drawing them at hero
	 * brightness makes a meter shout louder than the channel it belongs to. It is
	 * also the hook an exceptional state hangs off — under emergency a product
	 * recolours these two without touching anything else on the card.
	 */
	stateInk?: string;
}

/**
 * The one card a product's deck keys are built from.
 *
 * Owning the geometry here rather than in each action is what keeps a dozen keys
 * looking like one product. Actions choose content and colour; they do not choose
 * where the hero sits.
 */
export function card(theme: CardTheme, spec: CardSpec): string {
	const s = theme.surface;
	const accent = spec.accent ?? theme.idle;
	const meter = typeof spec.signal === "number";
	const geom = spec.signalGeom ?? SIGNAL_GEOM_ROW;
	const meterW = signalBarsWidth(geom);
	const meterX = s.width - s.inset - meterW;

	let body = "";
	if (spec.glyphs?.length) {
		// Hand the chips only the space the meter is not using, so adding a meter
		// re-centres them instead of drawing underneath them.
		body += glyphRow(s, spec.glyphs, BAND.glyphs, { right: meter ? meterX - 5 : undefined });
	}
	const stateInk = theme.stateInk ?? s.text;
	if (meter) {
		body += signalBars(s, Number(spec.signal), meterX, BAND.glyphs + 1, stateInk, geom);
	}
	// The state rule doubles as the flag row's underline — one hairline, not two.
	body += spec.glyphs?.length || meter
		? stateRule(s, accent, BAND.glyphs + 8, theme.idle)
		: stateRule(s, accent, 30, theme.idle);
	if (spec.label) body += drawLabel(s, spec.label, BAND.label, spec.labelColor ?? theme.dim);
	if (spec.hero) {
		const heroFill = spec.heroColor ?? theme.inkHi;
		// A stepping key draws its caption and its arrow as one centred group, so the
		// two read as a single mark rather than as a word with a stray triangle beside
		// it. Only `text` heroes can step — a value or a stack has no room.
		body +=
			spec.heroStep && spec.hero.kind === "text"
				? stepRow(s, spec.hero.text, {
						dir: spec.heroStep,
						cy: heroCentre(),
						max: HERO.step.max,
						fill: heroFill,
						markFill: theme.markColor,
					})
				: hero(s, spec.hero, heroFill);
	}
	if (spec.status) {
		body += spec.statusInvert
			? invertField(s, spec.status, {
					cy: bandCentre(BAND.status, 16),
					fill: spec.statusColor ?? stateInk,
					size: 12,
				})
			: legend(s, spec.status, BAND.status, spec.statusColor ?? theme.dim, { max: 16 });
	}
	if (spec.extra) body += spec.extra;
	return keyDoc(s, theme.shell, body, { bg: spec.bg, top: spec.bgTop });
}

/**
 * The standard "not connected" placeholder, shared across every action.
 *
 * An unpowered module: the glass is there, the backlight is not. Deliberately the
 * only state on a deck with no lit ink at all — "offline" should look like
 * absence, not like a colour.
 */
export function offlineCard(
	s: Surface,
	shell: Shell,
	primary: string,
	opts: { bg?: string; fill?: string } = {},
): string {
	const fill = opts.fill ?? s.faint;
	return keyDoc(
		s,
		shell,
		drawLabel(s, primary, 70, fill) + drawLabel(s, "no link", 94, fill),
		{ bg: opts.bg, top: opts.bg },
	);
}

export { hairline, centreX, capBaseline };
