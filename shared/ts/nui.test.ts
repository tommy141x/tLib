import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetNuiBridgeWarning, fetchNui, getResourceName, isNUI } from "./nui.ts";

/*
 * The NUI bridge's ABSENCE, which is the case that cost a customer ten days.
 *
 * `fetchNui` resolves null without sending anything when `window.GetParentResourceName`
 * is missing. That is correct in a browser and in the dev harness, and fatal in game:
 * every callback the page makes to Lua silently does nothing. It used to be reported
 * only at `console.debug`, which FiveM's F8 filters out, so a client in that state
 * presented as a slow or misconfigured SERVER — and the radio's own poll then blamed a
 * serverAddress and authToken that the net-event transport does not even have.
 *
 * `window` is assigned directly rather than through `mock.module`, which is
 * process-global in bun and leaks into every other test file in the run.
 */

const realWindow = (globalThis as { window?: unknown }).window;
const realWarn = console.warn;
const realDebug = console.debug;
const realFetch = globalThis.fetch;

let warnings: string[] = [];
let fetchCalls: string[] = [];

function setBridge(name: unknown, present = true): void {
  (globalThis as { window?: unknown }).window = present
    ? { GetParentResourceName: () => name }
    : {};
}

beforeEach(() => {
  __resetNuiBridgeWarning();
  warnings = [];
  fetchCalls = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  console.debug = () => {};
  globalThis.fetch = ((url: string) => {
    fetchCalls.push(String(url));
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
  console.warn = realWarn;
  console.debug = realDebug;
  globalThis.fetch = realFetch;
});

test("a present bridge gives the real resource name", () => {
  setBridge("tRadio");
  expect(isNUI()).toBe(true);
  expect(getResourceName()).toBe("tRadio");
});

test("an empty or non-string answer falls back instead of becoming an empty host", () => {
  // The guard this exists for: `GetParentResourceName` can EXIST — so `isNUI()` is true
  // and the fetch path is not short-circuited — and still answer "" or undefined. The
  // previous `?? fallback` passed "" straight through, producing `https:///<event>`.
  setBridge("");
  expect(isNUI()).toBe(true);
  expect(getResourceName()).toBe("tLib");
  setBridge(undefined);
  expect(getResourceName()).toBe("tLib");
  // Explicit fallback still honoured, so a consumer can name itself.
  expect(getResourceName("tRadio")).toBe("tRadio");
});

test("with no bridge, fetchNui sends nothing, resolves null, and says so ONCE", async () => {
  setBridge(null, false);
  expect(isNUI()).toBe(false);

  const first = await fetchNui("requestConnectionInfo", {});
  expect(first).toBeNull();

  // The discriminating half: nothing was put on the wire. Without this the test would
  // pass on a `fetchNui` that silently succeeded against the wrong host.
  expect(fetchCalls).toEqual([]);

  // Audible exactly once, naming the condition and the first offending callback.
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("GetParentResourceName is absent");
  expect(warnings[0]).toContain("requestConnectionInfo");
  // And explicitly NOT a server-side diagnosis, which is the wrong turn this took.
  expect(warnings[0]).toContain("not a server, address or token fault");

  for (let i = 0; i < 20; i++) await fetchNui("screen:displayUpdate", {});
  // 21 calls, still one warning — the radio's poll makes these forever.
  expect(warnings.length).toBe(1);
  expect(fetchCalls).toEqual([]);
});

test("a present bridge does NOT warn — the browser/harness case stays silent", async () => {
  setBridge("tRadio");
  await fetchNui("requestConnectionInfo", {});
  expect(warnings).toEqual([]);
  // And it actually reached the wire, addressed to the right resource.
  expect(fetchCalls.length).toBe(1);
  expect(fetchCalls[0]).toBe("https://tRadio/requestConnectionInfo");
});
