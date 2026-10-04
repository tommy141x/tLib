/**
 * The shared 3D prop editor, TSX half.
 *
 *     import { PropEditor } from "@tlib/shared/prop-editor";
 *     <PropEditor prefix="radio" scopeClass="radio-settings-root" t={(k) => t("nui", k)} />
 *
 * The Lua half is `tlib.propeditor` (`tLib/shared/imports/propeditor/client.lua`)
 * and the two are joined by nothing but the prefix. Mount this unconditionally:
 * it renders nothing until `<prefix>:propEditorInit` arrives, and it is what
 * subscribes to that message.
 *
 * Styling is UnoCSS wind3 over shared token NAMES — `bg-card`, `border-border`,
 * `text-muted-foreground`, `bg-input`, `bg-destructive`. NUI is CEF 103: wind4's
 * `oklch()` and `color-mix()` are dropped silently there, and NUI colour tokens
 * are bare HSL triplets (`--border: 217 19% 27%`) consumed as `hsl(var(--border))`.
 */

export { PropEditor, type PropEditorProps } from "./PropEditor";
export { PropEditorViewport, type PropEditorViewportProps } from "./PropEditorViewport";
export {
  type CameraCommand,
  cameraCommandFor,
  getNumpadKey,
  KEY_COMMANDS,
  NUMPAD_COMMANDS,
  NUMPAD_CTRL_COMMANDS,
} from "./numpad";
export { PanelHover, type PanelHoverProps, PropField, type PropFieldProps } from "./parts";
export { getGizmoScene } from "./scene";
export { DEFAULT_PROP_EDITOR_STRINGS, makePropEditorTranslator } from "./strings";
export {
  closePropEditor,
  openPropEditor,
  propEditorState,
  mergePropEditorPropData,
  setPropEditorMode,
  setPropEditorPropData,
  setPropEditorSpace,
  setPropEditorState,
  togglePropEditorSpace,
} from "./store";
export type {
  PropData,
  PropEditorFeatures,
  PropEditorInitMessage,
  PropEditorMode,
  PropEditorSlots,
  PropEditorSpace,
  PropEditorState,
  PropEditorStringKey,
  PropEditorTranslate,
  VehicleMatrix,
} from "./types";
