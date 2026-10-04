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

import { createStore } from "solid-js";
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

/*
 * ── SOLID 2 STORE SETTERS: ONE DRAFT-MUTATION FUNCTION ──────────────────────
 *
 * The path form (`setState("open", false)`) and the top-level merge form
 * (`setState({ ... })`) are both gone. The setter now takes a callback handed a
 * mutable draft, and every write below is a plain assignment on that draft.
 *
 * ⚠️ `togglePropEditorSpace` reads the CURRENT value off the draft rather than
 * off `propEditorState`. In Solid 2 a write is not synchronously readable — a
 * read after a set returns the last committed value until the microtask flushes
 * — so reading the proxy here would make two toggles inside one tick both see
 * the same starting value and the second one a no-op. The draft is the live,
 * in-flight state, so reading it is correct and needs no `flush()`.
 */

/** Applies a `<prefix>:propEditorInit` payload. Resets mode/space every time. */
export function openPropEditor(data: PropEditorInitMessage): void {
  setPropEditorState((s) => {
    s.open = true;
    s.vehicleKey = data.vehicleModel;
    s.vehicleDisplayName = data.vehicleDisplayName;
    s.propData = data.propData;
    s.vehicleMatrix = data.vehicleMatrix;
    s.hasExisting = data.hasExisting;
    s.mode = "translate";
    s.space = "local";
    s.cameraFov = data.cameraFov ?? 50;
  });
}

export function closePropEditor(): void {
  setPropEditorState((s) => {
    s.open = false;
  });
}

export function setPropEditorMode(mode: PropEditorMode): void {
  setPropEditorState((s) => {
    s.mode = mode;
  });
}

export function setPropEditorSpace(space: PropEditorSpace): void {
  setPropEditorState((s) => {
    s.space = space;
  });
}

export function togglePropEditorSpace(): void {
  setPropEditorState((s) => {
    s.space = s.space === "local" ? "world" : "local";
  });
}

/**
 * Replaces the prop's transform wholesale.
 *
 * Exists because the two call sites outside this module — the viewport's gizmo
 * callbacks and the editor's numeric fields — both used to write
 * `setPropEditorState("propData", next)`, the path form. Rather than hand each
 * of them a draft callback and let the store's shape leak further, the one write
 * they share lives here.
 */
export function setPropEditorPropData(propData: PropEditorState["propData"]): void {
  setPropEditorState((s) => {
    s.propData = propData;
  });
}

/**
 * Merges a partial transform into the prop's current one.
 *
 * ⚠️ THE MERGE HAPPENS ON THE DRAFT, AND THAT IS THE WHOLE POINT. The gizmo
 * callbacks used to spell this `set("propData", { ...propEditorState.propData,
 * ...partial })` — read the proxy, merge, write back. Under Solid 2 a write is
 * not synchronously readable, so a second callback firing before the microtask
 * flushes reads the value from BEFORE the first write and merges onto it,
 * silently discarding the first. A position change followed by a rotation change
 * inside one tick would land as the rotation alone, on the old position.
 *
 * `s.propData` inside the callback is the live, in-flight draft, so the merge
 * composes correctly however many times it is called in a tick, and no `flush()`
 * is needed.
 */
export function mergePropEditorPropData(partial: Partial<PropEditorState["propData"]>): void {
  setPropEditorState((s) => {
    Object.assign(s.propData, partial);
  });
}
