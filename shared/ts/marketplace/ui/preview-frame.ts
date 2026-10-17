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
 *
 * `panel` PRECEDES `thumbnail`, AND THAT ORDERING IS THE CONTRACT.
 *
 * The thumbnail branch used to be taken before everything but `sound`, so a
 * dispatch-panel theme that shipped a screenshot showed the picture instead of
 * the product — which is the owner's complaint, in those words: "there should be
 * no 'thumbnail' for dispatch-panel previews". Putting `panel` above it answers
 * that without touching any other type: a `theme` with a live panel surface
 * never resolves to a still image, and a `sound` or a future type carrying a
 * thumbnail is completely unaffected.
 *
 * It is an ordering and NOT a deletion of the thumbnail kind, which was tried
 * and measured wrong: removing it broke `server/web`'s typecheck in tRadio at
 * HEAD and blocked a release, because that host still passes `thumbFailed` and
 * still has a `"thumbnail"` branch to fall through from.
 *
 * `panelPreview` is a parameter for the same reason `thumbFailed` is: only the
 * host knows whether it can mount tRadio's offline panel. tWeb vendors the built
 * panel, tRadio's admin serves it from its own origin, and the in-game NUI is
 * handed its URL by the consumer that opened the browser — a surface with none
 * must not claim a preview it cannot draw, and falls to the theme's swatches.
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
 * Append a `<script>` to a preview document, before `</body>` when the document
 * really has one.
 *
 * The naive `html.replace(/<\/body>/i, script + "</body>")` is wrong here, and
 * measured wrong: marketplace layouts are FRAGMENTS — a real `layouts/HLX-120G/
 * ui.html` has no `<html>`, `<head>` or `<body>` at all — so the only `</body>`
 * in the document can be one inside a `<script>`, in a comment or a string.
 * Splicing there puts a `</script>` in the middle of someone else's script,
 * which ends that script early and dumps the rest of it on screen as text.
 *
 * tRadio's card previews rendered exactly that: its server injects a theme
 * script whose comment reads "injected before </body> by the panel", and the
 * binder landed inside that comment. Every UI layout card showed a wall of
 * black source text where the radio should be.
 *
 * So the search runs over a copy with script bodies and comments blanked to
 * spaces. Blanking rather than deleting keeps every index aligned with the
 * original, so the offset found is the offset to splice at.
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
 * The dispatch-panel preview contract: tRadio builds `preview.html` from the same
 * graph as the shipped panel — same components, same CSS, same chunks — seeded
 * from fixtures where the socket would be, and driven entirely by `postMessage`.
 * Everything below is this estate's half of that protocol.
 *
 * It is a frame URL and not a document because, unlike a `ui` item, nothing here
 * reads or rewrites the markup: the panel is an application, and the host that
 * owns it serves it. Which is also why the URL is the HOST's to supply — tLib has
 * no business naming tRadio.
 */
export const PANEL_PREVIEW_CHANNEL = "tradio-panel-preview";

/**
 * The size the panel LAYS OUT at, before being scaled into whatever box it is
 * given. A dispatch board is built for a desk monitor; rendering it into a
 * 320px tile would collapse every column and show a stack of chrome — the real
 * panel, looking nothing like it. So the frame is always this size and the whole
 * thing is scaled. Matches `PanelFrame`'s `LAYOUT_W`/`LAYOUT_H` in tWeb.
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
 * A catalogue theme definition, as the frame wants it.
 *
 * `extends: "dark"` is not decoration: an install is a delta on the panel's own
 * dark theme, so a theme that sets four variables would otherwise render the
 * other eighteen unset — a preview of a half-painted board. Same reasoning and
 * same value as tWeb's `toPanelTheme`.
 *
 * An empty `jsText` is dropped rather than forwarded. A CSS-only theme carries
 * `""` by the definition's own default, and handing the runner an empty body to
 * compile is a script where there is none.
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
 * Keep only the fields the frame reads, and refuse anything else.
 *
 * The body crosses the marketplace, a Node bundle, the Lua VM and a NUI message
 * before it gets here, and every one of those hands on whatever it was given. A
 * structural check at the point of use is the only one that is actually about
 * this frame's contract — and the only one that cannot be skipped by a route
 * that is not what it claims.
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
 * Is this the frame announcing it has mounted and is ready for a theme?
 *
 * The CALLER must also check `event.source` against the frame's own
 * `contentWindow`, and `event.origin` cannot do that job: the frame is sandboxed
 * without `allow-same-origin`, so it posts from origin `"null"` — which every
 * other opaque frame on the page also posts from. In a grid of tiles, window
 * identity is the only thing that tells two previews apart.
 */
export function isPanelPreviewReady(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const message = data as { source?: unknown; type?: unknown };
  return message.source === PANEL_PREVIEW_CHANNEL && message.type === "ready";
}

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
