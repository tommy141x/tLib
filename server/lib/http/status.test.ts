import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerBridge } from "./bridge";
import { clear, hubDestinations, list, unregisterResource } from "./registry";
import { HttpReadiness, type HttpStatus } from "./status";

beforeEach(clear);
afterEach(clear);

function harness(
  override: string | null = null,
  doors = { listener: true, ingress: true },
  // The published port follows the door: a listener's own port, or the FiveM
  // server port when nothing binds. `installHttp` makes the same choice.
  port = doors.listener ? 7777 : 30120
) {
  const events: HttpStatus[] = [];
  const state = new HttpReadiness(override, () => port, (value) => events.push(value), doors);
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
  const mount = (mountPath = "/dispatch") =>
    call("RegisterWebApp", {
      id: "radio",
      mount: mountPath,
      port: 12345,
      stripPrefix: true,
    });
  return { state, events, call, mount };
}

describe("HTTP publication readiness", () => {
  /**
   * Setting `tlib_http_port` to the FiveM server port must behave exactly as
   * leaving it unset. FXServer already owns that socket, so the bind fails
   * EADDRINUSE — and before this, a reasonable-looking config produced a server
   * with no door at all, because `doors.listener` stayed true and `door()`
   * waited forever for a listener that could never come up.
   */
  test("a listener disabled at runtime falls through to the ingress door", () => {
    const events: HttpStatus[] = [];
    const state = new HttpReadiness(null, () => 30120, (v) => events.push(v), {
      listener: true,
      ingress: true,
    });
    state.resolveAddress("203.0.113.9");
    expect(state.snapshot().door).toBeNull();

    state.listener("disabled", null, null);
    const snap = state.snapshot();
    expect(snap.door).toBe("ingress");
    expect(snap.ready).toBe(true);
    expect(snap.publicUrl).toBe("http://203.0.113.9:30120");
  });

  /**
   *  `netPort` is not populated when a resource's bundle loads. FXServer fills
   * it later in boot, and `GetConvar("netPort", "")` reads as the string "0"
   * until it does — so a readiness that CAPTURED the port published
   * `http://<host>:0`. Zero is finite, so no range guard caught it; it reached
   * an operator's banner and tDB's admin link as `http://172.11.122.115:0/tDB/_/`.
   *
   * The port is therefore read through a getter at each resolve. These two cases
   * are that contract: unknown yet means NOT ready, and the value that lands is
   * the one read later, never the one read at construction.
   */
  test("a port that is not knowable yet does not publish a zero port", () => {
    const events: HttpStatus[] = [];
    const state = new HttpReadiness(null, () => null, (v) => events.push(v), {
      listener: false,
      ingress: true,
    });
    state.resolveAddress("203.0.113.9");
    const snap = state.snapshot();
    expect(snap.ready).toBe(false);
    expect(snap.publicUrl ?? "").not.toContain(":0");
  });

  test("the port read LATER is the one published, not the one at construction", () => {
    let port: number | null = null;
    const events: HttpStatus[] = [];
    const state = new HttpReadiness(null, () => port, (v) => events.push(v), {
      listener: false,
      ingress: true,
    });
    // Boot order: the address resolves before FXServer has filled netPort.
    state.resolveAddress("203.0.113.9");
    expect(state.snapshot().ready).toBe(false);

    port = 30120;
    state.resolveAddress("203.0.113.9");
    expect(state.snapshot().publicUrl).toBe("http://203.0.113.9:30120");
  });

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

/**
 * Whether the published address was configured or guessed. Not cosmetic: a
 * wrong guess doesn't announce itself, it surfaces later as a CORS refusal or
 * an unreachable OAuth redirect. `publicUrlDetected` is what lets the banner
 * row name `tlib_http_public_url` exactly when there's something to act on.
 */
describe("the published address knows whether it was configured", () => {
  test("an override is not detected, at construction", () => {
    const state = new HttpReadiness("http://ij1.de:6310", () => 7777, () => {});
    const snap = state.snapshot();
    expect(snap.publicUrl).toBe("http://ij1.de:6310");
    expect(snap.publicUrlDetected).toBe(false);
  });

  test("an IP discovered at runtime IS detected", () => {
    const state = new HttpReadiness(null, () => 7777, () => {});
    state.resolveAddress("203.0.113.9");
    const snap = state.snapshot();
    expect(snap.publicUrl).toBe("http://203.0.113.9:7777");
    expect(snap.publicUrlDetected).toBe(true);
  });

  test("an override still wins when discovery lands after it", () => {
    // The ordering that matters: discovery is async, so a configured address
    // must not be relabelled as a guess by a result that arrives later.
    const state = new HttpReadiness("http://ij1.de:6310", () => 7777, () => {});
    state.resolveAddress("203.0.113.9");
    const snap = state.snapshot();
    expect(snap.publicUrl).toBe("http://ij1.de:6310");
    expect(snap.publicUrlDetected).toBe(false);
  });

  test("failed discovery reports detected, so the row can still name the convar", () => {
    const state = new HttpReadiness(null, () => 7777, () => {});
    state.resolveAddress(null);
    const snap = state.snapshot();
    expect(snap.publicUrlState).toBe("failed");
    expect(snap.publicUrlDetected).toBe(true);
  });
});

/**
 * Binding a port is opt-in. With neither `tlib_http_port` nor `tlib_http_host`
 * set there is no listener and no socket to wait for, and the FiveM server port
 * ingress is the only door — so publication must proceed, and every address it
 * hands out must be spelled for that door.
 */
describe("with no listener, the FiveM server port is the door", () => {
  const noListener = { listener: false, ingress: true };

  test("readiness needs an address only, and there is no local origin to probe", () => {
    const h = harness(null, noListener);
    expect(h.call("GetHttpStatus").ready).toBe(false); // discovery outstanding
    h.state.resolveAddress("203.0.113.10");
    expect(h.call("GetHttpStatus")).toMatchObject({
      ready: true,
      door: "ingress",
      // Not "starting": a consumer that prints this state would otherwise tell
      // an operator a socket is on its way that nothing is going to bind.
      listenerState: "disabled",
      publicUrl: "http://203.0.113.10:30120",
      localUrl: null,
      error: null,
    });
  });

  test("a mount's url is its path under its OWNING resource, not under the mount", () => {
    const h = harness(null, noListener);
    h.state.resolveAddress("203.0.113.10");
    expect(h.mount("/dispatch")).toEqual({
      ok: true,
      url: "http://203.0.113.10:30120/consumer/dispatch",
    });
    expect(h.call("ListWebApps")[0].url).toBe("http://203.0.113.10:30120/consumer/dispatch");
  });

  test("a mount named after its resource is not repeated, and carries no trailing slash", () => {
    // The reason mounts are named after their resource: FXServer has already
    // consumed that segment, so the app has ONE spelling on both doors. A
    // trailing slash here would also break a consumer that compares what it was
    // given against a base it composed itself.
    const h = harness(null, noListener);
    h.state.resolveAddress("203.0.113.10");
    expect(h.mount("/consumer")).toEqual({
      ok: true,
      url: "http://203.0.113.10:30120/consumer",
    });
  });

  test("a configured public name is honoured, with the ingress path under it", () => {
    const h = harness("https://example.com", noListener);
    expect(h.mount("/consumer")).toEqual({ ok: true, url: "https://example.com/consumer" });
  });

  test("turning the ingress off as well leaves no door, and says which convar opens one", () => {
    const h = harness(null, { listener: false, ingress: false });
    h.state.resolveAddress("203.0.113.10");
    const status = h.call("GetHttpStatus");
    expect(status).toMatchObject({ ready: false, door: null, localUrl: null });
    expect(status.error).toContain("tlib_http_port");
    expect(status.error).toContain("tlib_http_ingress");
    expect(h.mount()).toMatchObject({ ok: false, retryable: true });
    expect(list()).toHaveLength(0);
    expect(h.call("GetHubUrl")).toBe("");
  });

  test("a stopped lifetime closes the ingress door too, and late discovery is inert", () => {
    // Without a listener nothing reports "stopped" on its own, so installHttp
    // says it on tLib's own stop. Otherwise an outstanding IP detection lands
    // on a dead lifetime and publishes an address into it.
    const h = harness(null, noListener);
    h.state.listener("stopped");
    const notifications = h.events.length;
    h.state.resolveAddress("203.0.113.10");
    expect(h.events).toHaveLength(notifications);
    expect(h.call("GetHttpStatus")).toMatchObject({ ready: false, door: null });
    expect(h.mount()).toMatchObject({ ok: false, retryable: true });
  });

  test("a configured listener still publishes its own spelling, never the ingress one", () => {
    // The negative control for the rule above: `publicUrl` carries the
    // LISTENER's port once one is configured, so an ingress path hung off it
    // would name 7777 with a 30120 path and reach nothing.
    const h = harness("example.com");
    h.state.listener("listening", "http://127.0.0.1:7777");
    expect(h.call("GetHttpStatus").door).toBe("listener");
    expect(h.mount("/consumer")).toEqual({ ok: true, url: "https://example.com/consumer" });
    expect(h.mount("/dispatch")).toEqual({ ok: true, url: "https://example.com/dispatch" });
  });
});
