/**
 * Pointer-driven camera drag for NUI editors.
 *
 * An editor showing the NUI cursor holds `SetNuiFocus(true, true)`, so CEF
 * owns pointer movement. `SetNuiFocusKeepInput(true)` keeps buttons flowing
 * to the game, but the look axes (`INPUT_LOOK_LR`/`INPUT_LOOK_UD`) go dead:
 * `GetDisabledControlNormal` reports one frame of motion then zero for as
 * long as the button is held — not the disabled-control rule itself (tAFK's
 * sequence editor disables both every frame and fails the same way), since
 * disabling a control stops the game turning the head but doesn't give the
 * read its delta back. The page receives the pointer events perfectly, so the
 * browser is the only correct source — proven in CEF 103 by tVDJ's editor
 * before being lifted here.
 *
 * Contract: `movementX/Y`, not `clientX/Y` (a client delta stalls at a screen
 * edge mid-drag); one message per animation frame (`pointermove` fires well
 * above frame rate and each post is a `fetch` across the NUI boundary); drag
 * mode is decided once at `pointerdown` from the modifiers held then, so
 * releasing Shift mid-pan can't turn it into an orbit; pointer capture is
 * taken so a drag leaving the element still tracks; a terminal `{ dx: 0, dy:
 * 0, mode: "none" }` is sent on release so Lua can drop held state without a
 * second keybind.
 */

export type CameraDragMode = "orbit" | "pan" | "dolly" | "none";

export interface CameraDragEvent {
  /** Accumulated horizontal device movement in pixels since the last flush. */
  dx: number;
  /** Accumulated vertical device movement in pixels since the last flush. */
  dy: number;
  mode: CameraDragMode;
}

export interface CameraDragOptions {
  /** Called at most once per animation frame while a drag is live, and once on release. */
  onDrag: (e: CameraDragEvent) => void;
  /** Wheel zoom, in raw `deltaY`. Omit to leave the wheel alone. */
  onWheel?: (deltaY: number) => void;
  /**
   * Which mouse buttons start a camera drag. Defaults to middle (1) and right (2);
   * left (0) is left alone because a gizmo's own TransformControls owns it.
   */
  buttons?: readonly number[];
  /**
   * Maps the modifiers held at `pointerdown` to a drag mode. The default is the
   * convention every editor here already uses: Ctrl/Cmd → dolly, Shift → pan,
   * otherwise orbit.
   */
  modeFor?: (e: PointerEvent) => CameraDragMode;
  /**
   * Suppress the browser context menu on the element. Defaults to true, because a
   * right-drag otherwise opens it in CEF.
   */
  preventContextMenu?: boolean;
}

const defaultModeFor = (e: PointerEvent): CameraDragMode =>
  e.ctrlKey || e.metaKey ? "dolly" : e.shiftKey ? "pan" : "orbit";

/**
 * Attaches camera-drag handling to `el`. Returns a detach function; call it on
 * cleanup or the listeners outlive the editor.
 */
export function attachCameraDrag(el: HTMLElement, opts: CameraDragOptions): () => void {
  const buttons = opts.buttons ?? [1, 2];
  const modeFor = opts.modeFor ?? defaultModeFor;
  const preventMenu = opts.preventContextMenu !== false;

  let activeButton = -1;
  let activePointer = -1;
  let mode: CameraDragMode = "orbit";
  let accX = 0;
  let accY = 0;
  let flushQueued = false;

  const flush = () => {
    flushQueued = false;
    if (accX === 0 && accY === 0) return;
    opts.onDrag({ dx: accX, dy: accY, mode });
    accX = 0;
    accY = 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (activeButton >= 0) return;
    if (!buttons.includes(e.button)) return;
    e.preventDefault();
    activeButton = e.button;
    activePointer = e.pointerId;
    mode = modeFor(e);
    accX = 0;
    accY = 0;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience: without it a drag that leaves the element stops
      // reporting, which is worse than the bug this module fixes but not fatal.
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (activeButton < 0) return;
    accX += e.movementX;
    accY += e.movementY;
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  };

  const endDrag = (e: PointerEvent) => {
    if (activeButton < 0) return;
    if (e.pointerId !== activePointer) return;
    flush();
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // Already released (pointercancel, or the element went away mid-drag).
    }
    activeButton = -1;
    activePointer = -1;
    opts.onDrag({ dx: 0, dy: 0, mode: "none" });
  };

  const onContextMenu = (e: Event) => e.preventDefault();

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    opts.onWheel?.(e.deltaY);
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  if (preventMenu) el.addEventListener("contextmenu", onContextMenu);
  if (opts.onWheel) el.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", endDrag);
    el.removeEventListener("pointercancel", endDrag);
    if (preventMenu) el.removeEventListener("contextmenu", onContextMenu);
    if (opts.onWheel) el.removeEventListener("wheel", onWheel);
    activeButton = -1;
    activePointer = -1;
  };
}
