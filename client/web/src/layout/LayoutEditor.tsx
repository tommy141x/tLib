import { createEscapeLayer } from "@tlib/shared/escape-layer";
import {
  type Anchor,
  anchors,
  buildSnapTargets,
  type Component,
  type Corner,
  clamp,
  constrainLayout,
  type Layout,
  layoutRect,
  MAX_OFFSET,
  moveLayout,
  placeRect,
  reanchor,
  resizeLayout,
  resolveSnap,
  type SnapTargets,
  safezoneRect,
  sameLayout,
  scaleLayout,
  type Viewport,
} from "@tlib/shared/hud-geometry";
import { UndoHistory, type UndoState } from "@tlib/shared/undo";
import { createUndoScope } from "@tlib/shared/undo-keys";
import {
  Check,
  Grip,
  LayoutDashboard,
  Redo2,
  RotateCcw,
  ShieldAlert,
  Undo2,
  X,
} from "lucide-solid";
import {
  createMemo,
  createRenderEffect,
  createSignal,
  createStore,
  For,
  onSettled,
  Show,
} from "solid-js";
import { NuiButton } from "@/components/ui/nui-field";
import { applyNuiTheme, nuiThemeDeps } from "@/components/ui/nui-theme";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import ComponentList from "./ComponentList";
import LayoutProxy from "./LayoutProxy";
import { PreviewChannel } from "./preview";
import "./layout.css";

export interface LayoutOpen {
  session: number;
  components: Component[];
  safezone: number;
}
interface Gesture {
  key: string;
  before: Layout;
  x: number;
  y: number;
  pointer?: number;
  corner?: Corner;
  target?: HTMLElement;
}
/**
 * A burst of wheel notches is one thing the player did, so it is one undo step.
 *
 * There is no `before` here any more: the open batch holds it. The first notch
 * calls `history.push`, every later notch in the burst extends that same batch
 * (same label, same key), and `flushWheel` commits it once the burst settles.
 */
interface WheelGesture {
  key: string;
  timer: number;
}
const WHEEL_SETTLE_MS = 250;
const WHEEL_STEP = 0.02;
const WHEEL_STEP_COARSE = 0.1;

