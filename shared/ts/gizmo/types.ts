export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface VehicleMatrix {
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  pos: Vec3;
}

export type EditorMode = "translate" | "rotate" | "scale";
export type SpaceMode = "world" | "local";

/** Inclusive bounds of a uniform scale factor. */
export const UNIFORM_SCALE_MIN = 0.1;
export const UNIFORM_SCALE_MAX = 10;

/**
 * The one clamp for a uniform scale, and the only place 0 is ruled out.
 *
 * Lives in this module — the gizmo's dependency-free contract — rather than in
 * `GizmoScene.ts`, so the prop editor's store and its numeric field can share
 * the single definition without either of them pulling three.js in.
 *
 * A scale of 0 collapses the model to a point and a negative one mirrors it;
 * neither is recoverable from the UI, and the Lua half's contract is that it
 * never receives either. Anything unusable — absent, `NaN`, zero, negative —
 * resolves to 1 rather than to the minimum, because all of those mean "no scale
 * was supplied", not "scale as small as possible".
 */
export function clampUniformScale(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(UNIFORM_SCALE_MAX, Math.max(UNIFORM_SCALE_MIN, value));
}

export interface GizmoSceneConfig {
  canvas: HTMLCanvasElement;
  fov?: number;
  features?: {
    scale?: boolean;
    /**
     * Report a scale drag as ONE scalar (`onUniformScaleChange`) instead of as
     * the 2D `sw`/`sh` pair (`onScaleChange` / `onMultiScale`).
     *
     * The two are different domains, not two spellings of one. `sw`/`sh` are a
     * QUAD's half-extents — tELS LED strips, tUnit number plates — where width
     * and height are independently meaningful. A prop attached to a vehicle has
     * a single scale factor, and the shared prop editor deliberately offers no
     * per-axis handles even though the underlying matrix would carry them.
     *
     * Requires `scale`. With both on, the uniform path wins and the `sw`/`sh`
     * callbacks are never invoked.
     */
    uniformScale?: boolean;
    picking?: boolean;
    multiSelect?: boolean;
    snap?: boolean;
  };
}

// extend for your domain (LED adds sw/sh/groups, prop adds rx/ry/rz)
export interface GizmoItemData {
  x: number;
  y: number;
  z: number;
  [key: string]: unknown;
}
