/**
 * The module material, and the one place a product binds itself to it.
 *
 * ── What this file is for ──
 *
 * {@link index} already owned **how** things are drawn. It said, in its own
 * header, that a product keeps its palette because "they should share a
 * material, not a vocabulary" — and then left the material itself duplicated in
 * three places. This closes that: the material is here, the vocabulary is not.
 *
 * The split is not a judgement call. Measured across the three products'
 * `render.ts` at the time this was written, fourteen values were byte-identical
 * in all three and every one of them is structural — the glass, the bezel, the
 * unlit segment, the four inks:
 *
 *   bg #090909  bgOff #060606  bgWarn #190a08  card #242424
 *   ink #0d0d0d  text #d2d2d2  dim #8a8a8a  faint #4a4a4a  idle #3a3a3a
 *   bezel #070707  glassTop #171717  edge #2b2b2b  warnTop #26100c
 *   inkHi #f4f4f4
 *
 * Every value that DIFFERED was a state colour — tELS' `blue` is a blackout
 * lamp, tRadio's `tx` is a keyed microphone, tRadar's `white` is your own speed.
 * Those are meanings, they stay with the product, and they are passed in at the
 * call site so a reader can see what a colour is saying.
 *
 * ── Why the greys are true greys ──
 *
 * R = G = B, no exceptions. An earlier pass in tRadio gave the glass and the ink
 * an olive/phosphor cast (#0c1008 glass, #c3cbb2 ink) to imitate a transflective
 * LCD. It did read as a display, but it put a green tinge over literally every
 * key including ones with no state at all, and a green cast on white text is the
 * most noticeable kind of wrong. Colour appears ONLY as state.
 *
 * Instrument colours, not web colours: a Stream Deck sits in peripheral vision
 * next to a monitor, where a saturated hue reads as an alert whether or not
 * anything is wrong. All three palettes started as a web set — Tailwind's in two
 * of them, a backlit faceplate's #ffb020/#ff3b2a/#2fe05a in the third — and that
 * is what made the decks look like a game rather than equipment.
 *
 * ── The 72px budget ──
 *
 * Canvas is 144×144 but a Stream Deck key is **72×72 physical**, so everything is
 * downscaled 2:1 before a human sees it. What survives is one big thing, one
 * medium thing, one small thing — that is the whole information budget of a key,
 * and {@link BAND} is it. The full measurement, and what failed, is in
 * `surface.ts`'s header.
 *
 * ── {@link bindKey} ──
 *
 * Every primitive in this package takes a {@link Surface} as its first argument,
 * so a product's `render.ts` used to carry a one-line wrapper per primitive that
 * did nothing but supply it. Thirteen of those, written out three times, with the
 * same doc comment above each copy. `bindKey` returns them already bound.
 *
 * It is a factory and not a module-level default on purpose: a product supplies
 * its accent and, if it has more than the one alarm wash, its own glass-top
 * derivation. Nothing else varied.
 */

import {
	BAND,
	card as drawCard,
	type CardSpec,
	type CardTheme,
	type Hero,
	hero as drawHero,
	keyDoc,
	type Shell,
} from "./card.ts";
import {
	type GlyphSpec,
	glyphRow as drawGlyphRow,
	hairline,
	invertField as drawInvertField,
	type LedSpec,
	ledRow as drawLedRow,
	stateRule as drawStateRule,
	stepRow as drawStepRow,
	unlitField as drawUnlitField,
} from "./marks.ts";
import {
	levelBar as drawLevelBar,
	type SignalGeom,
	signalBars as drawSignalBars,
	sweepBar as drawSweepBar,
} from "./meters.ts";
import { keySurface, type Surface, type SurfaceInk } from "./surface.ts";
import { fitText as drawFitText, label as drawLabel, legend as drawLegend } from "./text.ts";

/**
 * The structural greys of one recessed LCD module.
 *
 * Nine inks and fills for the glass, four for the shell, one for the answer. No
 * state colours: see this file's header for why that line is where it is.
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
 *
 * Carries the key's geometry plus the STRUCTURAL greys — the ink knocked out of
 * a lit block, an unlit segment's fill, the hairline. State colours are
 * deliberately not in here: they are meaning.
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
	 *
	 * Defaults to the alarm wash and nothing else, which is what two of the three
	 * products need. Override when there is a second exceptional wash — tRadio has
	 * an amber emergency one distinct from the brick-red alarm.
	 *
	 * Derived rather than passed alongside `bg` at every call site because the two
	 * always travel together, and letting a caller set one without the other is how
	 * a wash ends up half-applied.
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
	 *
	 * The chokepoint every key type passes through, which is why the module
	 * material lives behind it rather than in a helper each action has to remember
	 * to call. `bg` overrides the glass floor for exceptional states; the matching
	 * top stop is derived.
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
		},
	) => string;

	/**
	 * A small uppercase tracked caption — the band naming what a key IS.
	 *
	 * Auto-shrinking and truncating like {@link BoundKey.fitText}, so unbounded
	 * text (a zone name, a lane name) can never clip.
	 */
	label: (text: string, y: number, fill?: string, opts?: { maxWidth?: number }) => string;

	/**
	 * A machine word, in the panel's own voice — "ON", "LOCKED", "STAGE 2".
	 *
	 * Uppercase, always. Equipment legends are uppercase, and all three decks had
	 * drifted into drawing "on", "hold" and "press → select" in lowercase next to
	 * keys saying "OFF" — which is what makes the lowercase ones read as leftover
	 * placeholder text rather than as part of the panel.
	 *
	 * User or server content — a tone name, a channel name, a lane name someone
	 * typed — must NOT come through here. That is a name a human chose and it keeps
	 * the case they chose. Case is a property of the string's author.
	 */
	legend: (
		text: string,
		y: number,
		fill?: string,
		opts?: { max?: number; min?: number; maxWidth?: number },
	) => string;

	/**
	 * The state rule across the top of the glass — what replaced the old bright
	 * accent strip, which was the single most "app-like" thing on all three decks.
	 *
	 * A lit hairline with a short energised segment at its left, in the LCD's own
	 * idiom. It carries exactly the same one bit the strip did (what state is this
	 * key in) at a fraction of the visual shout. Pass the product's idle colour for
	 * a key with nothing to say.
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
	 *
	 * `cy` is the block's vertical CENTRE, not a text baseline.
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
		},
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
		},
	) => string;

	/** A row of small indicator lamps for boolean flags. */
	ledRow: (items: LedSpec[], x: number, y: number, spacing?: number, r?: number) => string;

	/** The flag row across the top of the card, drawn as lit/unlit segment chips. */
	glyphRow: (
		items: GlyphSpec[],
		y?: number,
		bounds?: { left?: number; right?: number },
	) => string;

	/** The hairline a segment LCD puts under its flag row. */
	glyphRule: (y?: number) => string;

	/**
	 * A caption with a chevron beside it, laid out as ONE centred group.
	 *
	 * `cy` is the group's optical centre, so it lines up with a band rather than
	 * with a baseline. `fill` defaults to the material's bright ink and `markFill`
	 * to the product's accent.
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
		},
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
		},
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
		},
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
 * ⚠️ The returned functions close over a single {@link Surface}. That is the
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
