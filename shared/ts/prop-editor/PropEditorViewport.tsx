/**
 * PropEditorViewport — the full-screen transparent Three.js canvas.
 *
 * It renders ONLY the TransformControls handle. The prop itself is a real game
 * object attached by the Lua half; this draws the gizmo over the top of it, with
 * the camera kept in lockstep by `setCameraPosition` messages.
 */

import { createEffect, onCleanup, onSettled } from "solid-js";
import { attachCameraDrag } from "../camera-drag";
import { GizmoScene } from "../gizmo/GizmoScene";
import { fivemWorldToLocal } from "../gizmo/vehicle-math";
import { fetchNui, onNuiEvent } from "../nui";
import type { UndoHistory } from "../undo";
import { getGizmoScene, setGizmoScene } from "./scene";
import { mergePropEditorPropData, propEditorState } from "./store";
import { GIZMO_UNDO_LABEL, PROP_TRANSFORM_TAG } from "./undo";

export interface PropEditorViewportProps {
  /** Event namespace, without the colon. `"radio"` → `radio:propMoved`. */
  prefix: string;
  /**
   * The editor's history, so a whole gizmo drag is ONE undo entry. Passed down
   * rather than reached for: `PropEditor` owns the instance, because a module
   * singleton here would re-create the nesting bug `shared/ts/undo.ts` removed.
   */
  history: UndoHistory;
}

export function PropEditorViewport(props: PropEditorViewportProps) {
  let canvasRef!: HTMLCanvasElement;
  let isDragging = false;
  let detachCameraDrag: (() => void) | null = null;

  const nui = (name: string, data: unknown) => fetchNui(`${props.prefix}:${name}`, data);

  onSettled(() => {
    // `scale` turns the handle on; `uniformScale` makes it report ONE scalar
    // through `onUniformScaleChange` instead of the `sw`/`sh` pair the LED and
    // number-plate editors want. A prop is scaled, never stretched.
    const scene = new GizmoScene({
      canvas: canvasRef,
      fov: propEditorState.cameraFov,
      features: { scale: true, uniformScale: true },
    });
    setGizmoScene(scene);

    if (propEditorState.vehicleMatrix) scene.setVehicleMatrix(propEditorState.vehicleMatrix);
    scene.updatePropGizmo(propEditorState.propData);

    // Translate: the gizmo works in world space, the record is vehicle-local.
    scene.onPositionChange = (fivemWorldPos) => {
      const vm = propEditorState.vehicleMatrix;
      if (!vm) return;
      const local = fivemWorldToLocal(vm, fivemWorldPos.x, fivemWorldPos.y, fivemWorldPos.z);
      mergePropEditorPropData(local);
      nui("propMoved", { ...local });
    };

    scene.onRotationChange = () => {
      const rot = scene.extractPropRotation();
      mergePropEditorPropData(rot);
      nui("propRotated", rot);
    };

    // Already absolute and already clamped to [0.1, 10] by the scene, so there
    scene.onUniformScaleChange = (scale) => {
      mergePropEditorPropData({ scale });
      nui("propScaled", { scale });
    };

    /*
     * THE DRAG IS ONE UNDO ENTRY. The batch opens at gesture START, so the
     * "before" is the transform the drag began from; every frame writes without
     * touching the history, and `onDragEnd` closes it. The label comes off the
     * current MODE and is deliberately not any numeric field's, because a
     * matching label would EXTEND an open batch rather than start a new one.
     * There is no `abort()` and nothing to call it from: a drag that ends where
     * it started is discarded by `commit()` finding before and after equal.
     */
    scene.onDragStart = () => {
      isDragging = true;
      props.history.push(GIZMO_UNDO_LABEL[propEditorState.mode], [PROP_TRANSFORM_TAG]);
    };
    scene.onDragEnd = () => {
      isDragging = false;
      props.history.commit();
    };

    scene.startLoop();

    // Camera input comes from the BROWSER, not from the pad: the editor holds
    // SetNuiFocus(true, true), so CEF owns pointer movement and the game's look
    // axes report one frame and then zero. The WHEEL is the same story and was
    // missed the first time -- the Lua half's disabled-control checks never fired
    // once. It is not throttled the way the drag is, because a wheel event is
    // already one notch rather than a stream of samples.
    //
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
  onSettled(() => {
    const off = onNuiEvent<{
      position: { x: number; y: number; z: number };
      focus: { x: number; y: number; z: number };
    }>("setCameraPosition", (data) => {
      if (data?.position && data?.focus) getGizmoScene()?.syncCamera(data.position, data.focus);
    });
    return off;
  });

  /*
   * `on()` IS GONE; ITS JOB IS NOW `createEffect`'s FIRST ARGUMENT. `compute`
   * tracks and IS the dependency list, `apply` runs untracked, so
   * `createEffect(on(src, fn))` folds one-for-one. NO `{ defer: true }` anywhere
   * here, deliberately: Solid 1's `on()` also ran immediately, and these four
   * must, because the gizmo has to be given the initial mode, space and matrix.
   */

  // External edits (the numeric fields) move the handle; a live drag must not,
  // or the gizmo fights the pointer.
  createEffect(
    () => propEditorState.propData,
    (pd) => {
      if (!isDragging) getGizmoScene()?.updatePropGizmo(pd);
    }
  );

  createEffect(
    () => propEditorState.mode,
    (mode) => {
      getGizmoScene()?.setMode(mode);
    }
  );
  createEffect(
    () => propEditorState.space,
    (space) => {
      getGizmoScene()?.setSpace(space);
    }
  );
  createEffect(
    () => propEditorState.vehicleMatrix,
    (vm) => {
      if (vm) getGizmoScene()?.setVehicleMatrix(vm);
    }
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
