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

export interface GizmoSceneConfig {
  canvas: HTMLCanvasElement;
  fov?: number;
  features?: {
    scale?: boolean;
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
