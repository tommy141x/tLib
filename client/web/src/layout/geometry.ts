import type { HudAnchor as Anchor, HudLayout as Layout } from "../../../../shared/ts/hud-layout";

export type { HudAnchor as Anchor, HudLayout as Layout } from "../../../../shared/ts/hud-layout";
export interface Component {
  key: string;
  owner: string;
  id: string;
  label: string;
  width: number;
  height: number;
  defaults: Layout;
  layout: Layout;
  minScale: number;
  maxScale: number;
  canHide: boolean;
  canScale: boolean;
  minVisiblePixels?: number;
  minVisibleFraction?: number;
}
/**
 * Everything the placement maths actually reads off a component: its unscaled
 * size and its visibility floor. A live HUD surface knows all four about itself
 * without being a registered editor `Component`, and widening the signatures to
 * this is what lets the drag primitive call the SAME clamp rather than grow a
 * second one. `Component` satisfies it structurally, so no caller changes.
 */
export type Extents = Pick<
  Component,
  "width" | "height" | "minVisiblePixels" | "minVisibleFraction"
>;
export interface Viewport {
  width: number;
  height: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type Corner = "nw" | "ne" | "sw" | "se";
export const anchors: Anchor[] = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Offsets are stored as a ratio of a 1080px-tall reference screen, the same
 * unit the widget's own size already scales by. `x = -40 / 1080` therefore means
 * "40 reference pixels in from the right edge" on 16:9, 16:10, 21:9 and 32:9
 * alike, instead of drifting outward as the viewport gets wider.
 *
 * Centre-anchored components keep a proportional X, because "a quarter of the
 * way across" is what centring a widget is actually expressing.
 */
export const REFERENCE_HEIGHT = 1080;
/** Half of 32:9 is 1.78 reference heights; 4 leaves room without admitting nonsense. */
export const MAX_OFFSET = 4;
/** Applies to every component. Overridable per component, never disableable. */
export const DEFAULT_MIN_VISIBLE_PIXELS = 96;
export const DEFAULT_MIN_VISIBLE_FRACTION = 0.4;
export const SNAP_THRESHOLD = 8;

export function anchorPoint(anchor: Anchor) {
  return {
    x: anchor === "center" ? 0.5 : anchor.endsWith("right") ? 1 : 0,
    y: anchor === "center" ? 0.5 : anchor.startsWith("bottom") ? 1 : 0,
  };
}
/** The pixel span one unit of `layout.x` / `layout.y` buys at this viewport. */
export function offsetUnit(anchor: Anchor, viewport: Viewport) {
  return { x: anchor === "center" ? viewport.width : viewport.height, y: viewport.height };
}
/** Anchor also defines the widget's pivot, so changing scale alone never moves it. */
export function layoutRect(
  component: Pick<Component, "width" | "height">,
  layout: Layout,
  viewport: Viewport
): Rect {
  const factor = (viewport.height / REFERENCE_HEIGHT) * layout.scale;
  const width = component.width * factor,
    height = component.height * factor;
  const pivot = anchorPoint(layout.anchor);
  const unit = offsetUnit(layout.anchor, viewport);
  return {
    left: pivot.x * (viewport.width - width) + layout.x * unit.x,
    top: pivot.y * (viewport.height - height) + layout.y * unit.y,
    width,
    height,
  };
}
/** Backend schema bounds take priority over exact corner/pivot preservation for oversized widgets. */
export function placeRect(layout: Layout, rect: Rect, viewport: Viewport): Layout {
  const pivot = anchorPoint(layout.anchor);
  const unit = offsetUnit(layout.anchor, viewport);
  const offset = (value: number) =>
    Number.isFinite(value) ? clamp(value, -MAX_OFFSET, MAX_OFFSET) : 0;
  return {
    ...layout,
    x: offset((rect.left - pivot.x * (viewport.width - rect.width)) / unit.x),
    y: offset((rect.top - pivot.y * (viewport.height - rect.height)) / unit.y),
  };
}
/** Native safezone scalar: each edge is inset by half the excluded fraction. Guide only. */
export function safezoneRect(viewport: Viewport, scalar: number): Rect {
  const size = clamp(Number.isFinite(scalar) ? scalar : 1, 0, 1);
  // The inset is a fraction of the shorter axis on both axes, so the guide keeps
  // an even visual margin instead of cutting deep into an ultrawide viewport.
  const inset = (Math.min(viewport.width, viewport.height) * (1 - size)) / 2;
  return {
    left: inset,
    top: inset,
    width: Math.max(0, viewport.width - inset * 2),
    height: Math.max(0, viewport.height - inset * 2),
  };
}

/**
 * How much of each axis must stay on screen. Universal: a widget can always be
 * grabbed again, whatever put it where it is — a drag, a resolution change, or a
 * record saved by an older version.
 */
export function minVisible(component: Extents, rect: Rect, viewport: Viewport) {
  const pixels = component.minVisiblePixels ?? DEFAULT_MIN_VISIBLE_PIXELS;
  const fraction = component.minVisibleFraction ?? DEFAULT_MIN_VISIBLE_FRACTION;
  const need = (extent: number, size: number) =>
    Math.min(extent, size, Math.max(pixels, extent * fraction));
  return { x: need(rect.width, viewport.width), y: need(rect.height, viewport.height) };
}
/** Mirrored by HudLayoutSchema.constrain. Applied on drag, scale, nudge, resize and restore. */
export function constrainLayout(component: Extents, layout: Layout, viewport: Viewport): Layout {
  const rect = layoutRect(component, layout, viewport);
  const need = minVisible(component, rect, viewport);
  const left = clamp(rect.left, need.x - rect.width, viewport.width - need.x);
  const top = clamp(rect.top, need.y - rect.height, viewport.height - need.y);
  // An already-legal placement is returned verbatim, so registering a component
  // never rewrites its saved offsets by a float epsilon.
  if (left === rect.left && top === rect.top) return layout;
  return placeRect(layout, { ...rect, left, top }, viewport);
}

export interface SnapTargets {
  x: number[];
  y: number[];
}
/** Safe-zone edges, screen centre lines, and every other widget's edges and centres. */
export function buildSnapTargets(
  entries: { component: Component; layout: Layout }[],
  viewport: Viewport,
  safezone: number,
  excludeKey?: string
): SnapTargets {
  const safe = safezoneRect(viewport, safezone);
  const x = [safe.left, safe.left + safe.width / 2, safe.left + safe.width, viewport.width / 2];
  const y = [safe.top, safe.top + safe.height / 2, safe.top + safe.height, viewport.height / 2];
  for (const entry of entries) {
    if (entry.component.key === excludeKey) continue;
    const rect = layoutRect(entry.component, entry.layout, viewport);
    x.push(rect.left, rect.left + rect.width / 2, rect.left + rect.width);
    y.push(rect.top, rect.top + rect.height / 2, rect.top + rect.height);
  }
  return { x, y };
}
export interface SnapResult {
  dx: number;
  dy: number;
  guides: { x?: number; y?: number };
}
/** Nearest line within the threshold wins, comparing the rect's near edge, centre and far edge. */
export function resolveSnap(
  rect: Rect,
  targets: SnapTargets,
  threshold = SNAP_THRESHOLD
): SnapResult {
  const axis = (positions: number[], lines: number[]) => {
    let best: { delta: number; line: number } | undefined;
    for (const position of positions) {
      for (const line of lines) {
        const delta = line - position;
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, line };
      }
    }
    return best;
  };
  const horizontal = axis(
    [rect.left, rect.left + rect.width / 2, rect.left + rect.width],
    targets.x
  );
  const vertical = axis([rect.top, rect.top + rect.height / 2, rect.top + rect.height], targets.y);
  return {
    dx: horizontal?.delta ?? 0,
    dy: vertical?.delta ?? 0,
    guides: { x: horizontal?.line, y: vertical?.line },
  };
}

