/**
 * PropEditorViewport — the full-screen transparent Three.js canvas.
 *
 * It renders ONLY the TransformControls handle. The prop itself is a real game
 * object attached by the Lua half; this draws the gizmo over the top of it, with
 * the camera kept in lockstep by `setCameraPosition` messages.
 */

import { createEffect, on, onCleanup, onMount } from "solid-js";
import { attachCameraDrag } from "../camera-drag";
import { GizmoScene } from "../gizmo/GizmoScene";
import { fivemWorldToLocal } from "../gizmo/vehicle-math";
import { fetchNui, onNuiEvent } from "../nui";
import { getGizmoScene, setGizmoScene } from "./scene";
import { propEditorState, setPropEditorState } from "./store";

export interface PropEditorViewportProps {
  /** Event namespace, without the colon. `"radio"` → `radio:propMoved`. */
  prefix: string;
}

export function PropEditorViewport(props: PropEditorViewportProps) {
  let canvasRef!: HTMLCanvasElement;
  let isDragging = false;
  let detachCameraDrag: (() => void) | null = null;

  const nui = (name: string, data: unknown) => fetchNui(`${props.prefix}:${name}`, data);

  onMount(() => {
    const scene = new GizmoScene({ canvas: canvasRef, fov: propEditorState.cameraFov });
    setGizmoScene(scene);

    if (propEditorState.vehicleMatrix) scene.setVehicleMatrix(propEditorState.vehicleMatrix);
    scene.updatePropGizmo(propEditorState.propData);

    // Translate: the gizmo works in world space, the record is vehicle-local.
    scene.onPositionChange = (fivemWorldPos) => {
      const vm = propEditorState.vehicleMatrix;
      if (!vm) return;
      const local = fivemWorldToLocal(vm, fivemWorldPos.x, fivemWorldPos.y, fivemWorldPos.z);
      setPropEditorState("propData", { ...propEditorState.propData, ...local });
      nui("propMoved", { ...local });
    };

    scene.onRotationChange = () => {
      const rot = scene.extractPropRotation();
      setPropEditorState("propData", { ...propEditorState.propData, ...rot });
      nui("propRotated", rot);
    };

    scene.onDragStart = () => {
      isDragging = true;
    };
    scene.onDragEnd = () => {
      isDragging = false;
    };

    scene.startLoop();

    // Camera input comes from the BROWSER, not from the pad.
    //
    // The editor holds SetNuiFocus(true, true), so CEF owns pointer movement and
    // the game's look axes report one frame and then zero — which is why holding
    // MMB nudged the camera a pixel and then stopped. The page still gets every
    // pointermove, so it sends the delta and the Lua half applies the orbit
    // maths. See ../camera-drag.ts.
    //
    // The WHEEL is the same story and was missed the first time: CEF owns it
    // outright under that focus, so the Lua half's
    // `IsDisabledControlJustPressed(0, 241/242)` never fired once and the wheel
    // did nothing. It is not throttled the way the drag is — a wheel event is
    // already one notch, not a stream of pointer samples.
    detachCameraDrag = attachCameraDrag(canvasRef, {
      onDrag: (d) => {
        if (d.mode === "none") return;
        nui("propEditorCamDrag", d);
      },
      onWheel: (deltaY) => {
        if (deltaY === 0) return;
        nui("propEditorCamZoom", { delta: deltaY });
      },
    });
  });

  onCleanup(() => {
    detachCameraDrag?.();
    detachCameraDrag = null;
    const scene = getGizmoScene();
    if (scene) {
      scene.dispose();
      setGizmoScene(null);
    }
  });

  // Camera sync from Lua. Not namespaced: the Lua half sends this action bare,
  // because it is the one message on the hot path and it predates the prefix.
  onMount(() => {
    const off = onNuiEvent<{
      position: { x: number; y: number; z: number };
      focus: { x: number; y: number; z: number };
    }>("setCameraPosition", (data) => {
      if (data?.position && data?.focus) getGizmoScene()?.syncCamera(data.position, data.focus);
    });
    onCleanup(off);
  });

  // External edits (the numeric fields) move the handle; a live drag must not,
  // or the gizmo fights the pointer.
  createEffect(
    on(
      () => propEditorState.propData,
      (pd) => {
        if (!isDragging) getGizmoScene()?.updatePropGizmo(pd);
      }
    )
  );

  createEffect(on(() => propEditorState.mode, (mode) => getGizmoScene()?.setMode(mode)));
  createEffect(on(() => propEditorState.space, (space) => getGizmoScene()?.setSpace(space)));
  createEffect(
    on(
      () => propEditorState.vehicleMatrix,
      (vm) => {
        if (vm) getGizmoScene()?.setVehicleMatrix(vm);
      }
    )
  );

  return (
    <canvas
      // biome-ignore lint/style/noNonNullAssertion: SolidJS ref assignment requires ! to satisfy the setter type
      ref={canvasRef!}
      class="fixed inset-0 w-full h-full z-0"
      style={{ "touch-action": "none" }}
    />
  );
}

export default PropEditorViewport;
