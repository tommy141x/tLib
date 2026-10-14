/**
 * The marketplace preview as a capability: the canvas, the fit maths, the frame
 * contract, which preview an item gets and what state paints it populated. Owns
 * no class names, tokens or icon packs. See ../README.md.
 */

import { type PreviewCanvasSize, parsePreviewCanvasSize } from "./preview-canvas";

export type { PreviewCanvasSize };
export { parsePreviewCanvasSize };

/**
 * Which preview an item gets. The branch order is the contract, not an
 * implementation detail, and `none` is a real answer that draws a placeholder
 * tile at the same box size rather than collapsing the card. See ../README.md.
 *
 * `thumbFailed` is a parameter because only the host knows its `<img>` errored;
 * passing `true` falls through and keeps a dead URL from collapsing the slot.
 */
export type PreviewKind = "sound" | "thumbnail" | "ui" | "swatches" | "none";

export function previewKind(
  item: {
    type: string;
    preview_url?: string;
    thumbnail?: string;
    preview_colors?: string[];
  },
  opts: { thumbFailed?: boolean } = {}
): PreviewKind {
  if (item.type === "sound" && item.preview_url) return "sound";
  if (!opts.thumbFailed && item.thumbnail) return "thumbnail";
  if (item.type === "ui") return "ui";
  if (item.preview_colors && item.preview_colors.length > 0) return "swatches";
  return "none";
}

/** A box a preview is being fitted into, in CSS pixels. */
export interface PreviewBox {
  w: number;
  h: number;
}

/**
 * The scale factor that fits `canvas` inside `box`.
 *
 * A bad scale factor is not an error, so this fails silently and in three shapes
 * at once — wrong box, scrollbars, and an apparently blank preview whose mock
 * state is being painted outside the window. ../README.md has the measurement.
 *
 * @param allowUpscale `false` (the default) caps at 1, right for a full-size
 *   overlay where upscaling shows only interpolation artefacts. A thumbnail grid
 *   passes `true`, because its box is smaller than most canvases and refusing to
 *   upscale maroons a small layout in a large tile.
 */
export function fitScale(
  canvas: PreviewCanvasSize,
  box: PreviewBox,
  opts: { allowUpscale?: boolean } = {}
): number {
  // A zero or negative canvas gives Infinity and a zero box gives 0, both an
  // invisible preview with no error. Measuring before layout settles really does
  // hand us a 0-width box, so this is reachable rather than defensive.
  if (!(canvas.w > 0) || !(canvas.h > 0)) return 1;
  if (!(box.w > 0) || !(box.h > 0)) return 1;
  const scale = Math.min(box.w / canvas.w, box.h / canvas.h);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return opts.allowUpscale ? scale : Math.min(scale, 1);
}

/**
 * The style the scaled wrapper must carry. `overflow: hidden` and
 * `flex-shrink: 0` are both load-bearing, not cosmetic — see ../README.md.
 *
 * A plain object rather than a string, so Solid's `style` prop takes it directly
 * and a caller can add keys by spreading.
 */
export function previewBoxStyle(
  canvas: PreviewCanvasSize,
  scale: number,
  opts: { center?: boolean } = {}
): Record<string, string> {
  const base: Record<string, string> = {
    width: `${canvas.w}px`,
    height: `${canvas.h}px`,
    transform: opts.center ? `translate(-50%, -50%) scale(${scale})` : `scale(${scale})`,
    "transform-origin": "center center",
    overflow: "hidden",
    "flex-shrink": "0",
  };
  if (opts.center) {
    // Both hosts centre through here so the transform and the positioning cannot
    // disagree about the origin, which offsets a preview by half its own size.
    base.position = "absolute";
    base.top = "50%";
    base.left = "50%";
  }
  return base;
}

/**
 * The attributes every preview `<iframe>` must carry.
 *
 * `scrolling="no"` is deprecated and used on purpose: the replacement applies to
 * the framed document's own root, which we do not control. `sandbox` omits
 * `allow-same-origin` deliberately — adding it beside `allow-scripts` would hand
 * arbitrary marketplace HTML the admin session. See ../README.md.
 */
export const PREVIEW_FRAME_ATTRS = {
  sandbox: "allow-scripts",
  scrolling: "no",
} as const;

export const PREVIEW_FRAME_STYLE: Record<string, string> = {
  width: "100%",
  height: "100%",
  border: "none",
  display: "block",
  overflow: "hidden",
};

/**
 * The state a HUD preview is painted with when the host supplies none. A
 * resource-specific preset still wins and should; this exists because most hosts
 * have none and the fallback was painting nothing. See ../README.md.
 *
 * Keys are the `data-hud-*` dot paths, nested exactly as the runtime sends them —
 * `leds.power`, not `leds_power`. A flat object silently matches nothing.
 * `leds.power: true` is not arbitrary: older creator HTML uses that key as an LCD
 * visibility gate rather than as a lamp, so `false` blanks the whole screen.
 */
export const DEFAULT_HUD_PREVIEW_STATE: Record<string, unknown> = Object.freeze({
  ln01: "CH 01",
  ln02: "DISPATCH",
  time: "12:34",
  leds: Object.freeze({
    power: true,
    connected: true,
    transmit: false,
    send: false,
    receive: false,
  }),
  led: Object.freeze({ r: 0, g: 255, b: 0, a: 1 }),
  signal: "4",
  battery: "4",
  gps: true,
  scan: false,
  trunk: false,
  warn: false,
  alertVisible: false,
  alertMessage: "EMERGENCY",
  btn01: "ZN",
  btn02: "CH",
  btn03: "ST",
  btn04: "",
  btn05: "",
  theme: "Dark",
});

/**
 * Resolve the state to paint: the host's preset if it has one, else the default.
 * Named rather than inlined so "chose to render unbound" and "has no preset" stop
 * being the same code — a call site reading `if (state)` skips the binder.
 */
export function resolvePreviewState(
  hostState: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return hostState && Object.keys(hostState).length > 0 ? hostState : DEFAULT_HUD_PREVIEW_STATE;
}