/** Mount once alongside the other NUI surfaces. All real HUD rendering remains resource-owned. */
export default function LayoutEditor() {
  const [session, setSession] = createSignal<number | null>(null);
  const [components, setComponents] = createSignal<Component[]>([]);
  const [layouts, setLayouts] = createStore<Record<string, Layout>>({});
  /**
   * The same placements as `layouts`, readable synchronously.
   *
   * A SOLID 2 STORE WRITE IS NOT READABLE IN THE TICK IT HAPPENED, and three
   * things here read a placement back in the tick they wrote it:
   *
   *  - `UndoHistory.with()`, which captures, mutates and captures again inside
   *    one call. Every discrete edit goes through it — hide, show, Reset this,
   *    Reset all.
   *  - `settleKey`, which re-anchors from where the gesture ended.
   *  - any gesture settled by the same event that flushed its last frame: a
   *    quick drag whose only `pointermove` is flushed by its own `pointerup`.
   *
   * Reading the proxy there compares a value against ITSELF. The consequences
   * were not subtle: `capture()` returned the pre-write value, `UndoHistory`
   * discarded the batch as a no-op, and so hiding six components recorded
   * nothing — `canUndo()` stayed false, and that flag IS this editor's dirty
   * flag, so Cancel then threw the whole session away WITHOUT ASKING. The same
   * read made `settleKey` re-anchor the pre-drag placement back over a flicked
   * drag, undoing it.
   *
   * So: the store is what the DOM subscribes to, this is what every decision is
   * made from, and `update()` is the only writer of either.
   */
  let placed: Record<string, Layout> = {};
  const [selected, setSelected] = createSignal("");
  const [viewport, setViewport] = createSignal<Viewport>({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [safezone, setSafezone] = createSignal(1);
  const [guides, setGuides] = createSignal<{ x?: number; y?: number }>({});
  const [scalingKey, setScalingKey] = createSignal("");
  const [finishing, setFinishing] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  /**
   * Whether the discard question is up.
   *
   * Why this editor now has one
   *
   * Cancel called `finish(false)` straight out, which cancels every pending
   * preview and tells the game `save: false` — the backend rolls the HUD back and
   * the whole positioning session is gone. Hand-placing a HUD is minutes of work
   * with no undo once the editor closes, and this surface threw it away without
   * asking.
   *
   * The sentence that used to be here — "this was the ONLY surface in the
   * stack that threw it away without asking: tELS prompts, the prop editor
   * prompts, tAFK prompts" — was WRONG about the prop editor, and being wrong
   * here sent a later audit down the wrong path. tELS and tAFK did prompt;
   * tLib's own shared `PropEditor` did not, and had no dirty tracking anywhere
   * in its chain — Escape and Cancel both called `propEditorCancel` straight
   * out, in tRadar, tDetector and tRadio simultaneously. It prompts now, off the
   * same `isDirty()` this editor uses, so the claim is finally true; it was not
   * when it was written.
   *
   * Gated on `canUndo()`, so Cancel on a session where nothing was touched still
   * closes in one click. The question is only worth asking when there is
   * something to lose, and asking it every time is how a prompt gets dismissed
   * without being read.
   */
  const [discarding, setDiscarding] = createSignal(false);
  const [panelPosition, setPanelPosition] = createSignal<{ x: number; y: number } | null>(null);
  const [panelDragging, setPanelDragging] = createSignal(false);

  let panel: HTMLElement | undefined;
  let panelObserver: ResizeObserver | undefined;
  let panelSize = { width: 320, height: 0 };
  let panelGesture:
    | { pointer: number; x: number; y: number; left: number; top: number; target: HTMLElement }
    | undefined;
  /**
   * One instance, scoped to this editor.
   *
   * This used to be `LayoutHistory`, a class that lived next door and was
   * hard-typed to `Layout`. It is gone; `@tlib/shared/undo`'s `UndoHistory` is
   * the one primitive for the estate and carries both of the things that class
   * knew — `remove(key)` and a no-op guard — as general capabilities. The guard
   * is `sameLayout`, passed per tag at `register()` rather than hard-coded,
   * which is the whole reason the class could not be reused elsewhere.
   *
   * One tag per component (`layout:<key>`), registered when the host announces
   * the component and disposed when it withdraws it. That is what makes an entry
   * per-component — the `key` on the entry — and what makes `remove(key)`
   * meaningful here. This editor is the one surface in the estate that needs it:
   * the host can unregister a HUD component mid-session, and the entries about
   * it are then about something that no longer exists.
   */
  const history = new UndoHistory({ label: "hud-layout" });
  const [undoState, setUndoState] = createSignal<UndoState>(history.state());
  /** `tag` disposers, one per live component. */
  const undoables = new Map<string, () => void>();
  const preview = new PreviewChannel(viewport, () =>
    setNotice("A HUD preview could not be applied. Save will retry; Cancel remains available.")
  );
  let highSession = -1;
  let gesture: Gesture | undefined;
  let wheel: WheelGesture | undefined;
  let snapTargets: SnapTargets | undefined;
  let previousFocus: HTMLElement | undefined;
  let surface: HTMLDivElement | undefined;

  // One index instead of an O(n) find on every pointermove.
  const index = createMemo(() => new Map(components().map((c) => [c.key, c])));
  const active = () => index().get(selected());
  /**
   * Where a component is. The store read is the SUBSCRIPTION the render needs
   * and is load-bearing even though the mirror answers first — drop it and the
   * proxies stop following a drag. The mirror is the VALUE, because for the rest
   * of the tick after a write the two disagree and only the mirror is right.
   */
  const current = (component: Component) => {
    const rendered = layouts[component.key];
    return placed[component.key] ?? rendered ?? component.layout;
  };
  const canUndo = () => undoState().canUndo;
  const canRedo = () => undoState().canRedo;
  /**
   * No edit may start right now: a save is in flight, or the discard question is
   * up and is supposed to be MODAL.
   *
   * `discarding()` belongs here because the question's shade only covers the
   * panel. Everything outside it — every proxy outline, its eye button, the
   * wheel, the arrow keys, the panel's own drag handle — kept working behind a
   * dialog that says "This cannot be undone", so the player could keep
   * positioning a HUD that the pending answer was about to throw away.
   */
  const busy = () => finishing() || discarding();
  const undoTitle = () => {
    const label = undoState().undoLabel;
    return label ? `Undo ${label} · Ctrl Z` : "Nothing to undo";
  };
  const redoTitle = () => {
    const label = undoState().redoLabel;
    return label ? `Redo ${label} · Ctrl Shift Z` : "Nothing to redo";
  };

  // Undo registration
  const tagOf = (key: string) => `layout:${key}`;
  /** What one entry is called. The shared UI renders it as "Undo move Speedometer". */
  const verbFor = (component: Component, verb: string) => `${verb} ${component.label}`;
  function trackComponent(component: Component) {
    const key = component.key;
    undoables.get(key)?.();
    undoables.set(
      key,
      history.register<Layout>(tagOf(key), {
        // The mirror, NEVER the store proxy — see `placed`. This capture runs
        // from `push()`/`commit()`, so a proxy read here both returns a stale
        // value and subscribes the snapshot to the store it is snapshotting.
        capture: () => ({ ...(placed[key] ?? component.layout) }),
        restore: (layout) => update(key, layout),
        // The no-op guard: a gesture that ended where it started records nothing,
        // which is what `LayoutHistory.record`'s early return did.
        equal: sameLayout,
      })
    );
  }
  function untrackComponent(key: string) {
    undoables.get(key)?.();
    undoables.delete(key);
  }
  function untrackAll() {
    for (const dispose of undoables.values()) dispose();
    undoables.clear();
  }

  // Placement
  function update(key: string, layout: Layout) {
    const component = index().get(key);
    if (!component) return;
    // The single choke point for placement: every drag, nudge, scale, resize,
    // undo and resize-response goes through here, so all of them are clamped.
    // The anchor is re-derived once at gesture end; mid-drag it would thrash.
    const next = constrainLayout(component, layout, viewport());
    // Nothing moved, so there is nothing to paint and nothing to tell the game.
    // Worth the two lines because the no-op callers are the bulk ones: `resized`
    // re-clamps EVERY component (one `layoutPreview` post each, for placements
    // that a resize left legal) and `restore` can put a component back where it
    // already is.
    if (placed[key] && sameLayout(placed[key], next)) return;
    placed[key] = next;
    setLayouts((draft) => {
      draft[key] = next;
    });
    preview.queue(key, next);
  }

  /**
   * Re-derive the anchor from where it ended up, then close the open batch.
   *
   * The batch was opened at gesture START (`grab`, the first wheel notch, the
   * first arrow key), so the "before" it compares against is the state the
   * gesture began from — one entry for a whole drag, not one per frame. It no
   * longer takes a `before` argument, because the history holds it.
   */
  function settleKey(key: string) {
    const component = index().get(key);
    const after = placed[key];
    if (!component || !after) {
      history.abort();
      return;
    }
    const anchored = reanchor(component, after, viewport());
    if (!sameLayout(anchored, after)) update(key, anchored);
    history.commit();
  }
  function flushWheel() {
    const burst = wheel;
    wheel = undefined;
    if (!burst) return;
    window.clearTimeout(burst.timer);
    setScalingKey("");
    settleKey(burst.key);
  }
  function releaseGestureCapture(completed: Gesture | undefined) {
    if (completed?.pointer !== undefined && completed.target?.hasPointerCapture(completed.pointer))
      completed.target.releasePointerCapture(completed.pointer);
  }
  function endGesture(cancel = false) {
    if (!gesture) return;
    const completed = gesture;
    gesture = undefined;
    snapTargets = undefined;
    setGuides({});
    // Here rather than at the pointer handlers that used to carry it: the
    // badge is a property of a gesture being in flight, and `settle()` ends
    // one from `blur`, from `resize` and before every discrete edit. Cleared
    // only there, a corner resize interrupted by losing focus left a stale
    // percentage pinned to the widget for the rest of the session.
    setScalingKey("");
    releaseGestureCapture(completed);
    if (!placed[completed.key]) {
      history.abort();
      return;
    }
    if (cancel) {
      update(completed.key, completed.before);
      // The caller has already put the old value back, so there is nothing to
      // compare and nothing to record. `abort` makes no claim about the current
      // state, which is why it is not `commit` on an unchanged batch.
      history.abort();
    } else settleKey(completed.key);
  }
  /** Commit every in-progress gesture before doing something discrete. */
  function settle() {
    // The frame queued by the last pointermove is part of the gesture being
    // settled; dropping it would silently lose up to one frame of the drag.
    flushPointerMove();
    endGesture();
    flushWheel();
  }
  /** One discrete edit — a visibility toggle, a reset — as one entry. */
  function change(component: Component, next: Layout, verb = "change") {
    if (busy()) return;
    settle();
    history.with(
      verbFor(component, verb),
      [tagOf(component.key)],
      () => update(component.key, next),
      component.key
    );
  }
  function toggleVisible(component: Component) {
    if (!component.canHide) return;
    change(
      component,
      { ...current(component), visible: !current(component).visible },
      current(component).visible ? "hide" : "show"
    );
  }
  /**
   * The factory placement for one component, sanitised. `defaults` crosses the
   * NUI boundary as JSON and a consumer can register a component whose defaults
   * predate a schema change, so nothing here may assume the fields are usable:
   * anything non-finite or out of range falls back to a centred, visible widget,
   * and `update()` clamps whatever survives. Reset is the safety net, so it is
   * the one path that must not be able to produce an unreachable widget.
   */
  function factory(component: Component): Layout {
    const d = (component.defaults ?? {}) as Partial<Layout>;
    const now = current(component);
    const number = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? clamp(value, -MAX_OFFSET, MAX_OFFSET)
        : fallback;
    const scale =
      typeof d.scale === "number" && Number.isFinite(d.scale)
        ? clamp(d.scale, component.minScale, component.maxScale)
        : clamp(1, component.minScale, component.maxScale);
    return {
      x: number(d.x, 0),
      y: number(d.y, 0),
      scale: component.canScale ? scale : now.scale,
      visible: component.canHide ? d.visible !== false : now.visible,
      anchor: anchors.includes(d.anchor as Anchor) ? (d.anchor as Anchor) : "center",
    };
  }
  function resetSelected() {
    const component = active();
    if (!component) return;
    change(component, factory(component), "reset");
  }
  /**
   * Every component at once, for when more than one has been lost. History is
   * per component, so this pushes one undo entry per component that MOVED — the
   * ones that were already at their defaults are filtered out by the registered
   * `sameLayout` guard rather than by a hand-written check here, which is what
   * this loop used to carry.
   */
  function resetAll() {
    if (busy()) return;
    settle();
    for (const component of components())
      history.with(
        verbFor(component, "reset"),
        [tagOf(component.key)],
        () => update(component.key, factory(component)),
        component.key
      );
  }
  function travel(direction: "undo" | "redo") {
    if (busy()) return;
    settle();
    // The history applies the snapshot itself through the registered `restore`,
    // which routes back through `update` and so is clamped and previewed like any
    // other placement. What comes back is which entry it applied, so the
    // component that just moved can be re-selected.
    const applied = history[direction]();
    if (applied?.key) setSelected(applied.key);
  }

  // Gestures
  function grab(event: PointerEvent, component: Component, corner?: Corner) {
    if (event.button !== 0 || busy()) return;
    event.preventDefault();
    event.stopPropagation();
    settle();
    endPanelDrag();
    setSelected(component.key);
    surface?.focus({ preventScroll: true });
    // Other widgets hold still for the duration, so their snap lines are computed once.
    snapTargets = buildSnapTargets(
      components().map((c) => ({ component: c, layout: current(c) })),
      viewport(),
      safezone(),
      component.key
    );
    gesture = {
      key: component.key,
      before: { ...current(component) },
      x: event.clientX,
      y: event.clientY,
      pointer: event.pointerId,
      corner,
      target: event.currentTarget as HTMLElement,
    };
    // Open the batch at gesture START. Every frame of the drag then extends it,
    // so the whole drag is one entry; `settleKey` closes it on release.
    history.push(
      verbFor(component, corner ? "resize" : "move"),
      [tagOf(component.key)],
      component.key
    );
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function onWheel(event: WheelEvent, component: Component) {
    if (busy() || !component.canScale) return;
    // Never let a notch scroll the NUI document instead of resizing the widget.
    event.preventDefault();
    event.stopPropagation();
    endGesture();
    if (wheel && wheel.key !== component.key) flushWheel();
    setSelected(component.key);
    if (!wheel) {
      wheel = { key: component.key, timer: 0 };
      history.push(verbFor(component, "resize"), [tagOf(component.key)], component.key);
    } else window.clearTimeout(wheel.timer);
    const burst = wheel;
    burst.timer = window.setTimeout(flushWheel, WHEEL_SETTLE_MS);
    setScalingKey(component.key);
    const step = event.shiftKey ? WHEEL_STEP_COARSE : WHEEL_STEP;
    // Multiplicative, so scrolling up then down returns to where it started.
    update(
      component.key,
      scaleLayout(
        component,
        current(component),
        viewport(),
        event.deltaY < 0 ? 1 + step : 1 / (1 + step)
      )
    );
  }
  // Pointer move, one application per animation frame
  //
  // `pointermove` fires well above the frame rate — a 1000 Hz mouse delivers a
  // coalesced burst per frame at best and several events per frame at worst — and
  // every application writes a store path, which Solid turns straight into a DOM
  // style write. PreviewChannel already coalesced the NUI post (the expensive
  // half); this coalesces the DOM half, so both ends of a drag do exactly one
  // unit of work per frame. Same contract as shared/ts/camera-drag.ts.
  //
  // The delta stays in CLIENT coordinates, unlike camera-drag's `movementX`. That
  // module drives a camera, where there is nothing under the cursor to stay under
  // and a stall at the screen edge is the whole bug. This is direct manipulation:
  // the outline has to stay under the pointer, and `clientX - downX` against the
  // rect captured at pointerdown IS the 1:1 guarantee — accumulating `movementX`
  // would let the outline drift out from under the cursor every time the clamp
  // refuses a frame. Nothing in the loop reads layout, so there is no reflow:
  // `gesture.before`, `snapTargets` and `viewport()` are all captured up front.
  let moveFrame = 0;
  let pendingMove: { x: number; y: number; alt: boolean } | undefined;
  let pendingPanel: { x: number; y: number } | undefined;
  function applyPointerMove() {
    moveFrame = 0;
    const panelTo = pendingPanel;
    const move = pendingMove;
    pendingPanel = undefined;
    pendingMove = undefined;
    if (panelTo && panelGesture) {
      setPanelPosition(
        clampPanel({
          x: panelGesture.left + panelTo.x - panelGesture.x,
          y: panelGesture.top + panelTo.y - panelGesture.y,
        })
      );
    }
    // Captured once: `gesture` is mutable module-scope state and narrowing it
    // across the closure below is what forced the non-null assertions.
    const held = gesture;
    if (!move || !held || finishing()) return;
    const component = index().get(held.key);
    if (!component) return;
    const dx = move.x - held.x,
      dy = move.y - held.y;
    const corner = held.corner;
    if (corner) {
      update(component.key, resizeLayout(component, held.before, viewport(), corner, dx, dy));
      setScalingKey(component.key);
      return;
    }
    const start = layoutRect(component, held.before, viewport());
    let left = start.left + dx,
      top = start.top + dy;
    // Alt suspends snapping for the frames it is held, rather than being a mode.
    let snapGuides: { x?: number; y?: number } = {};
    if (!move.alt && snapTargets) {
      const snap = resolveSnap({ ...start, left, top }, snapTargets);
      left += snap.dx;
      top += snap.dy;
      snapGuides = snap.guides;
    }
    const placed = placeRect(held.before, { ...start, left, top }, viewport());
    // One update pass for the guides and the placement together, so the frame
    // cannot paint a guide line against the previous position. Solid 2 defers
    // every write to the end of the tick, so this no longer needs a `batch`
    // wrapper to get that — the two writes land together by construction.
    setGuides(snapGuides);
    update(component.key, placed);
  }
  function queuePointerMove() {
    if (!moveFrame) moveFrame = requestAnimationFrame(applyPointerMove);
  }
  /** Apply whatever is queued right now. Release must not drop the last frame. */
  function flushPointerMove() {
    if (!moveFrame) return;
    cancelAnimationFrame(moveFrame);
    applyPointerMove();
  }
  function pointerMove(event: PointerEvent) {
    if (panelGesture?.pointer === event.pointerId) {
      pendingPanel = { x: event.clientX, y: event.clientY };
      queuePointerMove();
      return;
    }
    if (!gesture || gesture.pointer !== event.pointerId || finishing()) return;
    pendingMove = { x: event.clientX, y: event.clientY, alt: event.altKey };
    queuePointerMove();
  }
  function pointerUp(event: PointerEvent) {
    if (panelGesture?.pointer === event.pointerId || gesture?.pointer === event.pointerId)
      flushPointerMove();
    if (panelGesture?.pointer === event.pointerId) endPanelDrag();
    if (gesture?.pointer === event.pointerId) {
      endGesture();
    }
  }
  function pointerCancel(event: PointerEvent) {
    // A cancelled gesture is discarded wholesale, so the queued frame is dropped
    // rather than flushed — applying it would be a move the player took back.
    if (moveFrame) {
      cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      pendingMove = undefined;
      pendingPanel = undefined;
    }
    if (panelGesture?.pointer === event.pointerId) endPanelDrag();
    if (gesture?.pointer === event.pointerId) {
      endGesture(true);
    }
  }

  // Panel placement (session-local UI state, never a HUD layout entry)
  function clampPanel(position: { x: number; y: number }) {
    const { width, height } = viewport();
    return {
      x: Math.max(12, Math.min(position.x, width - panelSize.width - 12)),
      y: Math.max(12, Math.min(position.y, height - panelSize.height - 12)),
    };
  }
  function endPanelDrag() {
    const completed = panelGesture;
    panelGesture = undefined;
    setPanelDragging(false);
    if (completed?.target.hasPointerCapture(completed.pointer))
      completed.target.releasePointerCapture(completed.pointer);
  }
  function attachPanel(element: HTMLElement) {
    panel = element;
    panelObserver?.disconnect();
    panelObserver = new ResizeObserver(() => {
      panelSize = { width: element.offsetWidth, height: element.offsetHeight };
      const position = panelPosition();
      if (position) setPanelPosition(clampPanel(position));
    });
    panelObserver.observe(element);
  }
  function startPanelDrag(event: PointerEvent) {
    if (event.button !== 0 || !panel || busy()) return;
    event.preventDefault();
    event.stopPropagation();
    settle();
    endPanelDrag();
    const bounds = panel.getBoundingClientRect();
    panelSize = { width: bounds.width, height: bounds.height };
    const target = event.currentTarget as HTMLElement;
    target.focus({ preventScroll: true });
    panelGesture = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      target,
    };
    setPanelPosition({ x: bounds.left, y: bounds.top });
    setPanelDragging(true);
    target.setPointerCapture(event.pointerId);
  }
  function movePanelWithKeys(event: KeyboardEvent) {
    const direction = arrows[event.key];
    if (!direction || !panel || busy()) return;
    event.preventDefault();
    event.stopPropagation();
    settle();
    endPanelDrag();
    const bounds = panel.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    setPanelPosition(
      clampPanel({ x: bounds.left + direction[0] * step, y: bounds.top + direction[1] * step })
    );
  }

  // Keyboard
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  /*
   * Escape is NOT handled here. It is a registered layer — see the
   * `createEscapeLayer` call in `onSettled` below.
   *
   * It was a branch in this raw `window` listener, which is the pattern the
   * registry exists to replace: a raw listener has no notion of depth, so a key
   * another layer has already consumed still reaches it. This handler does check
   * `event.defaultPrevented`, which is what kept it honest in the meantime, and
   * the registry sets exactly that — but "honest by luck of listener order" is
   * not a contract. The rest of the keys below are editor-local (arrows, Tab
   * cycling, undo/redo) and have no stack to arbitrate.
   */
  function keyDown(event: KeyboardEvent) {
    if (session() === null || event.defaultPrevented) return;
    if (event.key === "Tab" && surface) {
      // While the discard question is up, the cycle is the question's own two
      // answers. Its shade is opaque and covers the panel, but Tab does not care
      // about paint: focus walked straight through to Save, Cancel and the reset
      // buttons behind it, and Enter then pressed one.
      const scope =
        (discarding() && surface.querySelector<HTMLElement>(".tlib-nui-confirm")) || surface;
      const controls = [...scope.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(
        (control) => control.tabIndex >= 0
      );
      const at = controls.indexOf(document.activeElement as HTMLElement);
      if (!controls.length) {
        event.preventDefault();
        surface.focus();
      } else if (event.shiftKey && at <= 0) {
        event.preventDefault();
        controls[controls.length - 1].focus();
      } else if (!event.shiftKey && (at < 0 || at === controls.length - 1)) {
        event.preventDefault();
        controls[0].focus();
      }
      return;
    }
    if (busy()) return;
    /*
     * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are NOT handled here any more. They are a
     * registered scope — see the `createUndoScope` call in `onSettled` below —
     * for the same reason Escape is a registered layer: a raw window listener
     * has no notion of depth, so a press another editor has already consumed
     * still reaches this one. That is not hypothetical for the estate this
     * primitive is for; tRadio's settings app hosts tLib's shared PropEditor
     * inside itself, and two raw listeners means one press undoes in both.
     */
    const direction = arrows[event.key],
      component = active();
    // The panel's own drag handle owns arrows while it is focused.
    if (!direction || !component || gesture?.pointer !== undefined) return;
    if ((event.target as HTMLElement | null)?.closest(".tlib-layout__drag")) return;
    event.preventDefault();
    flushWheel();
    if (!gesture) {
      gesture = { key: component.key, before: { ...current(component) }, x: 0, y: 0 };
      // A held arrow key is one nudge gesture, committed on keyup by `endGesture`.
      history.push(verbFor(component, "move"), [tagOf(component.key)], component.key);
    }
    const step = event.shiftKey ? 10 : 1;
    update(
      component.key,
      moveLayout(
        component,
        current(component),
        viewport(),
        direction[0] * step,
        direction[1] * step
      )
    );
  }
  function keyUp(event: KeyboardEvent) {
    if (event.key.startsWith("Arrow") && gesture?.pointer === undefined) endGesture();
  }
  function resized() {
    settle();
    endPanelDrag();
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    // Re-clamp everything: a smaller window must not strand a widget off-screen.
    for (const component of components()) update(component.key, current(component));
    const position = panelPosition();
    if (position) setPanelPosition(clampPanel(position));
  }
  function blurred() {
    settle();
    endPanelDrag();
  }

  // Session
  function stop() {
    settle();
    endPanelDrag();
    panelObserver?.disconnect();
    panelObserver = undefined;
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMove = undefined;
    pendingPanel = undefined;
    gesture = undefined;
    wheel = undefined;
    snapTargets = undefined;
    preview.reset();
    history.clear();
    untrackAll();
    setSession(null);
    setFinishing(false);
    // The question is about a session that no longer exists. Left standing, it
    // was still standing over the NEXT session: the watchdog closing the editor
    // (focus loss, a dialog, a dead renderer) with the prompt up meant the next
    // `/tlibhud` opened straight into "Discard layout changes".
    setDiscarding(false);
    setComponents([]);
    placed = {};
    setLayouts(() => ({}));
    setGuides({});
    setScalingKey("");
    previousFocus?.isConnected && previousFocus.focus({ preventScroll: true });
    previousFocus = undefined;
  }
  async function finish(save: boolean) {
    const token = session();
    if (token === null || finishing()) return;
    settle();
    endPanelDrag();
    setFinishing(true);
    setNotice("");
    if (save) {
      // The mirror, not the store: `settle()` above can have applied a frame in
      // this very tick, and a retry that re-sends the pre-settle placement is a
      // retry of the wrong thing.
      preview.retryFailed((key) => placed[key]);
      preview.flush();
      // Commit waits for every preview; cancellation does not need their results.
      await preview.settle();
    } else preview.cancel();
    if (session() !== token) return;
    if (save && !preview.allApplied) {
      setFinishing(false);
      setNotice("Changes were not saved: a HUD preview failed. Retry Save or Cancel.");
      return;
    }
    const response = await fetchNui<{ ok: boolean }>("layoutFinish", { session: token, save });
    // The backend owns close/rollback. Do not silently hide a failed callback.
    //
    // Reached at all only when the reply beats the `layoutClose` event it is
    // racing — two different channels, so either order is legal — and the
    // SUCCESS half used to say "You can retry Save or Cancel", which reads as a
    // failure for the half-second before the editor closes on its own. It says
    // what happened instead; the buttons stay live either way, which is the
    // valve for the game never closing us at all.
    if (session() === token) {
      setFinishing(false);
      setNotice(
        response?.ok === true
          ? `${save ? "Saved" : "Discarded"}. Waiting for the game to close the editor…`
          : `The game did not confirm ${save ? "your changes" : "the discard"}. Retry Save or Cancel.`
      );
    }
  }
  /**
   * What Cancel and Escape both go through, so neither can discard silently.
   *
   * `canUndo()` is the dirty flag: the history is cleared on every `layoutOpen`
   * and records an entry for every move, resize, visibility toggle and nudge, so
   * "there is something in it" and "this session changed something" are the same
   * statement. Using it rather than a second `dirty` signal is deliberate — a
   * parallel flag is a thing to forget to set, and there are five call sites that
   * mutate a layout.
   *
   * It settles first, so the flag is read about a FINISHED edit. An open batch
   * counts as dirty whether or not it changed anything, and one can be open
   * here: hold an arrow key against a widget already clamped at the screen edge
   * and press Escape, and the question appeared about a nudge that moved
   * nothing. Settling closes that batch, `sameLayout` discards it as the no-op
   * it was, and the session closes in one keypress like any other clean one.
   */
  function requestCancel() {
    if (session() === null || finishing()) return;
    settle();
    if (canUndo()) {
      setDiscarding(true);
      return;
    }
    void finish(false);
  }

  onSettled(() => {
    const offOpen = onNuiEvent<LayoutOpen>("layoutOpen", (data) => {
      if (!Number.isFinite(data.session) || data.session <= highSession) return;
      highSession = data.session;
      if (session() !== null) stop();
      previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      history.clear();
      untrackAll();
      for (const component of data.components) trackComponent(component);
      preview.open(data.session);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setComponents(data.components);
      const opening = () =>
        Object.fromEntries(data.components.map((c) => [c.key, { ...c.layout }])) as Record<
          string,
          Layout
        >;
      // Seeded together, from the same source, so the first `capture()` of the
      // session compares against what the host actually announced.
      placed = opening();
      setLayouts(opening);
      setSelected(data.components[0]?.key ?? "");
      setSafezone(data.safezone);
      setPanelPosition(null);
      setNotice("");
      setFinishing(false);
      setSession(data.session);
      // A batched replacement session can reuse the same mounted panel.
      if (panel?.isConnected && !panelObserver) attachPanel(panel);
      surface?.focus({ preventScroll: true });
    });
    const offClose = onNuiEvent<{ session: number }>("layoutClose", (data) => {
      if (data.session === session()) stop();
    });
    const offRemove = onNuiEvent<{ session: number; key: string }>("layoutRemove", (data) => {
      if (data.session !== session()) return;
      if (gesture?.key === data.key) {
        releaseGestureCapture(gesture);
        gesture = undefined;
      }
      if (wheel?.key === data.key) {
        window.clearTimeout(wheel.timer);
        wheel = undefined;
      }
      preview.drop(data.key);
      // The HOST withdrew this component, so every entry about it is about
      // something that no longer exists. This is the one `remove(key)` caller in
      // the estate, and the reason that capability is in the shared primitive.
      history.remove(data.key);
      untrackComponent(data.key);
      setComponents((all) => all.filter((c) => c.key !== data.key));
      delete placed[data.key];
      setLayouts((draft) => {
        delete draft[data.key];
      });
      if (selected() === data.key) setSelected(components()[0]?.key ?? "");
    });
    void fetchNui("layoutReady", {
      renderer: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    });
    const heartbeat = window.setInterval(() => {
      const token = session();
      if (token !== null) void fetchNui("layoutHeartbeat", { session: token });
    }, 30_000);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    /*
     * `onInternal` first: while the discard question is up, Escape answers THAT
     * and nothing else. Dismissing the question is the conservative answer —
     * Escape can then never throw a positioning session away, however many times
     * it is pressed, which is the whole point of the question existing.
     */
    const disposeEscape = createEscapeLayer({
      label: "hud-layout-editor",
      depth: 1,
      active: () => session() !== null,
      onInternal: () => {
        if (!discarding()) return false;
        setDiscarding(false);
        return true;
      },
      onEscape: requestCancel,
    });
    /*
     * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, through the shared registry rather than
     * this component's own keydown listener. `onUndo`/`onRedo` are given because
     * travelling here has to settle any in-flight gesture first, and the button
     * pair and the keyboard must go through the SAME function or the two
     * disagree about what one step is.
     *
     * `ignoreWhenTyping` is left at its default (true). This surface has no text
     * entry today, so it changes nothing here, and if one is ever added the field
     * keeps its own native undo for free.
     */
    const disposeUndoKeys = createUndoScope({
      label: "hud-layout-editor",
      depth: 1,
      history,
      active: () => session() !== null && !busy(),
      onUndo: () => travel("undo"),
      onRedo: () => travel("redo"),
    });
    const offHistory = history.onChange(setUndoState);
    window.addEventListener("resize", resized);
    window.addEventListener("blur", blurred);
    // Solid 2's `onSettled` takes its teardown as the RETURNED function rather
    // than through `onCleanup` inside the body.
    return () => {
      offOpen();
      offClose();
      offRemove();
      window.clearInterval(heartbeat);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      disposeEscape();
      disposeUndoKeys();
      offHistory();
      window.removeEventListener("resize", resized);
      window.removeEventListener("blur", blurred);
      stop();
    };
  });

  const safeRect = createMemo(() => safezoneRect(viewport(), safezone()));
  return (
    <Show when={session() !== null}>
      <div
        ref={(element) => {
          surface = element;
          // Two-argument form. There is no theme id to track here, but
          // applyNuiTheme's own revision reads still have to happen in compute
          // or a later setTheme stops repainting this surface.
          createRenderEffect(nuiThemeDeps, () => applyNuiTheme(undefined, element));
        }}
        class="tlib-layout tlib-nui-surface"
        tabindex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="HUD layout editor"
      >
        <div
          class="tlib-layout__safezone"
          style={{
            left: `${safeRect().left}px`,
            top: `${safeRect().top}px`,
            width: `${safeRect().width}px`,
            height: `${safeRect().height}px`,
          }}
        />
        {/* Guides exist only while something is actually lining up against them. */}
        <Show when={guides().x !== undefined}>
          <div
            class="tlib-layout__guide tlib-layout__guide--x"
            style={{ left: `${guides().x}px` }}
          />
        </Show>
        <Show when={guides().y !== undefined}>
          <div
            class="tlib-layout__guide tlib-layout__guide--y"
            style={{ top: `${guides().y}px` }}
          />
        </Show>
        <For each={components()}>
          {(component) => (
            <LayoutProxy
              component={component}
              layout={current(component)}
              viewport={viewport()}
              selected={selected() === component.key}
              scaling={scalingKey() === component.key}
              finishing={finishing()}
              onGrab={grab}
              onWheel={onWheel}
              onToggleVisible={toggleVisible}
            />
          )}
        </For>
        <aside
          ref={attachPanel}
          class={["tlib-layout__panel", { "tlib-layout__panel--dragging": panelDragging() }]}
          style={
            panelPosition()
              ? {
                  left: `${panelPosition()!.x}px`,
                  top: `${panelPosition()!.y}px`,
                  transform: "none",
                }
              : {}
          }
        >
          <header class="tlib-layout__header">
            <NuiButton
              class="tlib-layout__drag"
              aria-label="Move editor panel"
              title="Drag to move · Arrow keys to reposition"
              disabled={finishing()}
              onPointerDown={startPanelDrag}
              onLostPointerCapture={endPanelDrag}
              onKeyDown={movePanelWithKeys}
            >
              <span class="tlib-layout__header-icon">
                <LayoutDashboard aria-hidden="true" />
              </span>
              <span class="tlib-layout__title">HUD layout</span>
              <Grip class="tlib-layout__grip" aria-hidden="true" />
            </NuiButton>
          </header>
          <div class="tlib-layout__body">
            <ComponentList
              components={components()}
              layoutOf={current}
              selected={selected()}
              finishing={finishing()}
              onSelect={(key) => {
                settle();
                setSelected(key);
              }}
              onToggleVisible={toggleVisible}
            />
            {/* The arrow keys are a real gesture here — one nudge per press, 10px
                with Shift, one undo entry for a held burst — and this line was
                the only place in the UI that could say so. */}
            <p class="tlib-layout__help">
              Drag to move · Scroll to resize · Arrow keys nudge · Alt disables snapping
            </p>
            <div class="tlib-layout__actions">
              <div class="tlib-layout__history">
                {/*
                 * The label comes off the history now, so these say what they
                 * will take back — "Undo move Speedometer" — rather than just
                 * "Undo". `shared/ts/ui/undo-redo.tsx` is the same pair for
                 * adopters; this surface keeps NuiButton because that is the
                 * control the rest of this panel is built from.
                 */}
                <NuiButton
                  aria-label={undoTitle()}
                  title={undoTitle()}
                  disabled={finishing() || !canUndo()}
                  onClick={() => travel("undo")}
                >
                  <Undo2 aria-hidden="true" />
                </NuiButton>
                <NuiButton
                  aria-label={redoTitle()}
                  title={redoTitle()}
                  disabled={finishing() || !canRedo()}
                  onClick={() => travel("redo")}
                >
                  <Redo2 aria-hidden="true" />
                </NuiButton>
              </div>
              <NuiButton
                class="tlib-layout__reset"
                disabled={finishing() || !active()}
                title="Restore this component's default placement (undo available)"
                onClick={resetSelected}
              >
                <RotateCcw aria-hidden="true" />
                Reset this
              </NuiButton>
              <NuiButton
                class="tlib-layout__reset tlib-layout__reset-all"
                disabled={finishing() || !components().length}
                title="Restore every component's default placement (undo available)"
                onClick={resetAll}
              >
                <RotateCcw aria-hidden="true" />
                Reset all
              </NuiButton>
            </div>
          </div>
          <Show when={notice()}>
            <p class="tlib-layout__notice" role="status">
              {notice()}
            </p>
          </Show>
          {/*
           * AFFIRMATIVE LEFT, and all four of tLib's affirmative/cancel pairs
           * were moved together to get there.
           *
           * Counted rather than assumed. Before: this editor, the dialog footer
           * and the menu's confirmation all put Cancel left / affirmative right;
           * the shared prop editor put Save left. So tLib was 3–1 the other way,
           * and the audit that raised this counted five surfaces when there are
           * six — it missed the dialog footer and the menu confirmation. Reversing
           * only this one would have left tLib 2–2, which is worse than either
           * convention.
           *
           * Affirmative-left is the side the rest of the stack is already on — the
           * prop editor (tLib's own, mounted by three consumers), tELS and tAFK —
           * and it is the native order on Windows, which is the only OS a FiveM
           * client runs on. A player who confirms in the prop editor and then
           * meets a tLib dialog must not have to re-read the buttons; that
           * inversion is the same class of defect as the accent repainting
           * between two surfaces.
           */}
          <footer>
            <NuiButton
              tone="primary"
              class="tlib-layout__finish"
              aria-label="Save HUD layout"
              disabled={finishing()}
              onClick={() => void finish(true)}
            >
              <Check aria-hidden="true" />
              {finishing() ? "Saving…" : "Save"}
            </NuiButton>
            <NuiButton class="tlib-layout__discard" disabled={finishing()} onClick={requestCancel}>
              <X aria-hidden="true" />
              Cancel
            </NuiButton>
          </footer>
          {/*
           * The discard question, drawn with nui-kit's `.tlib-nui-confirm*`
           * recipe — the same one the dialog's `confirm` field uses and the same
           * shape the menu has always had. One confirmation design in the
           * product, three surfaces that reach for it.
           *
           * `tlib-nui-surface` on the shade rather than relying on an ancestor:
           * this panel is themed from `--tlib-layout-*`, so the `--nui-*` tokens
           * the recipe reads are not otherwise in scope here and every colour in
           * it would resolve to nothing.
           */}
          <Show when={discarding()}>
            <div class="tlib-nui-surface tlib-nui-confirm-shade">
              <div
                class="tlib-nui-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="tlib-layout-discard-title"
                aria-describedby="tlib-layout-discard-question"
              >
                <p class="tlib-nui-confirm-eyebrow">
                  <ShieldAlert aria-hidden="true" />
                  CONFIRM ACTION
                </p>
                <h2 id="tlib-layout-discard-title" class="tlib-nui-confirm-title">
                  Discard layout changes
                </h2>
                <p id="tlib-layout-discard-question" class="tlib-nui-confirm-question">
                  The HUD goes back to where it was before you opened the editor. This cannot be
                  undone.
                </p>
                {/*
                 * THE LOSSY ANSWER IS ON THE RIGHT, and this is NOT the same
                 * rule as the Save/Cancel footer above it. Both are correct and
                 * they point opposite ways on purpose.
                 *
                 * That footer is a primary action beside its escape hatch:
                 * affirmative-left, the convention all four of tLib's
                 * affirmative/cancel pairs were moved to, and the native order
                 * on Windows — the only OS a FiveM client runs on.
                 *
                 * This is a DESTRUCTIVE CONFIRMATION, which is a different
                 * widget answering a different question. The estate rule there
                 * is that the lossy button goes right and the safe one takes the
                 * affirmative slot, because "Keep editing" IS the affirmative
                 * answer to "discard?" — the primary action of this dialog is to
                 * NOT lose the work. tELS's discard guard, tUnit's
                 * `CharacterEditor` footer and tLib's own shared `PropEditor`
                 * prompt are all spelled this way.
                 *
                 * This editor was the odd one out: it put Discard left, with the
                 * primary tone AND the autofocus, under an affirmative-left
                 * reading of a dialog whose affirmative answer is the other
                 * button. So one Enter on the keyboard threw the layout away.
                 * Converged here; the footer above is untouched.
                 *
                 * `data-discard-answer` is the semantic handle, the same role
                 * `data-prop-editor-keep` / `-discard` play in the shared editor:
                 * the captions are prose and an order assertion must not key on
                 * glyphs or on DOM position alone.
                 */}
                <div class="tlib-nui-confirm-actions">
                  <NuiButton
                    data-discard-answer="keep"
                    tone="primary"
                    autofocus
                    onClick={() => {
                      setDiscarding(false);
                      // This button is about to be removed from the document,
                      // which leaves focus on `<body>` — outside the editor's
                      // own dialog. Hand it back where a grab would put it.
                      surface?.focus({ preventScroll: true });
                    }}
                  >
                    {/* The glyphs follow the tone, not the DOM order: the tick
                        belongs on the affirmative answer, which is now this one. */}
                    <Check aria-hidden="true" />
                    Keep editing
                  </NuiButton>
                  <NuiButton
                    data-discard-answer="discard"
                    tone="destructive"
                    onClick={() => {
                      setDiscarding(false);
                      void finish(false);
                    }}
                  >
                    <X aria-hidden="true" />
                    Discard
                  </NuiButton>
                </div>
              </div>
            </div>
          </Show>
        </aside>
      </div>
    </Show>
  );
}
