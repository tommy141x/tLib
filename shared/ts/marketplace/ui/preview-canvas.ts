/**
 * "How big is this preview document meant to be?" — one answer, for every surface
 * that scales a marketplace layout into a box.
 *
 * ── Why it is its own module ────────────────────────────────────────────────
 *
 * This logic was inline in `PreviewOverlay.tsx`'s `canvasSize` memo, which made it
 * unreachable from anywhere that is not a Solid component in this tree. tRadio's
 * admin panel needed the same answer and therefore grew its own: a single tier
 * (`data-radio-width`/`data-radio-height`, else a constant), which silently mis-sized
 * every layout that carries studio-design metadata instead — the preview came out
 * letterboxed or cropped and nothing reported an error, because there is no error to
 * report when a scale factor is merely wrong.
 *
 * Extracting it is the alternative to a second copy. It is deliberately pure: a
 * string in, two numbers out. No DOM, no Solid, no fetch — so a Node/bun test or a
 * non-Solid consumer can call it, and so it can be imported by a tree that aliases
 * `@tlib/shared` without dragging the component graph in behind it.
 *
 * ── The tiers, in descending order of trust ─────────────────────────────────
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
   * ⚠️ FRACTIONAL, and this was a real silent defect until 2026-10-07.
   *
   * These were `(\d+)` with `parseInt`, so a half-pixel canvas did not match
   * the regex AT ALL — tier 2 reported nothing and the value fell through to
   * tier 3, which takes the largest CSS px in the document and therefore
   * picks some inner element. Measured on tRadio's shipped heads: **six of
   * eleven** declare a fractional height, and QRX-720 resolved to **98x96**
   * against its real **209.5x426.5**.
   *
   * That is the dangerous shape of wrong — not a blank preview that announces
   * itself, but a confidently-rendered one at a quarter scale, with nothing
   * reporting a failure.
   *
   * tWeb's own reader (`src/lib/studio/codec.ts`) already used `([^"]*)` and
   * handled decimals correctly, so the two sides disagreed about the same
   * attribute. This matches its behaviour; `[\d.]+` with `parseFloat` is
   * narrower than tWeb's catch-all while accepting every value a real layout
   * emits.
   */
  const attrW = Number.parseFloat(html.match(/data-radio-width="([\d.]+)"/)?.[1] ?? "");
  const attrH = Number.parseFloat(html.match(/data-radio-height="([\d.]+)"/)?.[1] ?? "");
  if (attrW > 0 && attrH > 0) return { w: attrW, h: attrH };

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
