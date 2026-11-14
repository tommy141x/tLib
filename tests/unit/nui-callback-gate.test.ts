import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { REGISTRAR, scanSource, scanTree } from "../../scripts/nui-callback-gate";

describe("nui callback gate", () => {
  test("tLib's own code registers every NUI callback through tlib.nui.register", () => {
    const { files, findings } = scanTree(resolve(import.meta.dir, "../.."));
    expect(files).toBeGreaterThan(50);
    expect(findings).toEqual([]);
  });

  test("the registrar itself is the one place the host is called", () => {
    const { findings } = scanTree(resolve(import.meta.dir, "../.."));
    expect(findings.some((f) => f.file === REGISTRAR)).toBe(false);
  });

  describe("controls: the scan does fire on a bare registration", () => {
    test("RegisterNUICallback", () => {
      const found = scanSource("a.lua", "RegisterNUICallback('x', function(_, cb) cb(1) end)");
      expect(found).toEqual([{ file: "a.lua", line: 1, what: "RegisterNUICallback" }]);
    });

    test("RegisterNuiCallbackType and a raw __cfx_nui handler", () => {
      const found = scanSource(
        "a.lua",
        "RegisterNuiCallbackType(evt)\nAddEventHandler('__cfx_nui:' .. evt, fn)"
      );
      expect(found.map((f) => f.what)).toEqual([
        "RegisterNuiCallbackType",
        "a raw __cfx_nui: handler",
      ]);
      expect(found.map((f) => f.line)).toEqual([1, 2]);
    });

    // REGISTER_NUI_CALLBACK, the native, reaches Lua with this casing.
    test("RegisterNuiCallback, the native spelling", () => {
      const found = scanSource("a.lua", "RegisterNuiCallback('x', function(_, cb) cb(1) end)");
      expect(found.map((f) => f.what)).toEqual(["RegisterNuiCallback"]);
    });

    test("an indented call inside a function", () => {
      expect(scanSource("a.lua", "if x then\n    RegisterNUICallback (name, h)\nend")).toHaveLength(
        1
      );
    });
  });

  describe("controls: the scan stays quiet on what is not a registration", () => {
    test("tlib.nui.register", () => {
      expect(
        scanSource("a.lua", "tlib.nui.register('x', function(_, reply) reply(1) end)")
      ).toEqual([]);
    });

    test("a line comment and a trailing comment", () => {
      expect(
        scanSource("a.lua", "-- RegisterNUICallback is bare\nlocal x = 1 -- RegisterNUICallback")
      ).toEqual([]);
    });

    test("a long comment, with the line numbers after it intact", () => {
      const source = "--[[\nRegisterNUICallback('x', f)\n]]\nRegisterNUICallback('y', f)";
      expect(scanSource("a.lua", source)).toEqual([
        { file: "a.lua", line: 4, what: "RegisterNUICallback" },
      ]);
    });

    test("a longer identifier that merely contains the name", () => {
      expect(scanSource("a.lua", "local MyRegisterNUICallbackWrapper = 1")).toEqual([]);
    });
  });
});
