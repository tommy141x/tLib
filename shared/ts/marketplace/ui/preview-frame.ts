/**
 * The marketplace preview, as a capability rather than as three implementations.
 *
 * ── Scope, and why it stops where it does ───────────────────────────────────
 *
 * The owner drew this line himself: *"It's okay for the styling of it to not be
 * shared between wind3 and wind4, but the logic and preview/canvas or whatever
 * capability should be."* So this module owns everything about a preview that is
 * NOT styling:
 *
 *   · which canvas the document is scaled against  → `parsePreviewCanvasSize`
 *   · the fit maths                                → `fitScale`
 *   · whether the frame may scroll                 → `PREVIEW_FRAME_ATTRS`
 *   · which preview a given item even gets         → `previewKind`
 *   · what state makes it render populated         → `DEFAULT_HUD_PREVIEW_STATE`
 *
 * and owns none of the class names, tokens or icon packs. tWeb stays
 * presetWind4 + `lucide-solid`; the NUI surfaces stay presetWind3 + `~icons/*`
 * + `--nui-*`. Those are genuinely not portable — CEF 103 has no `oklch()` and
 * no `color-mix()` — and they are also not where any of the reported symptoms
 * live.
 *
 * ── The three symptoms this is the shared home for ──────────────────────────
 *
 * Reported in game, all three on tRadio's admin browse grid:
 *
 *  1. **Scrollbars on the preview.** The scaled wrapper in that panel had no
 *     `overflow`, and the `<iframe>` had no scroll suppression, so any document
 *     one pixel taller than its box grew a scrollbar INSIDE the preview.
 *     `PreviewOverlay.tsx` already set `overflow: hidden` on its wrapper, so the
 *     in-game overlay never showed this and the panel always did — the exact
 *     shape of divergence a shared contract removes. Hence
 *     `previewBoxStyle` and `PREVIEW_FRAME_ATTRS`, which carry it for both.
 *
 *  2. **Preview not fit/scaled right**, and
 *  3. **previews blank with no mock state** — which turned out to be *the same
 *     bug* as (2) rather than a third one. See `fitScale` and
 *     `DEFAULT_HUD_PREVIEW_STATE` below.
 *
 * Pure: numbers and strings in, numbers and strings out. No DOM, no Solid. A
 * Solid surface spreads the returned style object; a test calls it directly.
 */

import { type PreviewCanvasSize, parsePreviewCanvasSize } from "./preview-canvas";

export type { PreviewCanvasSize };
export { parsePreviewCanvasSize };

/**
 * Which preview an item gets, in the one branch order every surface uses.
 *
 * ⚠️ ORDER IS THE CONTRACT, not an implementation detail. `thumbnail` beats the
 * live `ui` render because a thumbnail is what the creator chose to show; the
 * live render beats `swatches` because a `ui` item has no colours; and `none` is
 * a real answer that must draw a placeholder tile at the SAME box size rather
 * than collapsing the card. Three surfaces had three nestings of this and
 * disagreed about where `thumbnail` sat.
 *
 * `thumbFailed` is a parameter rather than something inferred, because only the
 * host knows its `<img>` errored. Passing `true` falls through to the next
 * branch, which is what keeps a dead thumbnail URL from collapsing the slot.
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
 * ── ⚠️ Why this is not a one-liner anybody can re-type ──────────────────────
 *
 * It is the function that was wrong, and it was wrong because of its INPUT
 * rather than its arithmetic. `parsePreviewCanvasSize` matched
 * `data-radio-width="(\d+)"` with `parseInt`, so a fractional canvas did not
 * match tier 2 at all and fell through to tier 3 — "largest explicit px in the
 * CSS" — which picks some inner element. Measured across tRadio's eleven
 * shipped heads on 2026-10-07, **six** resolve wrong under the integer regex:
 *
 *     head        declared        integer regex     correct
 *     ────────    ────────────    ─────────────     ────────────
 *     QRX-720     209.5x426.5     98x96             209.5x426.5
 *     SWX-250     454x864.5       454x168           454x864.5
 *     QRX-760     242x489.5       242x52            242x489.5
 *     QRX-720H    535.5x401.5     153x115           535.5x401.5
 *     KVD-880     550x309.5       550x69            550x309.5
 *     HLX-120     601x215.5       601x84            601x215.5
 *
 * A 209.5x426.5 document rendered into a 98x96 frame does all three reported
 * things at once: the box is the wrong shape (**symptom 2**), the document
 * overflows it and the iframe grows scrollbars (**symptom 1**), and what you can
 * see through that 98x96 window is the top-left corner — a radio's blank bezel —
 * so the preview reads as **symptom 3**, "blank, no mock state", while the mock
 * state is in fact being applied perfectly to pixels outside the window.
 *
 * That is the dangerous shape of wrong: nothing errors, because a bad scale
 * factor is not an error. It is why the geometry belongs behind one tested
 * function with one tested input, and why `clamp` below is explicit.
 *
 * @param allowUpscale `false` (the default) caps at 1 and is right for a
 *   full-size overlay, where blowing a 200px skin up to fill a 1080p dialog
 *   shows nothing but interpolation artefacts. A thumbnail grid passes `true`:
 *   its box is SMALLER than most canvases, and refusing to upscale there would
 *   leave a small layout marooned in the middle of a large tile. The two call
 *   sites genuinely want different answers, so it is a parameter and not a
 *   constant.
 */
