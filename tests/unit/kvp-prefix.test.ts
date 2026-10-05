import { describe, expect, test } from "bun:test";
import { composeKvpKey, resolveKvpPrefix } from "../../shared/ts/kvp";

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

// The composition, pinned against the exact strings the two forks it replaced
// were already writing. These keys live in players' KVP stores, so a shared
// implementation that namespaced them even slightly differently would pass every
// behavioural test and silently reset everyone on upgrade.
//
// tests/lua/kvp-views.lua asserts the same three strings against the Lua side,
// which is the half that actually reads and writes them.
describe("KVP key composition", () => {
  const scope = { community: "tgstudios", serverTag: "a1b2c3d4" };

  test("an unscoped key is the community prefix and nothing else", () => {
    // What `tlib.kvp.key(key)` has always produced.
    expect(composeKvpKey("radio_setting_volume", scope)).toBe("tgstudios_radio_setting_volume");
    expect(composeKvpKey("radio_setting_volume", scope, false)).toBe(
      "tgstudios_radio_setting_volume"
    );
  });

  test("a server-scoped key carries the tag inside the community prefix", () => {
    // tRadio Lua, before: tlib.kvp.key(key .. "_" .. serverTag())
    // tRadio TypeScript, before: this.prefix + definition.key + this.suffix
    expect(composeKvpKey("radio_setting_fx_overrides", scope, true)).toBe(
      "tgstudios_radio_setting_fx_overrides_a1b2c3d4"
    );
  });

  test("no community prefix leaves the key bare", () => {
    expect(composeKvpKey("k", { serverTag: "a1b2c3d4" }, true)).toBe("k_a1b2c3d4");
    expect(composeKvpKey("k", {})).toBe("k");
  });

  test("an unresolved server tag leaves a scoped key unscoped, not trailing-underscored", () => {
    // The divergence resolved while moving: tRadio's Lua hashed an unresolved
    // endpoint to 00001505 and wrote into a bucket named after no server, while
    // its own TypeScript already said an absent tag must leave the key alone.
    for (const tag of [null, undefined, ""]) {
      expect(composeKvpKey("k", { community: "tgstudios", serverTag: tag }, true)).toBe(
        "tgstudios_k"
      );
    }
  });
});
