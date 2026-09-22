import { describe, expect, test } from "bun:test";
import { resolveKvpPrefix } from "../../shared/ts/kvp";

// The same vectors tests/lua/kvp-prefix.lua asserts against shared/imports/kvp/client.lua.
// The algorithm is written out in both places plus tRadio's client bridge, and
// they had already drifted on the third case below, so a server could read one
// namespace from Lua and another from JS.
describe("KVP namespace resolution", () => {
  test("a usable community id wins", () => {
    expect(resolveKvpPrefix(["acme", "Ignored"])).toBe("acme");
  });

  test("no community id falls back to the project name", () => {
    expect(resolveKvpPrefix(["", "MyServer"])).toBe("MyServer");
  });

  test("a candidate that sanitizes to nothing falls through rather than winning", () => {
    expect(resolveKvpPrefix(["!!!", "MyServer"])).toBe("MyServer");
  });

  test("nothing usable leaves the key unprefixed", () => {
    expect(resolveKvpPrefix(["", ""])).toBeNull();
    expect(resolveKvpPrefix(["!!!", "???"])).toBeNull();
  });

  test("spaces and punctuation are stripped, word characters and -_ kept", () => {
    expect(resolveKvpPrefix(["My Server! v2"])).toBe("MyServerv2");
    expect(resolveKvpPrefix(["a-b_c"])).toBe("a-b_c");
  });
});
