import { expect, test } from "bun:test";
import { loadsIngressDoor } from "./bridge.ts";

/*
 * Whether a consumer can serve its own mount on the FiveM server port.
 *
 * FXServer routes `/<resource>/<path>` to that resource's own SetHttpHandler before any
 * resource code runs, so a consumer that mounts without loading
 * `@tLib/server/sv_http_ingress.lua` registers fine, gets a hub card, and 404s on every
 * link — with FXServer's own bare `Not found.`, which names nothing.
 *
 * Driven through plain functions rather than mocks: `loadsIngressDoor` takes its two
 * metadata readers as arguments precisely so this needs no runtime and no module
 * interception (bun's `mock.module` is process-global and leaks across files).
 */

/** A fake resource whose `server_script` entries are `entries`. */
function manifest(entries: string[]) {
  return {
    count: (_res: string, key: string) => (key === "server_script" ? entries.length : 0),
    read: (_res: string, key: string, i: number) =>
      key === "server_script" ? (entries[i] ?? null) : null,
  };
}

test("a consumer that loads the door passes", () => {
  const m = manifest(["server/sv_main.lua", "@tLib/server/sv_http_ingress.lua"]);
  expect(loadsIngressDoor("tRadio", m.count, m.read)).toBe(true);
});

test("a consumer that does not load the door is caught — the reported case", () => {
  // tRadio before it shipped the door: mounts, is hub-listed, serves nothing.
  const m = manifest(["config/config.lua", "server/sv_radio.lua", "server/dist/bundle.js"]);
  expect(loadsIngressDoor("tRadio", m.count, m.read)).toBe(false);
});

test("the match survives separators and casing, which the manifest does not normalise", () => {
  for (const entry of [
    "@tLib/server/sv_http_ingress.lua",
    "@tlib/server/sv_http_ingress.lua",
    "@TLIB/SERVER/SV_HTTP_INGRESS.LUA",
    "@tLib\\server\\sv_http_ingress.lua",
  ]) {
    const m = manifest([entry]);
    expect(loadsIngressDoor("x", m.count, m.read)).toBe(true);
  }
  // And it is a SUFFIX match, not a substring one: a resource of its own with a
  // similarly-named script must not be mistaken for the door.
  const near = manifest(["server/sv_http_ingress.lua.bak", "my_tlib/server/sv_http_ingress_shim.lua"]);
  expect(loadsIngressDoor("x", near.count, near.read)).toBe(false);
});

test("FAILS OPEN: a runtime that cannot answer never cries wolf", () => {
  const throwsCount = () => {
    throw new Error("native unavailable");
  };
  const throwsRead = () => {
    throw new Error("native unavailable");
  };
  expect(loadsIngressDoor("tRadio", throwsCount as never, throwsRead as never)).toBe(true);

  // A count the engine could not produce is "unknown", not "zero scripts".
  for (const bad of [0, -1, Number.NaN]) {
    expect(loadsIngressDoor("tRadio", () => bad, () => null)).toBe(true);
  }

  // A reader that throws per-entry skips that entry rather than aborting the scan, so a
  // door listed after a bad index is still found.
  const flaky = (_r: string, _k: string, i: number) => {
    if (i === 0) throw new Error("bad index");
    return "@tLib/server/sv_http_ingress.lua";
  };
  expect(loadsIngressDoor("tRadio", () => 2, flaky)).toBe(true);
});
