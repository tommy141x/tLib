/** Minimal 3-component vector used for positions and directions */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Vehicle entity matrix — forward/right/up axes + world position */
export interface VehicleMatrix {
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  pos: Vec3;
}

/** Gizmo manipulation modes */
export type EditorMode = "translate" | "rotate" | "scale";

/** Coordinate space for the gizmo */
export type SpaceMode = "world" | "local";

/** Configuration for creating a GizmoScene */
export interface GizmoSceneConfig {
  canvas: HTMLCanvasElement;
  fov?: number;
  features?: {
    /** Enable scale mode (tELS needs this; tRadio doesn't) */
    scale?: boolean;
    /** Enable click-to-select picking on the canvas */
    picking?: boolean;
    /** Enable multi-select with center-of-mass gizmo placement */
    multiSelect?: boolean;
    /** Enable LED-to-LED / edge-to-edge snap on translate */
    snap?: boolean;
  };
}

/**
 * Minimal item data for gizmo positioning.
 * Consumers extend this for their domain (LED adds sw/sh/groups, prop adds rx/ry/rz).
 */
export interface GizmoItemData {
  x: number;
  y: number;
  z: number;
  [key: string]: unknown;
}
