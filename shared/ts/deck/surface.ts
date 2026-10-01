/**
 * The drawing surface a deck primitive renders onto.
 *
 * ── Why this exists ──
 *
 * The three product render modules this package replaces each hardcoded two
 * things they had no business hardcoding:
 *
 *   1. **A 144x144 canvas.** Every primitive centred on `CANVAS / 2` and sized
 *      itself against `CANVAS - 24`. That is fine until the Stream Deck+ touch
 *      strip arrives, whose cell is 200x100 — landscape, and half the height. A
 *      primitive that assumes a square cannot draw it.
 *   2. **tRadio's palette.** tELS is a lightbar and tRadar is a radar gun; their
 *      state colours mean different things and they say so in their own file
 *      headers. Baking one product's hues into the shared layer would either
 *      force all three to look identical or force tELS to pass an override to
 *      every call.
 *
 * A `Surface` is the seam. It carries the cell's geometry plus the handful of
 * STRUCTURAL colours a primitive needs internally — the ink knocked out of a lit
 * block, the fill of an unlit segment, the hairline grey. It deliberately does
 * NOT carry state colours (transmit amber, alarm red, scan steel): those are
 * meaning, they differ per product, and every primitive takes them as an explicit
 * argument so a reader can see at the call site what a colour is saying.
 *
 * ── The 72px budget, which is the real constraint ──
 *
 * A key canvas is 144x144 (the @2x size) but a Stream Deck key is **72x72
 * physical**. Everything is downscaled 2:1 before a human sees it, and that is
 * not a detail — it is the design constraint. Measured on true-72px renders:
 *
 *   - A row of three-letter words is unreadable mush. Flags must be *shapes* —
 *     filled chips — not glyph detail.
 *   - Right-aligned secondary data (a talkgroup id, a clock) cannot be read at
 *     all. There is no band for it, deliberately.
 *   - A caption naming the key ("STATUS", "TALK") is both illegible and
 *     redundant: the Stream Deck app already shows the action name in its own UI.
 *
 * What survives 2:1 is one big thing, one medium thing, one small thing. That is
 * the whole information budget of a key.
 */

/** The structural greys every primitive needs, independent of what a key means. */
export interface SurfaceInk {
	/** Text knocked out of a LIT field. Near-black, so it survives any backlight. */
	ink: string;
	/** Unlit segment fill — present but not energised. */
	card: string;
	/** Primary ink. */
	text: string;
	/** Unlit / disabled / off-segment ink. */
	faint: string;
	/** Hairline rules, chip outlines and the glass edge. */
	edge: string;
}

/** A cell to draw into: its geometry plus its structural ink. */
export interface Surface extends SurfaceInk {
	width: number;
	height: number;
	/**
	 * Horizontal inset for content, in px.
	 *
	 * Primitives measure against `width - inset * 2` rather than against a
	 * hardcoded `- 24`, so the same primitive keeps a sane margin on a 144px key
	 * and on a 200px encoder cell.
	 */
	inset: number;
}

/** A standard Stream Deck key face: 144x144 at @2x, 72x72 physical. */
export const KEY_SIZE = 144;

/**
 * One Stream Deck+ encoder cell on the touch strip.
 *
 * The strip is 800x100 across four encoders, so a cell is 200x100 — landscape,
 * and it is NOT downscaled the way a key is. It is also physically further from
 * the eye than the keys and viewed at a steeper angle, which is why the card
 * built on it spends its extra width on a bigger value rather than on more lines.
 */
export const STRIP_CELL = { width: 200, height: 100 } as const;

/** Build a {@link Surface} for a key face from a product's structural ink. */
export function keySurface(ink: SurfaceInk, inset = 12): Surface {
	return { ...ink, width: KEY_SIZE, height: KEY_SIZE, inset };
}

/** Build a {@link Surface} for one encoder cell from a product's structural ink. */
export function stripSurface(ink: SurfaceInk, inset = 10): Surface {
	return { ...ink, width: STRIP_CELL.width, height: STRIP_CELL.height, inset };
}

/** The horizontal centre of a surface. */
export function centreX(s: Surface): number {
	return s.width / 2;
}

/** The widest a piece of content may be before it collides with the inset. */
export function contentWidth(s: Surface): number {
	return s.width - s.inset * 2;
}
