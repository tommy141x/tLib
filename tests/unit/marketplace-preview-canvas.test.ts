/**
 * The canvas tiers, held to their ORDER.
 *
 * This logic is now shared by two surfaces that scale a marketplace layout into a
 * box — tLib's in-game preview overlay and tRadio's admin marketplace cards — which
 * is the whole reason it left `PreviewOverlay.tsx`. Its failure mode is silent: a
 * wrong answer is not an error, only a preview at the wrong scale, so nothing but a
 * test notices when a tier stops winning.
 */

import { describe, expect, it } from "bun:test";
import { parsePreviewCanvasSize } from "../../shared/ts/marketplace/ui/preview-canvas";

const studioComment = (meta: Record<string, unknown>) =>
  `<!-- studio-design:${btoa(JSON.stringify(meta))} -->`;

describe("parsePreviewCanvasSize", () => {
  it("prefers studio-design metadata over every inference below it", () => {
    const html = `${studioComment({ width: 300, height: 406 })}
      <div data-radio-width="111" data-radio-height="222" style="width: 999px; height: 999px"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 300, h: 406 });
  });

  it("falls through malformed studio metadata rather than throwing", () => {
    const html = `<!-- studio-design:bm90anNvbg== -->
      <div data-radio-width="111" data-radio-height="222"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 111, h: 222 });
  });

  it("takes the data-radio-* pair when there is no studio metadata", () => {
    const html = `<div data-radio-width="260" data-radio-height="380" style="width: 900px; height: 900px"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 260, h: 380 });
  });

  it("ignores a lone data-radio-width: half a declaration is not a canvas", () => {
    const html = `<div data-radio-width="260" style="width: 640px; height: 480px"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 640, h: 480 });
  });

  it("falls back to the largest explicit pixel box in the CSS", () => {
    const html = `<style>.a{width:100px;height:50px}.b{width: 640px; height: 480px}</style>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 640, h: 480 });
  });

  it("returns the caller's fallback when nothing answers", () => {
    expect(parsePreviewCanvasSize("<div></div>")).toEqual({ w: 400, h: 400 });
    expect(parsePreviewCanvasSize("<div></div>", { w: 300, h: 406 })).toEqual({ w: 300, h: 406 });
  });
});

describe("the second attribute family", () => {
  /**
   * tWeb's own reader (`src/lib/studio/codec.ts`'s `CANVAS_SIZE_ATTRS`) has
   * carried `data-radar-*` all along while this one did not, so for every tRadar
   * layout the two sides of the same marketplace disagreed about the same
   * document — tWeb read the declared canvas, this fell through to tier 3's
   * largest-CSS-px guess.
   */
  it("reads data-radar-* as tier 2, not as nothing", () => {
    const html = `<div data-radar-width="520" data-radar-height="157" style="width: 900px; height: 900px"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 520, h: 157 });
  });

  it("handles a fractional radar canvas, for the same reason radio needed it", () => {
    const html = `<div data-radar-width="519.5" data-radar-height="157.5"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 519.5, h: 157.5 });
  });

  it("still requires both halves of the radar pair", () => {
    const html = `<div data-radar-width="520" style="width: 640px; height: 480px"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 640, h: 480 });
  });

  it("prefers radio when a document somehow declares both", () => {
    const html = `<div data-radio-width="300" data-radio-height="406" data-radar-width="520" data-radar-height="157"></div>`;
    expect(parsePreviewCanvasSize(html)).toEqual({ w: 300, h: 406 });
  });
});
