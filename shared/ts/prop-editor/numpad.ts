/**
 * Blender's numpad view bindings, and the top-row emulation of them.
 *
 * Pure, and separate from the component, because it is a table of eighteen
 * bindings that has to keep agreeing with the Lua `cameraCommand` switch. A
 * command this returns that Lua does not implement is a key that silently does
 * nothing; `tests/unit/prop-editor-numpad.test.ts` pins the pairs.
 */

/** A camera command name understood by the Lua half's `propEditorCameraCmd`. */
export type CameraCommand =
  | "orbitLeft"
  | "orbitRight"
  | "orbitUp"
  | "orbitDown"
  | "panLeft"
  | "panRight"
  | "panUp"
  | "panDown"
  | "zoomIn"
  | "zoomOut"
  | "viewFront"
  | "viewBack"
  | "viewLeft"
  | "viewRight"
  | "viewTop"
  | "viewBottom"
  | "viewFlip"
  | "togglePersp"
  | "focusSelected"
  | "focusAll"
  | "viewDriverPov";

const NUMPAD_CODES: Record<string, string> = {
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadDecimal: ".",
  NumpadDivide: "/",
};

/**
 * Top-row emulation, for the very many keyboards with no numpad.
 *
 * Unconditional — there is no per-user toggle. The only caller bails out on
 * INPUT targets before reaching here, so the numeric fields in the properties
 * panel still receive plain typing.
 */
const TOP_ROW_CODES: Record<string, string> = {
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "+",
  Minus: "-",
  Period: ".",
  Slash: "/",
};

/** The numpad glyph a `KeyboardEvent.code` stands for, or null. */
export function getNumpadKey(e: Pick<KeyboardEvent, "code">): string | null {
  if (e.code.startsWith("Numpad")) return NUMPAD_CODES[e.code] ?? null;
  return TOP_ROW_CODES[e.code] ?? null;
}

/** Numpad glyph → camera command, with Ctrl held. Blender's pan/opposite set. */
export const NUMPAD_CTRL_COMMANDS: Record<string, CameraCommand> = {
  "2": "panDown",
  "8": "panUp",
  "4": "panLeft",
  "6": "panRight",
  "1": "viewBack",
  "3": "viewLeft",
  "7": "viewBottom",
};

/** Numpad glyph → camera command, unmodified. */
export const NUMPAD_COMMANDS: Record<string, CameraCommand> = {
  "2": "orbitDown",
  "8": "orbitUp",
  "4": "orbitLeft",
  "6": "orbitRight",
  "1": "viewFront",
  "3": "viewRight",
  "7": "viewTop",
  "9": "viewFlip",
  "5": "togglePersp",
  ".": "focusSelected",
  "+": "zoomIn",
  "-": "zoomOut",
};

/** The command a numpad glyph means, or null when that glyph is unbound. */
export function cameraCommandFor(numpadKey: string, ctrlKey: boolean): CameraCommand | null {
  const table = ctrlKey ? NUMPAD_CTRL_COMMANDS : NUMPAD_COMMANDS;
  return table[numpadKey] ?? null;
}

/** Non-numpad view keys. Home frames everything; P snaps to the driver's head. */
export const KEY_COMMANDS: Record<string, CameraCommand> = {
  Home: "focusAll",
  KeyP: "viewDriverPov",
};
