/**
 * The Blender numpad view map.
 *
 * Every command name here has to exist in the Lua half's `cameraCommand` switch
 * — either in `orbit.command` or in the four cases the Editor keeps. A typo, or
 * a rename on one side only, is a key that silently does nothing: the callback
 * fires, Lua falls off the end of the if-chain, and no error is raised anywhere.
 * So this file asserts the map AND reads the Lua source to check the two agree.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CameraCommand,
  cameraCommandFor,
  getNumpadKey,
  KEY_COMMANDS,
  NUMPAD_COMMANDS,
  NUMPAD_CTRL_COMMANDS,
} from "../../shared/ts/prop-editor/numpad";

const key = (code: string) => getNumpadKey({ code });

describe("numpad key resolution", () => {
  test("the numpad itself", () => {
    expect(key("Numpad5")).toBe("5");
    expect(key("NumpadAdd")).toBe("+");
    expect(key("NumpadSubtract")).toBe("-");
    expect(key("NumpadDecimal")).toBe(".");
    expect(key("NumpadDivide")).toBe("/");
  });

  test("the top row emulates it, for keyboards that have no numpad", () => {
    expect(key("Digit5")).toBe("5");
    expect(key("Equal")).toBe("+");
    expect(key("Minus")).toBe("-");
    expect(key("Period")).toBe(".");
    expect(key("Slash")).toBe("/");
  });

  test("a Numpad code that is not in the map does not fall through to the top row", () => {
    // Numpad* is matched by prefix, so an unmapped one (NumpadEnter, NumpadMultiply)
    // must return null rather than being looked up in the emulation table.
    expect(key("NumpadEnter")).toBeNull();
    expect(key("NumpadMultiply")).toBeNull();
  });

  test("ordinary letters are not numpad keys", () => {
    expect(key("KeyW")).toBeNull();
    expect(key("Escape")).toBeNull();
  });
});

describe("the view map", () => {
  test("unmodified: orbit, the six axis views, flip, persp, focus and zoom", () => {
    expect(cameraCommandFor("4", false)).toBe("orbitLeft");
    expect(cameraCommandFor("6", false)).toBe("orbitRight");
    expect(cameraCommandFor("8", false)).toBe("orbitUp");
    expect(cameraCommandFor("2", false)).toBe("orbitDown");
    expect(cameraCommandFor("1", false)).toBe("viewFront");
    expect(cameraCommandFor("3", false)).toBe("viewRight");
    expect(cameraCommandFor("7", false)).toBe("viewTop");
    expect(cameraCommandFor("9", false)).toBe("viewFlip");
    expect(cameraCommandFor("5", false)).toBe("togglePersp");
    expect(cameraCommandFor(".", false)).toBe("focusSelected");
    expect(cameraCommandFor("+", false)).toBe("zoomIn");
    expect(cameraCommandFor("-", false)).toBe("zoomOut");
  });

  test("Ctrl gives pan, and the opposite of each axis view", () => {
    expect(cameraCommandFor("4", true)).toBe("panLeft");
    expect(cameraCommandFor("6", true)).toBe("panRight");
    expect(cameraCommandFor("8", true)).toBe("panUp");
    expect(cameraCommandFor("2", true)).toBe("panDown");
    expect(cameraCommandFor("1", true)).toBe("viewBack");
    expect(cameraCommandFor("3", true)).toBe("viewLeft");
    expect(cameraCommandFor("7", true)).toBe("viewBottom");
  });

  test("Ctrl+1/3/7 are the opposites of plain 1/3/7", () => {
    const opposites: Record<string, string> = {
      viewFront: "viewBack",
      viewRight: "viewLeft",
      viewTop: "viewBottom",
    };
    for (const glyph of ["1", "3", "7"]) {
      const plain = cameraCommandFor(glyph, false) as string;
      expect(cameraCommandFor(glyph, true)).toBe(opposites[plain] as CameraCommand);
    }
  });

  test("Ctrl does not silently fall through to the unmodified command", () => {
    // Ctrl+5 and Ctrl+9 are unbound. Answering with togglePersp/viewFlip would
    // make the modifier meaningless on exactly the keys where it is not offered.
    expect(cameraCommandFor("5", true)).toBeNull();
    expect(cameraCommandFor("9", true)).toBeNull();
    expect(cameraCommandFor("+", true)).toBeNull();
  });

  test("0 and / are unbound in both tables", () => {
    for (const ctrl of [false, true]) {
      expect(cameraCommandFor("0", ctrl)).toBeNull();
      expect(cameraCommandFor("/", ctrl)).toBeNull();
    }
  });

  test("Home frames everything and P snaps to the driver's head", () => {
    expect(KEY_COMMANDS.Home).toBe("focusAll");
    expect(KEY_COMMANDS.KeyP).toBe("viewDriverPov");
  });
});

describe("the Lua half implements every command the page can send", () => {
  const lua = readFileSync(
    resolve(import.meta.dir, "../../shared/imports/propeditor/client.lua"),
    "utf8"
  );

  const commands = new Set<string>([
    ...Object.values(NUMPAD_COMMANDS),
    ...Object.values(NUMPAD_CTRL_COMMANDS),
    ...Object.values(KEY_COMMANDS),
  ]);

  test("21 distinct camera commands are reachable from the keyboard", () => {
    // 17 the pure orbit switch answers, plus the four that need the vehicle, the
    // ped or the cam handle and are kept by the Editor.
    expect(commands.size).toBe(21);
  });

  test.each([...commands])("%s is handled in client.lua", (cmd) => {
    // Either a case in orbit.command or one of the four the Editor keeps.
    expect(lua.includes(`'${cmd}'`)).toBe(true);
  });
});
