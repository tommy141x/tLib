/**
 * "How big is this preview document meant to be?" — one answer, for every surface
 * that scales a marketplace layout into a box.
 *
 * A second copy of this is how tRadio's admin panel ended up with a single tier
 * (`data-radio-width`/`-height`, else a constant), which silently mis-sized every
 * layout carrying studio-design metadata instead: the preview came out letterboxed or
 * cropped with nothing reported, because there is no error to report when a scale
 * factor is merely wrong.
 *
 * Pure — a string in, two numbers out. No DOM, no Solid, no fetch, so a bun test or a
 * non-Solid consumer can call it without dragging the component graph in.
 *
 * The tiers, in descending order of trust
 *
 * 1. `<!-- studio-design:<base64 json> -->`. The authoring tool's own record of the
 *    canvas it was drawn on. It is the only tier that is a STATEMENT of intent
 *    rather than an inference, so it wins outright.
 * 2. `data-radio-width` / `data-radio-height` on the root. Both are required: a
 *    document carrying only one of them has not declared a canvas, it has a stray
 *    attribute, and pairing a real width with a guessed height distorts the aspect.
 * 3. The largest explicit pixel `width:`/`height:` in the CSS. A guess, and the one
 *    tier that can be fooled — but a layout is normally its own largest box, and
 *    being close beats the fallback.
 */

/** The canvas a preview document is scaled against. */
export interface PreviewCanvasSize {
  w: number;
  h: number;
}

/**
 * Resolve a preview document's canvas size from its markup.
 *
 * @param html     The preview document, as text.
 * @param fallback Used when no tier answers. Callers differ here on purpose: the
 *                 in-game overlay hosts every resource's layouts and has no shape to
 *                 assume, while tRadio's panel knows an attribute-less radio skin is
 *                 portrait. A wrong fallback is not an error, only a bad scale, so it
 *                 stays the caller's call.
 */
export function parsePreviewCanvasSize(
  html: string,
  fallback: PreviewCanvasSize = { w: 400, h: 400 }
): PreviewCanvasSize {
  const encoded = html.match(/<!--\s*studio-design:([A-Za-z0-9+/=\s]+)-->/)?.[1];
  if (encoded) {
    try {
      const meta = JSON.parse(atob(encoded.trim())) as Record<string, unknown>;
      const w = typeof meta.width === "number" ? meta.width : 0;
      const h = typeof meta.height === "number" ? meta.height : 0;
      if (w > 0 && h > 0) return { w, h };
    } catch {
      /* Malformed metadata is not fatal — fall through to the next tier. */
    }
  }

  /**
   * FRACTIONAL, and BOTH families. Two silent defects lived here.
   *
   * `(\d+)` with `parseInt` meant a half-pixel canvas did not match the regex
   * AT ALL, so tier 2 reported nothing and the value fell through to tier 3's
   * largest-CSS-px guess — some inner element. Six of tRadio's eleven shipped
   * heads declare a fractional height, and QRX-720 resolved to 98x96 against
   * its real 209.5x426.5. tWeb's own reader (`src/lib/studio/codec.ts`) used
   * `([^"]*)` and handled decimals, so the two sides of the same marketplace
   * disagreed about the same attribute.
   *
   * `data-radar-*` was missing entirely, for the identical mis-scale one
   * product over, while tWeb's `CANVAS_SIZE_ATTRS` carried both all along.
   *
   * Tried in order, first complete pair wins. A document carrying both families
   * is not a real case; if one ever appears, radio wins as the older
   * declaration.
   */
  const CANVAS_ATTR_PAIRS: readonly (readonly [RegExp, RegExp])[] = [
    [/data-radio-width="([\d.]+)"/, /data-radio-height="([\d.]+)"/],
    [/data-radar-width="([\d.]+)"/, /data-radar-height="([\d.]+)"/],
  ];
  for (const [wRe, hRe] of CANVAS_ATTR_PAIRS) {
    const attrW = Number.parseFloat(html.match(wRe)?.[1] ?? "");
    const attrH = Number.parseFloat(html.match(hRe)?.[1] ?? "");
    if (attrW > 0 && attrH > 0) return { w: attrW, h: attrH };
  }

  const largest = (re: RegExp) => {
    const values = [...html.matchAll(re)].map((m) => parseInt(m[1] ?? "", 10));
    const finite = values.filter((v) => Number.isFinite(v));
    return finite.length > 0 ? Math.max(...finite) : 0;
  };
  const maxW = largest(/\bwidth:\s*(\d+)px/gi);
  const maxH = largest(/\bheight:\s*(\d+)px/gi);
  if (maxW > 0 && maxH > 0) return { w: maxW, h: maxH };

  return fallback;
}
