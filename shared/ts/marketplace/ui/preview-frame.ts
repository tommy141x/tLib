/**
 * The marketplace preview as a capability: the canvas, the fit maths, the frame
 * contract, which preview an item gets and what state paints it populated. Owns
 * no class names, tokens or icon packs. See ../README.md.
 */

import { type PreviewCanvasSize, parsePreviewCanvasSize } from "./preview-canvas";

export type { PreviewCanvasSize };
export { parsePreviewCanvasSize };

/**
 * Which preview an item gets. Branch order is the contract; `none` is a real answer that
 * draws a placeholder tile rather than collapsing the card. See ../README.md.
 *
 * `panel` precedes `thumbnail` on purpose: that branch used to run before everything but
 * `sound`, so a theme shipping a screenshot showed the picture instead of the live panel —
 * "there should be no 'thumbnail' for dispatch-panel previews". Reordering fixes that without
 * touching other types. Deleting the thumbnail kind instead was tried and broke
 * `server/web`'s typecheck in tRadio at HEAD, which still passes `thumbFailed` into it.
 *
 * `thumbFailed`/`panelPreview` are parameters because only the host knows its `<img>` errored
 * or whether it can mount tRadio's offline panel (tWeb vendors it, tRadio's admin serves it,
 * in-game NUI gets handed a URL) — a surface with neither falls to swatches.
 */
export type PreviewKind = "sound" | "panel" | "thumbnail" | "ui" | "swatches" | "none";

