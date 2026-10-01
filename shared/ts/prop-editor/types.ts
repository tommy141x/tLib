import type { JSX } from "solid-js";
import type { VehicleMatrix } from "../gizmo/types";

export type { VehicleMatrix };

export type PropEditorMode = "translate" | "rotate";
export type PropEditorSpace = "world" | "local";

/** The six numbers an attachment is. Vehicle-local metres and degrees. */
export interface PropData {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface PropEditorState {
  open: boolean;
  /**
   * The PLACEMENT KEY, not a spawn name — whatever `descriptor.vehicleKey`
   * returned on the Lua side. It is opaque to the chrome, which only ever
   * displays `vehicleDisplayName`.
   */
  vehicleKey: string;
  vehicleDisplayName: string;
  propData: PropData;
  vehicleMatrix: VehicleMatrix | null;
  /** Whether a record already existed. Drives nothing here; hosts read it. */
  hasExisting: boolean;
  mode: PropEditorMode;
  space: PropEditorSpace;
  cameraFov: number;
}

/** The payload `<prefix>:propEditorInit` carries from the Lua half. */
export interface PropEditorInitMessage {
  /** Named `vehicleModel` on the wire for continuity with existing consumers. */
  vehicleModel: string;
  vehicleDisplayName: string;
  propData: PropData;
  vehicleMatrix: VehicleMatrix;
  hasExisting: boolean;
  cameraFov?: number;
}

/**
 * String lookup. Return `undefined` (or an empty string) for anything you do not
 * translate and the English default in `strings.ts` is used.
 *
 * tLib does not own any consumer's locale file, so this is the whole
 * localisation contract. A consumer with `t("nui", key)` passes
 * `(key) => t("nui", key)`.
 */
export type PropEditorTranslate = (key: PropEditorStringKey) => string | undefined;

export type PropEditorStringKey =
  | "title_suffix"
  | "btn_save"
  | "btn_cancel"
  | "btn_move_title"
  | "btn_rotate_title"
  | "btn_space_title_format"
  | "coord_local"
  | "coord_world"
  | "btn_pov"
  | "btn_pov_title"
  | "btn_cam"
  | "wasd_cam_on"
  | "wasd_cam_off"
  | "section_position"
  | "section_rotation"
  | "btn_remove_prop"
  | "hint_mmb_orbit"
  | "hint_orbit_label"
  | "hint_shift_mmb"
  | "hint_pan_label"
  | "hint_scroll"
  | "hint_zoom_label"
  | "hint_wasd"
  | "hint_wasd_orbit_label"
  | "hint_qe"
  | "hint_qe_zoom_label"
  | "hint_w_key"
  | "hint_w_label"
  | "hint_r_key"
  | "hint_r_label"
  | "hint_x_key"
  | "hint_x_label"
  | "hint_p_key"
  | "hint_p_label"
  | "hint_esc_key"
  | "hint_esc_label";

/** Off by default, every one of them. */
export interface PropEditorFeatures {
  /**
   * Render `slots.toolbar` in the top-right cluster, left of Save.
   *
   * Off by default and gated separately from the slot itself, because the slot's
   * only current user is tRadio's Discovery export badge — a whole
   * config-migration flow whose vocabulary deliberately does not live in tLib. A
   * host that has no such flow gets no empty affordance, and one that does has to
   * ask for it twice.
   */
  toolbarSlot?: boolean;
}

export interface PropEditorSlots {
  /** Rendered in the top-right cluster when `features.toolbarSlot` is true. */
  toolbar?: JSX.Element;
}
