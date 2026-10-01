/**
 * The live `GizmoScene`, held outside the components that use it.
 *
 * `PropEditorViewport` creates it; `PropEditor`'s numeric fields have to push
 * their edits into it. Exporting a mutable `let` from the viewport (which is
 * what this was lifted from) works under a bundler and is invisible to anything
 * that reads the binding as a value — so it is a holder with functions here,
 * which behaves the same in every module graph.
 */

import type { GizmoScene } from "../gizmo/GizmoScene";

let current: GizmoScene | null = null;

export function getGizmoScene(): GizmoScene | null {
  return current;
}

export function setGizmoScene(scene: GizmoScene | null): void {
  current = scene;
}
