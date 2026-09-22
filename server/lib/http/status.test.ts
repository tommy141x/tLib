import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerBridge } from "./bridge";
import { clear, hubDestinations, list, unregisterResource } from "./registry";
import { HttpReadiness, type HttpStatus } from "./status";

beforeEach(clear);
afterEach(clear);

function harness(override: string | null = null) {
  const events: HttpStatus[] = [];
  const state = new HttpReadiness(override, 7777, (value) => events.push(value));
  const exports = new Map<string, (...args: unknown[]) => unknown>();
  registerBridge(
    () => state.snapshot(),
    () => {},
    {
      exports: (name, fn) => {
        exports.set(name, fn);
      },
      invokingResource: () => "consumer",
    }
  );
  const call = (name: string, ...args: unknown[]) => exports.get(name)!(...args) as any;
  const mount = () =>
    call("RegisterWebApp", {
      id: "radio",
      mount: "/dispatch",
      port: 12345,
      stripPrefix: true,
    });
  return { state, events, call, mount };
}

describe("HTTP publication readiness", () => {
  test("pending discovery never advertises localhost or reserves a mount", () => {
    const h = harness();
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.call("GetHttpStatus").ready).toBe(false);
    expect(h.call("GetHubUrl")).toBe("");
    expect(h.mount()).toMatchObject({ ok: false, retryable: true });
    expect(h.mount().url).toBeUndefined();
    expect(list()).toHaveLength(0);
    h.state.resolveAddress("203.0.113.10");
    expect(h.events.at(-1)?.ready).toBe(true);
    expect(h.mount()).toEqual({ ok: true, url: "http://203.0.113.10:7777/dispatch" });
    expect(h.call("GetHubUrl")).toBe("http://203.0.113.10:7777");
  });

  test("discovery before binding still waits for a listening socket", () => {
    const h = harness();
    h.state.resolveAddress("203.0.113.10");
    expect(h.mount()).toMatchObject({ ok: false, retryable: true });
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.mount().ok).toBe(true);
  });

  test("registration exports preserve one mount with independent child hub links", () => {
    const h = harness("https://example.com");
    h.state.listener("listening", "http://127.0.0.1:7777");
    const result = h.call("RegisterWebApp", {
      id: "radio",
      mount: "/dispatch",
      port: 12345,
      listed: false,
      hubLinks: [
        { id: "admin", path: "/admin", title: "Radio Admin", listed: true },
        { id: "external", path: "https://evil.example" },
      ],
    });
    expect(result).toEqual({ ok: true, url: "https://example.com/dispatch" });
    expect(list()).toHaveLength(1);
    expect(hubDestinations()).toMatchObject([{ path: "/dispatch/admin", title: "Radio Admin" }]);
    expect(h.call("ListWebApps")[0].hubLinks).toHaveLength(1);
  });

  test("HTTPS public 443 never changes the local HTTP 7777 endpoint", () => {
    const h = harness("https://example.com");
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.call("GetHttpStatus")).toMatchObject({
      ready: true,
      publicUrl: "https://example.com",
      localUrl: "http://127.0.0.1:7777",
    });
    expect(h.mount()).toEqual({ ok: true, url: "https://example.com/dispatch" });
  });

  test("bind failure suppresses publication despite a valid public address", () => {
    const h = harness("example.com");
    h.state.listener("failed", null, "address already in use");
    expect(h.mount()).toMatchObject({
      ok: false,
      retryable: true,
      error: "address already in use",
    });
    expect(h.call("GetHubUrl")).toBe("");
    expect(h.call("GetHttpStatus").localUrl).toBeNull();
    expect(list()).toHaveLength(0);
  });

  test("failed discovery has an actionable error, not localhost OAuth", () => {
    const h = harness();
    h.state.listener("listening", "http://127.0.0.1:7777");
    h.state.resolveAddress(null);
    expect(h.call("GetHttpStatus")).toMatchObject({
      ready: false,
      publicUrlState: "failed",
      publicUrl: null,
    });
    expect(h.mount().error).toContain("tlib_http_public_url");
    expect(h.call("GetHubUrl")).toBe("");
  });

  test("explicit localhost works without discovery", () => {
    const h = harness("localhost");
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.mount()).toEqual({ ok: true, url: "http://localhost:7777/dispatch" });
  });

  test("a stopped lifetime cannot be revived by late discovery", () => {
    const h = harness();
    h.state.listener("stopped");
    const notifications = h.events.length;
    h.state.resolveAddress("203.0.113.10");
    expect(h.events).toHaveLength(notifications);
    expect(h.call("GetHttpStatus").ready).toBe(false);
    expect(h.call("GetHubUrl")).toBe("");
  });

  test("consumer restart can re-register after owner cleanup", () => {
    const h = harness("example.com");
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.mount().ok).toBe(true);
    expect(h.mount().ok).toBe(false); // collisions are not silently replaced
    unregisterResource("consumer");
    expect(h.mount().ok).toBe(true);
  });

  test("tLib restart clears old mounts and publishes only the new lifetime", () => {
    const old = harness("old.example.com");
    old.state.listener("listening", "http://127.0.0.1:7777");
    expect(old.mount().ok).toBe(true);
    old.state.listener("stopped");
    clear(); // installHttp's own onResourceStop cleanup
    const next = harness("new.example.com");
    expect(next.mount().ok).toBe(false);
    next.state.listener("listening", "http://127.0.0.1:7777");
    expect(next.mount()).toEqual({ ok: true, url: "https://new.example.com/dispatch" });
    expect(old.call("GetHubUrl")).toBe("");
  });
});
