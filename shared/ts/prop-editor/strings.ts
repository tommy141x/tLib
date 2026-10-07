/**
 * Every string the shared prop-editor chrome can show, with an English default.
 *
 * tLib must not own a consumer's locale file, so the module takes a translator
 * and falls back to these. A host translates the keys it cares about and the
 * rest still read as English rather than as a raw key — a missing translation is
 * a cosmetic gap, never a blank button.
 *
 * `title_suffix` is deliberately generic here. Every consumer overrides it
 * ("Radio Prop Editor", "Radar Prop Editor", …); that is the one key nobody
 * should be happy with the default for.
 */

import type { PropEditorStringKey, PropEditorTranslate } from "./types";

export const DEFAULT_PROP_EDITOR_STRINGS: Record<PropEditorStringKey, string> = {
  title_suffix: "Prop Editor",

  btn_save: "Save",
  btn_cancel: "Cancel",
  btn_move_title: "Move (W)",
  btn_rotate_title: "Rotate (R)",
  btn_scale_title: "Scale (S)",
  // `{space}` is substituted with the current space ("local" / "world").
  btn_space_title_format: "Space: {space} (X)",
  coord_local: "LOC",
  coord_world: "WLD",
  btn_pov: "POV",
  btn_pov_title: "Snap to driver POV (P)",
  btn_cam: "CAM",
  wasd_cam_on: "WASD camera ON",
  wasd_cam_off: "WASD camera OFF",

  section_position: "Position",
  section_rotation: "Rotation",
  section_scale: "Scale",
  btn_remove_prop: "Remove Prop",

  hint_mmb_orbit: "MMB",
  hint_orbit_label: "Orbit",
  hint_shift_mmb: "Shift+MMB",
  hint_pan_label: "Pan",
  hint_scroll: "Scroll",
  hint_zoom_label: "Zoom",
  hint_wasd: "WASD",
  hint_wasd_orbit_label: "Orbit",
  hint_qe: "Q/E",
  hint_qe_zoom_label: "Zoom",
  hint_w_key: "W",
  hint_w_label: "Move",
  hint_r_key: "R",
  hint_r_label: "Rotate",
  hint_s_key: "S",
  hint_s_label: "Scale",
  hint_x_key: "X",
  hint_x_label: "Space",
  hint_p_key: "P",
  hint_p_label: "Driver POV",
  hint_esc_key: "Esc",
  hint_esc_label: "Cancel",
};

/**
 * Wraps a host translator so an untranslated key falls through to English.
 *
 * An empty string counts as untranslated. A locale file with a key present but
 * blank is the common way a translation is half-done, and rendering "" there
 * loses the control entirely rather than showing it in the wrong language.
 */
export function makePropEditorTranslator(
  translate?: PropEditorTranslate
): (key: PropEditorStringKey) => string {
  return (key) => {
    const value = translate?.(key);
    if (typeof value === "string" && value !== "") return value;
    return DEFAULT_PROP_EDITOR_STRINGS[key];
  };
}
