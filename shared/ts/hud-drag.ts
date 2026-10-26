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
 * Same gesture the layout editor performs on a `LayoutProxy`: one pointer down,
 * a delta in client coordinates against the rect captured at pointerdown, one
 * rAF-coalesced apply, `placeRect` → `constrainLayout` → `reanchor` as the one
 * placement path — so a background-dragged position is exactly as recoverable
 * as one set in the editor.
 *
 * Not `./camera-drag.ts`: a camera has nothing under the cursor so it
 * accumulates `movementX`, but this is direct manipulation — `clientX - downX`
 * against a fixed start rect keeps the widget under the pointer; accumulating
 * `movementX` would let it drift on every frame the clamp refused.
 */

/**
 * What may not begin a drag, so a player pressing a key doesn't drag the
 * remote instead: `[data-hud-btn]` (the attribute `HudBinder.scan()` binds a
 * click to — the only thing that makes a skin element a control at all, so a
 * new faceplate key excludes itself from dragging for free) and anything
 * focusable/ARIA-interactive as a backstop (every faceplate key is also
 * `tabindex="0"`). `[data-hud-nodrag]` is the explicit opt-out for a
 * decorative region that is neither.
 *
 * Plain string constant so a test can assert it against `HudBinder`'s own
 * selector, not a second list written from memory.
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
 * How far the pointer must travel before a press becomes a drag. Not cosmetic:
 * a press+release with no travel is a click, and `onCommit` is a KVP write —
 * without this, tapping the chassis re-saves its position every time. A
 * zero-delta `pointermove` is routine (pressure/tilt changes, CEF on
 * button-down), so `moved` can't just mean "a pointermove arrived". Measured
 * from pointerdown so crossing the threshold hands the whole delta rather than
 * rebasing, keeping the widget exactly under the cursor.
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
   * Whether a background press may start a drag right now (open and focused).
   * Asked on every move and again on release, not just pointerdown — must stay
   * cheap — and a gesture in flight when it goes false is abandoned, not
   * committed.
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
    // A gesture still open on this pointer id means its pointerup was lost
    // (unfocused window, or swallowed outside the page) — abandon it rather
    // than let a lost release wedge the surface permanently. A different id is
    // a second finger and is ignored.
    if (gesture) {
      if (gesture.pointer !== event.pointerId) return;
      lost();
    }
    const element = options.surface();
    const metrics = options.metrics();
    if (!element || !metrics) return;
    // Capture-phase listening lets a press be claimed before a skin's own
    // handler sees it, but means every press on the page arrives here too —
    // filtered to inside this surface and not on one of its controls.
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
    // Re-checked every move: the gate going false mid-gesture means the surface
    // stopped being draggable while held (UI closed, lost focus, layout editor
    // took over), and committing after that writes a placement the player can
    // no longer see — `onCancel` drops the preview and keeps the old placement.
    if (!options.enabled()) return lost();
    if (!held.moved) {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
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
    // A press that never moved is not a drag, and a surface that stopped being
    // draggable while held still (no move to catch it in `move()`) must not
    // write a placement either.
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
  // rect/extents/viewport are captured once per gesture, so a resize mid-drag
  // would place against a screen that no longer exists. Abandon instead: the
  // caller keeps its old placement, which the resize itself re-clamps.
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
