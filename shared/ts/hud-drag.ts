import {
  constrainLayout,
  type Extents,
  type Layout,
  layoutRect,
  placeRect,
  type Rect,
  reanchor,
  type Viewport,
} from "./hud-geometry";

/**
 * Drag a live HUD surface by its own background, while that surface is focused.
 *
 * This is the same gesture the layout editor performs on a `LayoutProxy`, moved
 * to where a device UI can use it on itself: one pointer down, a delta in CLIENT
 * coordinates against the rect captured at pointerdown, one rAF-coalesced apply,
 * and `placeRect` → `constrainLayout` → `reanchor` as the single placement path.
 * Nothing here re-derives geometry; the clamp is literally `constrainLayout`, so
 * a position produced by a background drag is exactly as recoverable as one set
 * in the editor.
 *
 * NOT `./camera-drag.ts`, its sibling here, and not a copy of it. A camera has nothing
 * under the cursor, so it must accumulate `movementX`. This is direct
 * manipulation: the widget has to stay under the pointer, and
 * `clientX - downX` against a fixed start rect IS the 1:1 guarantee.
 * Accumulating `movementX` would let the surface drift out from under the
 * cursor on every frame the clamp refused.
 */

/**
 * What may NOT begin a drag.
 *
 * Two independent conditions, deliberately overlapping, because getting this
 * wrong means a player presses a key and their remote jumps instead:
 *
 *  1. `[data-hud-btn]` — the attribute tLib's own `HudBinder` scans for. It is
 *     not "a convention that controls carry it": it is the ONLY thing that makes
 *     a skin element a control at all, because it is what `scan()` binds a click
 *     to. A new key added to a faceplate therefore excludes itself from dragging
 *     by the same attribute that makes it do anything.
 *  2. Anything focusable or natively/ARIA interactive. A control that somehow
 *     reaches the DOM without `data-hud-btn` is still caught if it is a button,
 *     an input, a `role=`, or merely tabbable — every faceplate key is
 *     `tabindex="0"` for keyboard operation, so this alone would catch them.
 *
 * `[data-hud-nodrag]` is the explicit opt-out for a decorative region that is
 * neither: mark it and it stops being grab surface, with no code change here.
 *
 * Kept as a plain string constant so a test can assert it against `HudBinder`'s
 * own selector rather than against a second list written from memory.
 */
export const HUD_CONTROL_SELECTOR = [
  "[data-hud-btn]",
  "[data-hud-nodrag]",
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  ...[
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "scrollbar",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem",
  ].map((role) => `[role="${role}"]`),
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** True when this pointer target belongs to a control rather than to the background. */
export function isHudControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(HUD_CONTROL_SELECTOR) !== null;
}

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Not cosmetic slop. A press and release on the background with no travel is a
 * CLICK, and committing one writes a placement: `onCommit` is a KVP write and a
 * `commit` notification in tLib, so a player tapping the chassis of their remote
 * re-saved its position every time. A zero-delta `pointermove` is routine —
 * pressure and tilt changes emit one, and CEF emits one on button-down — so
 * `moved` could not be "a pointermove arrived".
 *
 * Measured from the pointerdown, like everything else here, so crossing the
 * threshold hands the surface the WHOLE delta rather than rebasing: the widget
 * stays exactly under the cursor afterwards, which `movementX` accumulation and
 * a rebased origin both give up.
 */
const DRAG_THRESHOLD = 3;

export interface HudDragMetrics extends Extents {
  layout: Layout;
}
export interface HudDragOptions {
  /** The positioned surface. Its background is the grab region; its controls are not. */
  surface: () => HTMLElement | null | undefined;
  /** Size and current placement. Read ONCE per gesture, at pointerdown. */
  metrics: () => HudDragMetrics | undefined;
  /**
   * Whether a background press may start a drag right now (open AND focused).
   *
   * Asked on every move and again on release, not only at pointerdown, so it
   * has to stay cheap — and a gesture in flight when it goes false is abandoned
   * rather than committed.
   */
  enabled: () => boolean;
  /** Clamped placement, at most once per animation frame. */
  onPreview: (layout: Layout) => void;
  /** Re-anchored, clamped final placement. Persist this. */
  onCommit: (layout: Layout) => void;
  /** The gesture was abandoned; the caller drops its preview and keeps the old placement. */
  onCancel?: () => void;
  /** Test seam. Defaults to the window's own inner size. */
  viewport?: () => Viewport;
}

interface Gesture {
  pointer: number;
  /** Where the pointer went down, in client coordinates. */
  x: number;
  y: number;
  /** Everything the loop needs, captured up front so no frame reads layout. */
  rect: Rect;
  layout: Layout;
  extents: Extents;
  viewport: Viewport;
  element: HTMLElement;
  moved: boolean;
}

/**
 * Wire one surface. Returns a disposer; call it from `onCleanup`.
 *
 * Move/up/cancel are on `window`, not on the element, for the same reason the
 * editor does it: pointer capture can be refused, and a gesture that ends
 * outside the surface must still end.
 */