export function previewKind(
  item: {
    type: string;
    preview_url?: string;
    thumbnail?: string;
    preview_colors?: string[];
  },
  opts: { thumbFailed?: boolean; panelPreview?: boolean } = {}
): PreviewKind {
  if (item.type === "sound" && item.preview_url) return "sound";
  if (item.type === "theme" && opts.panelPreview) return "panel";
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
 * The scale factor that fits `canvas` inside `box`. A bad factor fails silently as wrong
 * box, scrollbars, or a blank-looking preview painted outside the window — see ../README.md.
 *
 * @param allowUpscale `false` (default) caps at 1 — right for a full-size overlay, where
 *   upscaling only shows interpolation artefacts. A thumbnail grid passes `true` since its
 *   box is smaller than most canvases.
 */
export function fitScale(
  canvas: PreviewCanvasSize,
  box: PreviewBox,
  opts: { allowUpscale?: boolean } = {}
): number {
  // A zero/negative canvas gives Infinity and a zero box gives 0 — both reachable (layout
  // measured before it settles) rather than defensive, and both an invisible preview.
  if (!(canvas.w > 0) || !(canvas.h > 0)) return 1;
  if (!(box.w > 0) || !(box.h > 0)) return 1;
  const scale = Math.min(box.w / canvas.w, box.h / canvas.h);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return opts.allowUpscale ? scale : Math.min(scale, 1);
}

/**
 * The style the scaled wrapper must carry. `overflow: hidden` and `flex-shrink: 0` are
 * load-bearing, not cosmetic — see ../README.md. A plain object, not a string, so Solid's
 * `style` prop takes it directly and a caller can extend it by spreading.
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
    // Both hosts centre through here so transform and positioning can't disagree about
    // the origin, which would offset a preview by half its own size.
    base.position = "absolute";
    base.top = "50%";
    base.left = "50%";
  }
  return base;
}

/**
 * Append a `<script>` to a preview document, before `</body>` when there is one. The naive
 * `html.replace(/<\/body>/i, script + "</body>")` is wrong: marketplace layouts are
 * fragments (`layouts/HLX-120G/ui.html` has no `<html>`/`<head>`/`<body>`), so the only
 * `</body>` found may sit inside a `<script>` or comment — splicing there ends that script
 * early and dumps its tail as visible text, which is exactly what happened to tRadio's card
 * previews when the binder landed inside a theme script's own `</body>`-injection comment.
 * The search runs over a copy with script bodies and comments blanked to spaces (not
 * deleted, so indices stay aligned with the original) to avoid it.
 */
export function injectBeforeBodyEnd(html: string, script: string): string {
  const masked = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => " ".repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const at = masked.search(/<\/body\s*>/i);
  if (at === -1) return html + script;
  return html.slice(0, at) + script + html.slice(at);
}

/**
 * The attributes every preview `<iframe>` must carry. `scrolling="no"` is deprecated but
 * used on purpose — its replacement applies to the framed document's own root, which we
 * don't control. `sandbox` omits `allow-same-origin` deliberately: adding it beside
 * `allow-scripts` would hand arbitrary marketplace HTML the admin session. See ../README.md.
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
 * The dispatch-panel preview contract: tRadio builds `preview.html` from the same graph as
 * the shipped panel (same components, CSS, chunks), seeded from fixtures where the socket
 * would be, driven by `postMessage`. Below is this estate's half of that protocol. A frame
 * URL, not a document — unlike a `ui` item nothing here reads or rewrites the markup, so the
 * URL stays the host's to supply (tLib has no business naming tRadio).
 */
export const PANEL_PREVIEW_CHANNEL = "tradio-panel-preview";

/**
 * The size the panel lays out at, before being scaled into whatever box it's given. A
 * dispatch board is built for a desk monitor — rendering it into a 320px tile would collapse
 * every column into a stack of chrome. Matches `PanelFrame`'s `LAYOUT_W`/`LAYOUT_H` in tWeb.
 */
export const PANEL_PREVIEW_LAYOUT: PreviewCanvasSize = { w: 1600, h: 950 };

/** A published theme definition, as the catalogue's `/items/<slug>/theme` serves it. */
export interface PanelThemeDefinition {
  cssVars?: Record<string, string>;
  cssText?: string;
  jsText?: string;
  template?: string;
  slots?: Record<string, string>;
}

/** A theme as the preview frame accepts it — `PreviewControls`'s `PreviewTheme`. */
export interface PanelPreviewTheme {
  id: string;
  name: string;
  extends: string;
  cssVars: Record<string, string>;
  cssText?: string;
  template?: string;
  slots?: Record<string, string>;
  jsText?: string;
}

/**
 * A catalogue theme definition, as the frame wants it. `extends: "dark"` isn't decoration —
 * an install is a delta on the panel's own dark theme, so a 4-variable theme would otherwise
 * render the other eighteen unset (same reasoning as tWeb's `toPanelTheme`). An empty
 * `jsText` is dropped: a CSS-only theme carries `""` by default, and compiling an empty
 * body is a script where there is none.
 */
export function toPanelPreviewTheme(
  id: string,
  definition: PanelThemeDefinition,
  name?: string
): PanelPreviewTheme {
  return {
    id,
    name: name || id,
    extends: "dark",
    cssVars: definition.cssVars ?? {},
    ...(definition.cssText ? { cssText: definition.cssText } : {}),
    ...(definition.template ? { template: definition.template } : {}),
    ...(definition.slots ? { slots: definition.slots } : {}),
    ...(definition.jsText?.trim() ? { jsText: definition.jsText } : {}),
  };
}

/**
 * Keep only the fields the frame reads, refuse anything else. The body crosses the
 * marketplace, a Node bundle, the Lua VM and a NUI message before it gets here, each hop
 * passing on whatever it was given — a structural check here is the one that cannot be
 * skipped by a route that isn't what it claims.
 */
export function parsePanelThemeDefinition(raw: unknown): PanelThemeDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const definition: PanelThemeDefinition = {};
  if (isStringMap(source.cssVars)) definition.cssVars = source.cssVars;
  if (typeof source.cssText === "string") definition.cssText = source.cssText;
  if (typeof source.jsText === "string") definition.jsText = source.jsText;
  if (typeof source.template === "string") definition.template = source.template;
  if (isStringMap(source.slots)) definition.slots = source.slots;
  return definition;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Is this the frame announcing it mounted and is ready for a theme? The caller must also
 * check `event.source` against the frame's own `contentWindow` — `event.origin` can't do
 * that job, since the sandboxed frame posts from origin `"null"` like every other opaque
 * frame on the page. In a grid of tiles, window identity is the only thing telling previews apart.
 */
export function isPanelPreviewReady(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const message = data as { source?: unknown; type?: unknown };
  return message.source === PANEL_PREVIEW_CHANNEL && message.type === "ready";
}

/**
 * The state a HUD preview paints when the host supplies none — most hosts have none, and
 * the fallback used to paint nothing. See ../README.md. Keys are `data-hud-*` dot paths,
 * nested as the runtime sends them (`leds.power`, not `leds_power` — a flat object matches
 * nothing). `leds.power: true` matters: older creator HTML uses it as an LCD visibility
 * gate, not a lamp, so `false` blanks the whole screen.
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