/** Pixel-delta move. Snapping is resolved by the caller so it can draw the guides. */
export function moveLayout(
  component: Extents,
  layout: Layout,
  viewport: Viewport,
  dx: number,
  dy: number
): Layout {
  const rect = layoutRect(component, layout, viewport);
  return constrainLayout(
    component,
    placeRect(layout, { ...rect, left: rect.left + dx, top: rect.top + dy }, viewport),
    viewport
  );
}
/**
 * Scale about the anchor pivot: a bottom-right widget grows up and left and stays
 * in its corner. Holding x/y fixed already does this — see `layoutRect`, where the
 * pivot edge of the rect is independent of the widget's size.
 */
export function scaleLayout(
  component: Component,
  layout: Layout,
  viewport: Viewport,
  factor: number
): Layout {
  if (!component.canScale || !Number.isFinite(factor) || factor <= 0) return layout;
  const scale = clamp(
    Math.round(layout.scale * factor * 1000) / 1000,
    component.minScale,
    component.maxScale
  );
  return constrainLayout(component, { ...layout, scale }, viewport);
}
/** Uniform scale projected onto the corner diagonal; opposite corner stays fixed. */
export function resizeLayout(
  component: Component,
  layout: Layout,
  viewport: Viewport,
  corner: Corner,
  dx: number,
  dy: number
): Layout {
  if (!component.canScale) return layout;
  const rect = layoutRect(component, layout, viewport);
  const sx = corner.endsWith("e") ? 1 : -1,
    sy = corner.startsWith("s") ? 1 : -1;
  const ratio =
    1 + (sx * dx * rect.width + sy * dy * rect.height) / (rect.width ** 2 + rect.height ** 2);
  const scale = clamp(
    layout.scale * (Number.isNaN(ratio) ? 1 : ratio),
    component.minScale,
    component.maxScale
  );
  const next = layoutRect(component, { ...layout, scale }, viewport);
  return constrainLayout(
    component,
    placeRect(
      { ...layout, scale },
      {
        ...next,
        left: sx > 0 ? rect.left : rect.left + rect.width - next.width,
        top: sy > 0 ? rect.top : rect.top + rect.height - next.height,
      },
      viewport
    ),
    viewport
  );
}
export function changeAnchor(
  component: Extents,
  layout: Layout,
  viewport: Viewport,
  anchor: Anchor
): Layout {
  if (layout.anchor === anchor) return layout;
  return placeRect({ ...layout, anchor }, layoutRect(component, layout, viewport), viewport);
}
/**
 * Which anchor a widget sitting here should use, so that a resolution change moves
 * it the way the player expects. Derived on drop rather than chosen from a menu:
 * re-anchoring never moves the widget a pixel, it only changes what the saved
 * position means on a different screen.
 */
