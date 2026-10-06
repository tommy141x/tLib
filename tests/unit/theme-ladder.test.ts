/**
 * The elevation ladder in `shared/css/theme-tokens.css`, asserted rather than
 * described.
 *
 * Every component in `shared/ts/ui/*` fills a control with `--input` and draws its
 * edge with `--input` or `--border`, on a panel filled with `--card`. So the file is
 * only correct while
 *
 *     L(background) <= L(card) < L(input) == L(popover) < L(border)
 *
 * holds in EVERY palette block it declares. When it does not, a tLib field and every
 * `border-input` edge become darker than the panel they sit on and the product grows
 * black outlines around things. That has shipped twice — tELS raised `--card`, then
 * tUnit did — and neither time did anything fail. Each token on its own is a
 * perfectly reasonable colour; only the ORDER is wrong, and nothing reads the order.
 *
 * This does. A new palette block (`.tlib-overlay`, or whatever comes after it) that
 * moves one rung without moving the ones around it fails here, at `bun test`, in the
 * repo that owns the tokens — which is the only place the mistake is cheap.
 *
 * Deliberately a TEXT parse of the CSS, not an import of a JS constant mirroring it.
 * A mirror is a second source of truth that can agree with the test while disagreeing
 * with the stylesheet the browser loads, which would make this pass over the bug.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(import.meta.dir, "../../shared/css/theme-tokens.css"), "utf8");

/** The rungs, bottom to top. `--popover` is a peer of `--input`, not a rung of its own. */
const LADDER = ["--background", "--card", "--input", "--border"] as const;

/**
 * Every `<selector> { … }` block in the file that declares at least one ladder token.
 *
 * Comments are stripped first: the header of theme-tokens.css quotes token
 * declarations inside prose ("tELS --background: 0 0% 3.5% → rendered …"), and a
 * naive scan reads those as real and fails on a palette nobody ships.
 */
function paletteBlocks(css: string): { selector: string; body: string }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // `[^{}]+` swallows every statement since the previous block, so the prelude
    // of the first one carries the file's `@layer base, components;` and its
    // `@import "./surface.css";` as well as `:root`. Keep only what follows the
    // last statement terminator. Without this the first block's selector reads
    // `@layer base, components; @import …; :root`, no block matches `:root`, and
    // the ladder assertions throw "no :root palette to inherit from" — which
    // looks like a missing palette rather than a parse that moved.
    const selector = (m[1].split(";").at(-1) ?? "").trim();
    const body = m[2];
    if (LADDER.some((t) => body.includes(`${t}:`))) out.push({ selector, body });
  }
  return out;
}

/**
 * The lightness of an `H S% L%` triple.
 *
 * The tokens are stored as bare HSL COMPONENTS, not colours — every consumer wraps
 * them `hsl(var(--card))` — so the third component is directly comparable across
 * tokens as long as saturation stays low, which the neutral greys here guarantee.
 */
function lightness(body: string, token: string): number | undefined {
  const m = new RegExp(`${token}:\\s*[\\d.]+\\s+[\\d.]+%\\s+([\\d.]+)%`).exec(body);
  return m ? Number.parseFloat(m[1]) : undefined;
}

describe("theme-tokens.css declares at least the two palettes it documents", () => {
  test(":root and .tlib-overlay are both present", () => {
    const selectors = paletteBlocks(CSS).map((b) => b.selector);
    expect(selectors).toContain(":root");
    expect(selectors).toContain(".tlib-overlay");
  });
});

describe("every palette block keeps the elevation ladder in order", () => {
  for (const { selector, body } of paletteBlocks(CSS)) {
    /**
     * A block is allowed to move a SUBSET of the ladder — tELS lowers only
     * `--background` and that is the documented safe case — so absent rungs are
     * inherited from `:root` and filled in here before comparing. Comparing only the
     * rungs a block happens to declare is what would let a lone `--card: 12%` through.
     */
    test(`${selector}`, () => {
      const root = paletteBlocks(CSS).find((b) => b.selector === ":root");
      if (!root) throw new Error("theme-tokens.css has no :root palette to inherit from");

      const value = (token: string) => {
        const own = lightness(body, token);
        if (own !== undefined) return own;
        const inherited = lightness(root.body, token);
        if (inherited === undefined) throw new Error(`:root does not declare ${token}`);
        return inherited;
      };

      const [background, card, input, border] = LADDER.map(value);

      expect(background).toBeLessThanOrEqual(card);
      expect(card).toBeLessThan(input);
      expect(input).toBeLessThan(border);
    });
  }
});

describe("--popover tracks --input", () => {
  /**
   * A dropdown is "one rung above the panel it opened from", which is the same rung a
   * recessed control sits on. When the two drift, a Select trigger and the list it
   * opens are different colours for no reason a reader can name — and if `--popover`
   * drifts DOWN to `--card`, the list is invisible against the panel behind it, which
   * is the "black text on a dark grey selector" report that made tELS and tUnit each
   * fork their own select.
   */
  for (const { selector, body } of paletteBlocks(CSS)) {
    const popover = lightness(body, "--popover");
    if (popover === undefined) continue;
    test(`${selector}`, () => {
      const root = paletteBlocks(CSS).find((b) => b.selector === ":root");
      const input = lightness(body, "--input") ?? lightness(root?.body ?? "", "--input");
      expect(popover).toBe(input as number);
    });
  }
});
