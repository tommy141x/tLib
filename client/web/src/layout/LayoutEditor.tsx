import { Check, Grip, LayoutDashboard, Redo2, RotateCcw, Undo2, X } from "lucide-solid";
import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { NuiButton } from "@/components/ui/nui-field";
import { applyNuiTheme } from "@/components/ui/nui-theme";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import ComponentList from "./ComponentList";
import {
  buildSnapTargets,
  type Component,
  type Corner,
  constrainLayout,
  type Layout,
  layoutRect,
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
} from "./geometry";
import { LayoutHistory } from "./history";
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
/** A burst of wheel notches is one thing the player did, so it is one undo step. */
interface WheelGesture {
  key: string;
  before: Layout;
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
  const [selected, setSelected] = createSignal("");
  const [viewport, setViewport] = createSignal<Viewport>({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [safezone, setSafezone] = createSignal(1);
  const [guides, setGuides] = createSignal<{ x?: number; y?: number }>({});
  const [scalingKey, setScalingKey] = createSignal("");
  const [historyVersion, setHistoryVersion] = createSignal(0);
  const [finishing, setFinishing] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [panelPosition, setPanelPosition] = createSignal<{ x: number; y: number } | null>(null);
  const [panelDragging, setPanelDragging] = createSignal(false);

  let panel: HTMLElement | undefined;
  let panelObserver: ResizeObserver | undefined;
  let panelSize = { width: 320, height: 0 };
  let panelGesture:
    | { pointer: number; x: number; y: number; left: number; top: number; target: HTMLElement }
    | undefined;
  const history = new LayoutHistory();
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
  const current = (component: Component) => layouts[component.key] ?? component.layout;
  const tick = () => setHistoryVersion((v) => v + 1);
  const canUndo = () => (historyVersion(), history.canUndo);
  const canRedo = () => (historyVersion(), history.canRedo);

  // ── Placement ───────────────────────────────────────────────────────────
  function update(key: string, layout: Layout) {
    const component = index().get(key);
    if (!component) return;
    // The single choke point for placement: every drag, nudge, scale, resize,
    // undo and resize-response goes through here, so all of them are clamped.
    // The anchor is re-derived once at gesture end; mid-drag it would thrash.
    const next = constrainLayout(component, layout, viewport());
    setLayouts(key, next);
    preview.queue(key, next);
  }

  /** Re-derive the anchor from where it ended up, then record one history entry. */
  function settleKey(key: string, before: Layout) {
    const component = index().get(key);
    const after = layouts[key];
    if (!component || !after) return;
    const anchored = reanchor(component, after, viewport());
    if (!sameLayout(anchored, after)) update(key, anchored);
    history.record(key, before, layouts[key]);
    tick();
  }
  function flushWheel() {
    const burst = wheel;
    wheel = undefined;
    if (!burst) return;
    window.clearTimeout(burst.timer);
    setScalingKey("");
    settleKey(burst.key, burst.before);
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
    releaseGestureCapture(completed);
    if (!layouts[completed.key]) return;
    if (cancel) update(completed.key, completed.before);
    else settleKey(completed.key, completed.before);
    tick();
  }
  /** Commit every in-progress gesture before doing something discrete. */
  function settle() {
    endGesture();
    flushWheel();
  }
  function change(component: Component, next: Layout) {
    if (finishing()) return;
    settle();
    const before = current(component);
    update(component.key, next);
    history.record(component.key, before, layouts[component.key]);
    tick();
  }
  function toggleVisible(component: Component) {
    if (!component.canHide) return;
    change(component, { ...current(component), visible: !current(component).visible });
  }
  function resetSelected() {
    const component = active();
    if (!component) return;
    change(component, {
      ...component.defaults,
      scale: component.canScale ? component.defaults.scale : current(component).scale,
      visible: component.canHide ? component.defaults.visible : current(component).visible,
    });
  }
  function travel(direction: "undo" | "redo") {
    if (finishing()) return;
    settle();
    const entry = history[direction]();
    if (entry) {
      update(entry.key, entry.layout);
      setSelected(entry.key);
    }
    tick();
  }

  // ── Gestures ────────────────────────────────────────────────────────────
  function grab(event: PointerEvent, component: Component, corner?: Corner) {
    if (event.button !== 0 || finishing()) return;
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
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function onWheel(event: WheelEvent, component: Component) {
    if (finishing() || !component.canScale) return;
    // Never let a notch scroll the NUI document instead of resizing the widget.
    event.preventDefault();
    event.stopPropagation();
    endGesture();
    if (wheel && wheel.key !== component.key) flushWheel();
    setSelected(component.key);
    if (!wheel) wheel = { key: component.key, before: { ...current(component) }, timer: 0 };
    else window.clearTimeout(wheel.timer);
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
  function pointerMove(event: PointerEvent) {
    if (panelGesture?.pointer === event.pointerId) {
      setPanelPosition(
        clampPanel({
          x: panelGesture.left + event.clientX - panelGesture.x,
          y: panelGesture.top + event.clientY - panelGesture.y,
        })
      );
      return;
    }
    if (!gesture || gesture.pointer !== event.pointerId || finishing()) return;
    const component = index().get(gesture.key);
    if (!component) return;
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (gesture.corner) {
      update(
        component.key,
        resizeLayout(component, gesture.before, viewport(), gesture.corner, dx, dy)
      );
      setScalingKey(component.key);
      return;
    }
    const start = layoutRect(component, gesture.before, viewport());
    let left = start.left + dx,
      top = start.top + dy;
    // Alt suspends snapping for the frames it is held, rather than being a mode.
    if (event.altKey) setGuides({});
    else if (snapTargets) {
      const snap = resolveSnap({ ...start, left, top }, snapTargets);
      left += snap.dx;
      top += snap.dy;
      setGuides(snap.guides);
    }
    update(component.key, placeRect(gesture.before, { ...start, left, top }, viewport()));
  }
  function pointerUp(event: PointerEvent) {
    if (panelGesture?.pointer === event.pointerId) endPanelDrag();
    if (gesture?.pointer === event.pointerId) {
      setScalingKey("");
      endGesture();
    }
  }
  function pointerCancel(event: PointerEvent) {
    if (panelGesture?.pointer === event.pointerId) endPanelDrag();
    if (gesture?.pointer === event.pointerId) {
      setScalingKey("");
      endGesture(true);
    }
  }

  // ── Panel placement (session-local UI state, never a HUD layout entry) ───
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
    if (event.button !== 0 || !panel || finishing()) return;
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
    if (!direction || !panel || finishing()) return;
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

  // ── Keyboard ────────────────────────────────────────────────────────────
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  function keyDown(event: KeyboardEvent) {
    if (session() === null || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void finish(false);
      return;
    }
    if (event.key === "Tab" && surface) {
      const controls = [...surface.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(
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
    if (finishing()) return;
    if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (!event.repeat)
        travel(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo");
      return;
    }
    const direction = arrows[event.key],
      component = active();
    // The panel's own drag handle owns arrows while it is focused.
    if (!direction || !component || gesture?.pointer !== undefined) return;
    if ((event.target as HTMLElement | null)?.closest(".tlib-layout__drag")) return;
    event.preventDefault();
    flushWheel();
    if (!gesture) gesture = { key: component.key, before: { ...current(component) }, x: 0, y: 0 };
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

  // ── Session ─────────────────────────────────────────────────────────────
  function stop() {
    settle();
    endPanelDrag();
    panelObserver?.disconnect();
    panelObserver = undefined;
    gesture = undefined;
    wheel = undefined;
    snapTargets = undefined;
    preview.reset();
    history.clear();
    setSession(null);
    setFinishing(false);
    setComponents([]);
    setLayouts({});
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
      preview.retryFailed((key) => layouts[key]);
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
    if (session() === token) {
      setFinishing(false);
      setNotice(
        response?.ok === true
          ? "Waiting for game confirmation. You can retry Save or Cancel."
          : "The game did not confirm your changes. Retry Save or Cancel."
      );
    }
  }

  onMount(() => {
    const offOpen = onNuiEvent<LayoutOpen>("layoutOpen", (data) => {
      if (!Number.isFinite(data.session) || data.session <= highSession) return;
      highSession = data.session;
      if (session() !== null) stop();
      previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      history.clear();
      tick();
      preview.open(data.session);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setComponents(data.components);
      setLayouts(
        Object.fromEntries(data.components.map((c) => [c.key, { ...c.layout }])) as Record<
          string,
          Layout
        >
      );
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
      history.remove(data.key);
      tick();
      setComponents((all) => all.filter((c) => c.key !== data.key));
      setLayouts(data.key, undefined!);
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
    window.addEventListener("resize", resized);
    window.addEventListener("blur", blurred);
    onCleanup(() => {
      offOpen();
      offClose();
      offRemove();
      window.clearInterval(heartbeat);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("resize", resized);
      window.removeEventListener("blur", blurred);
      stop();
    });
  });

  const safeRect = createMemo(() => safezoneRect(viewport(), safezone()));
  return (
    <Show when={session() !== null}>
      <div
        ref={(element) => {
          surface = element;
          createRenderEffect(() => applyNuiTheme(undefined, element));
        }}
        class="tlib-layout tlib-nui-surface"
        tabIndex={-1}
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
          class="tlib-layout__panel"
          classList={{ "tlib-layout__panel--dragging": panelDragging() }}
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
            <p class="tlib-layout__help">Drag to move · Scroll to resize · Alt disables snapping</p>
            <div class="tlib-layout__actions">
              <div class="tlib-layout__history">
                <NuiButton
                  aria-label="Undo"
                  title="Undo · Ctrl Z"
                  disabled={finishing() || !canUndo()}
                  onClick={() => travel("undo")}
                >
                  <Undo2 aria-hidden="true" />
                </NuiButton>
                <NuiButton
                  aria-label="Redo"
                  title="Redo · Ctrl Shift Z"
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
            </div>
          </div>
          <Show when={notice()}>
            <p class="tlib-layout__notice" role="status">
              {notice()}
            </p>
          </Show>
          <footer>
            <NuiButton
              class="tlib-layout__discard"
              disabled={finishing()}
              onClick={() => void finish(false)}
            >
              <X aria-hidden="true" />
              Cancel
            </NuiButton>
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
          </footer>
        </aside>
      </div>
    </Show>
  );
}