export function deriveAnchor(rect: Rect, viewport: Viewport): Anchor {
  const cx = (rect.left + rect.width / 2) / viewport.width;
  const cy = (rect.top + rect.height / 2) / viewport.height;
  const middle = (n: number) => n > 1 / 3 && n < 2 / 3;
  if (middle(cx) && middle(cy)) return "center";
  return `${cy < 0.5 ? "top" : "bottom"}-${cx < 0.5 ? "left" : "right"}` as Anchor;
}
/** Re-anchor without moving, then re-clamp. Used after every placement gesture. */
export function reanchor(component: Extents, layout: Layout, viewport: Viewport): Layout {
  const anchor = deriveAnchor(layoutRect(component, layout, viewport), viewport);
  return constrainLayout(component, changeAnchor(component, layout, viewport, anchor), viewport);
}

/**
 * v1 stored X as a fraction of viewport *width*. Convert on the assumption the
 * record was saved at 16:9, which is right for effectively every existing save;
 * Reset recovers the rest. Centre-anchored X was already proportional.
 */
export function migrateOffsets(layout: Layout): Layout {
  if (layout.anchor === "center") return layout;
  return {
    ...layout,
    x: clamp(layout.x * (16 / 9), -MAX_OFFSET, MAX_OFFSET),
  };
}

export function sameLayout(a: Layout, b: Layout) {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.scale === b.scale &&
    a.visible === b.visible &&
    a.anchor === b.anchor
  );
}