export function fitScale(
  canvas: PreviewCanvasSize,
  box: PreviewBox,
  opts: { allowUpscale?: boolean } = {}
): number {
  // A zero or negative canvas would make this Infinity, and a zero box would
  // make it 0 — both produce an invisible preview with no error. Measuring
  // before layout has settled really does hand us a 0-width box, so this is
  // reachable rather than defensive.
  if (!(canvas.w > 0) || !(canvas.h > 0)) return 1;
  if (!(box.w > 0) || !(box.h > 0)) return 1;
  const scale = Math.min(box.w / canvas.w, box.h / canvas.h);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return opts.allowUpscale ? scale : Math.min(scale, 1);
}

/**
 * The style the scaled wrapper must carry.
 *
 * ⚠️ `overflow: hidden` IS THE FIX for the reported scrollbars and is not
 * cosmetic. The wrapper is exactly `canvas` big and then transformed; a document
 * that measures one pixel over — which rounding off a fractional canvas like
 * 426.5 guarantees — scrolls inside it otherwise. `PreviewOverlay.tsx` set this
 * and tRadio's panel did not, which is the whole of why one surface showed
 * scrollbars and the other never did.
 *
 * `flex-shrink: 0` matters for the same reason in a different direction: the
 * wrapper is a flex child in both hosts, and without it the browser shrinks the
 * box BEFORE the transform runs, so the scale factor is computed against a width
 * the element no longer has.
 *
 * Returned as a plain object rather than a string so Solid's `style` prop takes
 * it directly, and so a caller can add its own keys by spreading.
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
    // The grid tile centres by absolute positioning because its media slot is a
    // fixed-aspect box the preview must not stretch; the overlay centres with
    // flexbox. Both end up here so the transform and the positioning cannot
    // disagree about the origin, which is how a centred preview ends up visibly
    // offset by half its own size.
    base.position = "absolute";
    base.top = "50%";
    base.left = "50%";
  }
  return base;
}

/**
 * The attributes and style every preview `<iframe>` must carry.
 *
 * ⚠️ `scrolling="no"` is deprecated in HTML5 and is here ON PURPOSE. The
 * standards-track replacement is `overflow: hidden` applied to the FRAMED
 * document's own root — which we do not control: these are customer-authored
 * documents, and the panel injects into them rather than rewriting them. The
 * attribute is the only scroll suppression a host can apply from outside, and
 * Chrome 103 (CEF) and every current browser still honour it. The wrapper's
 * `overflow: hidden` clips the overflow; this stops a scrollbar being painted
 * over the artwork in the first place.
 *
 * ⚠️ `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, which is load-bearing
 * twice over: it is what lets the injected binder run, and the omission is what
 * keeps the frame in an opaque origin so a customer document cannot reach back
 * into the panel that embedded it. Adding `allow-same-origin` alongside
 * `allow-scripts` would hand arbitrary marketplace HTML the admin session.
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
 * The state a HUD preview is painted with when the host has no better one.
 *
 * ── Why a default exists, when per-resource presets are better ──────────────
 *
 * Because most hosts have no preset, and the fallback was "paint nothing".
 * `previewState` is optional all the way down (`PreviewOverlay.tsx` takes
 * `Record<string, unknown> | null`) and `buildHudPreviewScript` is only called
 * `if (state)`. Surveyed 2026-10-07, exactly three resources supply one, each as
 * a hand-written Lua table: tRadio (`cl_bridge.lua`'s
 * `MARKETPLACE_PREVIEW_STATE`), tRadar and tDetector. **tELS supplies none**, so
 * every tELS layout previewed unbound — every `data-hud-show` element visible at
 * once and every readout left at whatever placeholder the author typed. That is
 * the literal "blank previews… no mock state" for that surface, and no amount of
 * fixing the geometry touches it.
 *
 * So: a resource-specific preset still wins, and should — tRadio derives its own
 * through `deriveBinderState` + `RADIO_PREVIEW_SCENARIOS`, which is strictly
 * better than any table because it can only express states the engine can
 * actually produce. This is what a surface uses when it has nothing, instead of
 * rendering a dead device.
 *
 * ⚠️ Keys are the `data-hud-*` dot paths the grammar reads, nested exactly as
 * the runtime sends them — `leds.power`, not `leds_power`. The preview binder
 * resolves dot paths; a flat object silently matches nothing, which is the
 * documented history of `hud-preview-script.ts` itself.
 *
 * ⚠️ `leds.power: true` is not arbitrary. Pre-binder creator HTML uses that key
 * as an LCD *visibility gate* rather than as a physical lamp, so a default of
 * `false` blanks the entire screen of every older skin — the same judgement
 * `tRadio/client/cl_bridge.lua` and the admin panel's legacy capability profile
 * both make, for the same reason.
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
 *
 * A one-line function with a name, so "this surface chose to render unbound" and
 * "this surface has no preset" stop being the same code. Every call site that
 * previously read `if (state)` and silently skipped the binder should call this.
 */
export function resolvePreviewState(
  hostState: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return hostState && Object.keys(hostState).length > 0 ? hostState : DEFAULT_HUD_PREVIEW_STATE;
}
