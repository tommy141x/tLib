/**
 * Prop-editor state.
 *
 * Module-level rather than per-instance on purpose: an NUI page has exactly one
 * game camera and one player, so it can only ever have one 3D editor open. A
 * factory would let a host mount two and get two stores fed by one stream of
 * `setCameraPosition` messages.
 *
 * Hosts do not normally touch `openPropEditor`/`closePropEditor` — `PropEditor`
 * subscribes to `<prefix>:propEditorInit` / `<prefix>:propEditorClose` itself.
 * They are exported so a host can drive the chrome without the Lua half, which
 * is what a browser-only preview needs.
 */

import { createStore } from "solid-js/store";
import type {
  PropEditorInitMessage,
  PropEditorMode,
  PropEditorSpace,
  PropEditorState,
} from "./types";

const [propEditorState, setPropEditorState] = createStore<PropEditorState>({
  open: false,
  vehicleKey: "",
  vehicleDisplayName: "",
  propData: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  vehicleMatrix: null,
  hasExisting: false,
  mode: "translate",
  space: "local",
  cameraFov: 50,
});

export { propEditorState, setPropEditorState };

/** Applies a `<prefix>:propEditorInit` payload. Resets mode/space every time. */
export function openPropEditor(data: PropEditorInitMessage): void {
  setPropEditorState({
    open: true,
    vehicleKey: data.vehicleModel,
    vehicleDisplayName: data.vehicleDisplayName,
    propData: data.propData,
    vehicleMatrix: data.vehicleMatrix,
    hasExisting: data.hasExisting,
    mode: "translate",
    space: "local",
    cameraFov: data.cameraFov ?? 50,
  });
}

export function closePropEditor(): void {
  setPropEditorState("open", false);
}

export function setPropEditorMode(mode: PropEditorMode): void {
  setPropEditorState("mode", mode);
}

export function setPropEditorSpace(space: PropEditorSpace): void {
  setPropEditorState("space", space);
}

export function togglePropEditorSpace(): void {
  setPropEditorState("space", propEditorState.space === "local" ? "world" : "local");
}
