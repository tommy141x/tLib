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
/** One wheel burst is one undo step: the first notch opens the batch, later notches extend it, `flushWheel` commits it once the burst settles. */
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
   * Mirror of `layouts`, readable synchronously — a Solid 2 store write isn't
   * readable in the same tick it happened, and `UndoHistory.with()`,
   * `settleKey`, and a gesture settled by its own last pointermove frame all
   * read a placement back same-tick. Reading the store proxy there used to
   * compare a value against itself: `capture()` got the pre-write value, so
   * hiding six components recorded nothing (`canUndo()` stayed false, which
   * is this editor's dirty flag, so Cancel discarded without asking), and
   * `settleKey` re-anchored the pre-drag placement back over a flicked drag.
   * `update()` is the only writer of either.
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
   * Whether the discard question is up. Cancel used to call `finish(false)`
   * straight out, discarding a hand-placed HUD with no undo once the editor
   * closed. Gated on `canUndo()` so a session where nothing was touched still
   * closes in one click — asking every time is how a prompt stops being read.
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
   * One instance, scoped to this editor. One tag per component
   * (`layout:<key>`) is what makes `remove(key)` meaningful: this editor is
   * the one surface where the host can unregister a component mid-session.
   * The no-op guard is `sameLayout`, passed per tag at `register()`.
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
   * The store read is the subscription the render needs — drop it and the
   * proxies stop following a drag — but the mirror is the value: for the
   * rest of the tick after a write the two disagree and only it is right.
   */
  const current = (component: Component) => {
    const rendered = layouts[component.key];
    return placed[component.key] ?? rendered ?? component.layout;
  };
  const canUndo = () => undoState().canUndo;
  const canRedo = () => undoState().canRedo;
  /**
   * No edit may start during a save, or while the discard question is up.
   * The question's shade only covers the panel, so without `discarding()`
   * here every proxy, the wheel, arrow keys and the panel drag kept working
   * behind a dialog saying the session was about to be thrown away.
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
        // The mirror, never the store proxy — see `placed`. A proxy read
        // here would return a stale value and subscribe the snapshot to the
        // store it's snapshotting.
        capture: () => ({ ...(placed[key] ?? component.layout) }),
        restore: (layout) => update(key, layout),
        // No-op guard: a gesture that ended where it started records nothing.
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
    // Single choke point: every drag, nudge, scale, resize, undo and
    // resize-response is clamped here. Anchor is re-derived once at gesture
    // end rather than mid-drag, to avoid thrashing.
    const next = constrainLayout(component, layout, viewport());
    // No-op guard matters for the bulk callers: `resized` re-clamps every
    // component and `restore` can put one back where it already is.
    if (placed[key] && sameLayout(placed[key], next)) return;
    placed[key] = next;
    setLayouts((draft) => {
      draft[key] = next;
    });
    preview.queue(key, next);
  }

  /**
   * Re-derives the anchor from where the gesture ended, then closes the
   * batch opened at gesture start — one undo entry per drag, not per frame.
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
    // Cleared here, not in the pointer handlers: `settle()` also ends a
    // gesture from blur/resize/before a discrete edit, and clearing it only
    // there left a stale scaling percentage pinned after a focus loss.
    setScalingKey("");
    releaseGestureCapture(completed);
    if (!placed[completed.key]) {
      history.abort();
      return;
    }
    if (cancel) {
      update(completed.key, completed.before);
      // The old value is already restored — nothing to compare or record.
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
   * Factory placement, sanitised. `defaults` crosses the NUI boundary as JSON
   * and may predate a schema change, so anything non-finite or out of range
   * falls back to a centred, visible widget; `update()` clamps the rest.
   * Reset is the safety net and must not produce an unreachable widget.
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
   * One undo entry per component that actually moved — components already
   * at their defaults are filtered by the registered `sameLayout` guard
   * rather than a hand-written check.
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
    // `restore` routes through `update`, so the applied snapshot is clamped
    // and previewed like any other placement; re-select whichever moved.
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
  // One application per animation frame: a 1000 Hz mouse delivers several
  // pointermove events per frame, and every application is a store write
  // Solid turns into a DOM style write. PreviewChannel coalesces the NUI
  // post; this coalesces the DOM half — same contract as
  // shared/ts/camera-drag.ts. Deltas stay in CLIENT coordinates, not
  // `movementX`: this is direct manipulation, so the outline must track the
  // cursor 1:1, and accumulating `movementX` would drift whenever the clamp
  // refuses a frame.
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
    // Captured once: `gesture` is mutable module-scope state, narrowed for the closure below.
    const held = gesture;
    if (!move || !held || finishing()) return;
    const component = index().get(held.key);
    if (!component) return;
    const dx = move.x - held.x;
    const dy = move.y - held.y;
    const corner = held.corner;
    if (corner) {
      update(component.key, resizeLayout(component, held.before, viewport(), corner, dx, dy));
      setScalingKey(component.key);
      return;
    }
    const start = layoutRect(component, held.before, viewport());
    let left = start.left + dx;
    let top = start.top + dy;
    // Alt suspends snapping for the frames it is held, rather than being a mode.
    let snapGuides: { x?: number; y?: number } = {};
    if (!move.alt && snapTargets) {
      const snap = resolveSnap({ ...start, left, top }, snapTargets);
      left += snap.dx;
      top += snap.dy;
      snapGuides = snap.guides;
    }
    const placed = placeRect(held.before, { ...start, left, top }, viewport());
    // Guides and placement update together so a frame never paints a guide
    // against the stale position; Solid 2 defers writes to tick end, so no
    // `batch` wrapper is needed for that.
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
    // A cancelled gesture is discarded wholesale: drop the queued frame rather than flush it.
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
   * Escape is a registered layer (`createEscapeLayer` in `onSettled` below),
   * not handled here — a raw listener has no notion of depth, so a key
   * another layer already consumed would still reach it.
   */
  function keyDown(event: KeyboardEvent) {
    if (session() === null || event.defaultPrevented) return;
    if (event.key === "Tab" && surface) {
      // While the discard question is up, Tab cycles its own two answers —
      // its shade only covers paint, not focus, so without this scope it
      // walked through to Save/Cancel/reset behind it.
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
     * Ctrl+Z/Shift+Z/Y are a registered scope (`createUndoScope` in
     * `onSettled` below), for the same depth reason as Escape — tRadio hosts
     * tLib's shared PropEditor inside itself, and two raw listeners would
     * undo both at once.
     */
    const direction = arrows[event.key];
    const component = active();
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
    // The question is about a session that no longer exists; left standing
    // it carried into the next one — a watchdog close (focus loss, a dialog,
    // a dead renderer) with the prompt up opened the next session into it.
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
      // The mirror, not the store: `settle()` can apply a frame this same
      // tick, and retrying the pre-settle placement would retry the wrong thing.
      preview.retryFailed((key) => placed[key]);
      preview.flush();
      // Commit waits for every preview; cancellation doesn't need their results.
      await preview.settle();
    } else preview.cancel();
    if (session() !== token) return;
    if (save && !preview.allApplied) {
      setFinishing(false);
      setNotice("Changes were not saved: a HUD preview failed. Retry Save or Cancel.");
      return;
    }
    const response = await fetchNui<{ ok: boolean }>("layoutFinish", { session: token, save });
    // The backend owns close/rollback; don't hide a failed callback. Reached
    // only if this reply beats the racing `layoutClose` event — either order
    // is legal — so the buttons stay live either way rather than implying failure.
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
   * What Cancel and Escape both go through, so neither discards silently.
   * `canUndo()` is the dirty flag — history is cleared on `layoutOpen` and
   * records every edit, so a separate `dirty` signal would be one more thing
   * to forget to set. Settles first so an open no-op batch (an arrow key
   * held against an already-clamped edge) doesn't trigger the question.
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
      // Seeded from the same source so the first `capture()` compares against what the host announced.
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
      // The host withdrew this component; every entry about it is now about
      // something that no longer exists — the one `remove(key)` caller.
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
     * `onInternal` first: while the discard question is up, Escape answers
     * only that, so it can never throw the session away however many times
     * it's pressed.
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
     * `onUndo`/`onRedo` settle any in-flight gesture before travelling, and
     * the button pair must go through the same function as the keyboard or
     * the two disagree about what one step is. `ignoreWhenTyping` stays at
     * its default — no text entry on this surface yet.
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
            {/* Arrow-key nudge (10px with Shift, one undo entry per held burst) has no other home in the UI. */}
            <p class="tlib-layout__help">
              Drag to move · Scroll to resize · Arrow keys nudge · Alt disables snapping
            </p>
            <div class="tlib-layout__actions">
              <div class="tlib-layout__history">
                {/* Label comes off the history, so these read "Undo move Speedometer", not just "Undo". `internal/shared-ts/ui/undo-redo.tsx` is the adopter equivalent. */}
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
           * Affirmative-left, matching the prop editor, tLS and tAFK, and the
           * native Windows order — the only OS a FiveM client runs on.
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
           * recipe (shared with Dialog's `confirm` field and the menu).
           * `tlib-nui-surface` on the shade because this panel is themed
           * from `--tlib-layout-*`, so the recipe's `--nui-*` tokens aren't
           * otherwise in scope here.
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
                 * Destructive confirmation: the lossy button goes right and
                 * "Keep editing" takes the affirmative/primary slot —
                 * opposite of the Save/Cancel footer above, which pairs a
                 * primary action with its escape hatch. Matches tLS's
                 * discard guard, tUnit's `CharacterEditor` footer and tLib's
                 * shared `PropEditor` prompt. `data-discard-answer` is the
                 * semantic handle (same role as `data-prop-editor-keep`/
                 * `-discard`) since the captions are prose.
                 */}
                <div class="tlib-nui-confirm-actions">
                  <NuiButton
                    data-discard-answer="keep"
                    tone="primary"
                    autofocus
                    onClick={() => {
                      setDiscarding(false);
                      // This button is removed from the document on click, leaving focus on body; hand it back to the editor.
                      surface?.focus({ preventScroll: true });
                    }}
                  >
                    {/* Glyph follows the tone, not DOM order — tick on the affirmative answer. */}
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
