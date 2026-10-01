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