export function attachHudDrag(options: HudDragOptions): () => void {
  const readViewport = () =>
    options.viewport?.() ?? { width: window.innerWidth, height: window.innerHeight };

  let gesture: Gesture | undefined;
  let frame = 0;
  let pending: { x: number; y: number } | undefined;
  let latest: Layout | undefined;

  function release(completed: Gesture | undefined) {
    if (completed?.element.hasPointerCapture?.(completed.pointer))
      completed.element.releasePointerCapture(completed.pointer);
  }

  // One application per frame. `pointermove` fires far above the frame rate and
  // every application is a style write, so coalescing here is what keeps a drag
  // at one DOM write per frame instead of one per event.
  function apply() {
    frame = 0;
    const move = pending;
    pending = undefined;
    const held = gesture;
    if (!move || !held) return;
    const left = held.rect.left + (move.x - held.x);
    const top = held.rect.top + (move.y - held.y);
    // The anchor is held fixed for the duration; re-deriving it mid-drag would
    // thrash the pivot under the pointer. It is re-derived once, on release.
    const placed = constrainLayout(
      held.extents,
      placeRect(held.layout, { ...held.rect, left, top }, held.viewport),
      held.viewport
    );
    latest = placed;
    options.onPreview(placed);
  }
  function queue() {
    if (!frame) frame = requestAnimationFrame(apply);
  }
  /** Release must not drop the frame the last pointermove queued. */
  function flush() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    apply();
  }
  function discard() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    pending = undefined;
  }

  function down(event: PointerEvent) {
    if (event.button !== 0 || !options.enabled()) return;
    // A gesture still open on THIS pointer id cannot be a live one: a pointer
    // cannot go down twice without going up, so its `pointerup` was lost — the
    // window was never focused for it, or the browser swallowed it outside the
    // page. Abandoning it here is what stops one lost release from wedging the
    // surface permanently; a DIFFERENT id is a second finger and is ignored.
    if (gesture) {
      if (gesture.pointer !== event.pointerId) return;
      lost();
    }
    const element = options.surface();
    const metrics = options.metrics();
    if (!element || !metrics) return;
    // Listening on the window in the CAPTURE phase is what lets a press be
    // claimed before a skin's own handler sees it, but it also means every
    // press on the page arrives here. Both of these are the filter: inside this
    // surface, and not on one of its controls.
    if (!element.contains(event.target as Node | null)) return;
    if (isHudControl(event.target)) return;
    // Stops the browser's own image/text drag and the selection it would leave.
    event.preventDefault();
    const viewport = readViewport();
    gesture = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect: layoutRect(metrics, metrics.layout, viewport),
      layout: { ...metrics.layout },
      extents: metrics,
      viewport,
      element,
      moved: false,
    };
    latest = undefined;
    element.setPointerCapture?.(event.pointerId);
  }
  function move(event: PointerEvent) {
    const held = gesture;
    if (!held || held.pointer !== event.pointerId) return;
    // Re-checked every move, not only at pointerdown. The gate going false
    // mid-gesture means the surface stopped being draggable while the button was
    // held — its UI closed, it lost focus, or the shared layout editor took the
    // component over — and committing after that writes a placement the player
    // can no longer see. `onCancel` is exactly the "drop the preview, keep the
    // old placement" answer that wants.
    if (!options.enabled()) return lost();
    if (!held.moved) {
      const dx = event.clientX - held.x,
        dy = event.clientY - held.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      held.moved = true;
    }
    pending = { x: event.clientX, y: event.clientY };
    queue();
  }
  function up(event: PointerEvent) {
    const held = gesture;
    if (!held || held.pointer !== event.pointerId) return;
    flush();
    gesture = undefined;
    release(held);
    const placed = latest;
    latest = undefined;
    // A press that never moved is not a drag, and must not write a placement.
    // Nor may a gesture whose surface stopped being draggable while the pointer
    // was held STILL — the move handler cannot catch that one, because catching
    // it there needs a move.
    if (!held.moved || !placed || !options.enabled()) return options.onCancel?.();
    options.onCommit(reanchor(held.extents, placed, held.viewport));
  }
  function cancel(event: PointerEvent) {
    const held = gesture;
    if (!held || held.pointer !== event.pointerId) return;
    // Cancelled wholesale: the queued frame is dropped rather than flushed,
    // because applying it would be a move the player took back.
    discard();
    gesture = undefined;
    latest = undefined;
    release(held);
    options.onCancel?.();
  }
  function lost() {
    const held = gesture;
    if (!held) return;
    discard();
    gesture = undefined;
    latest = undefined;
    options.onCancel?.();
  }

  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", lost);
  // The rect, the extents and the viewport are all captured ONCE per gesture, so
  // a viewport that changes under a held pointer makes every remaining frame of
  // the drag a placement against a screen that no longer exists. Abandoning is
  // the honest answer: the caller keeps the placement it had, which the resize
  // itself re-clamps, instead of committing one measured in stale pixels.
  window.addEventListener("resize", lost);
  return () => {
    lost();
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", lost);
    window.removeEventListener("resize", lost);
  };
}
