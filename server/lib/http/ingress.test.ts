/**
 * The routing decisions the FiveM-server-port ingress acts on.
 *
 * `resolveIngress` exists because the ingress cannot ask the router over HTTP —
 * a `PerformHttpRequest` from inside `SetHttpHandler` to a listener in the same
 * process crashes FXServer (see ingress.ts). It therefore DUPLICATES the
 * decisions `Router.onRequest` makes, and duplication is what drifts. These
 * cases are the ones where drift would be silent.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ingressUrlFrom, resolveIngress } from "./ingress";
import { clear, register } from "./registry";

const proxyMount = (over: Record<string, unknown> = {}) =>
  ({
    kind: "proxy" as const,
    id: "radio",
    mount: "/dispatch",
    title: "Dispatch",
    listed: true,
    resourceName: "tRadio",
    upstream: { host: "127.0.0.1", port: 7777 },
    stripPrefix: false,
    websocket: true,
    ...over,
  }) as Parameters<typeof register>[0];

const resolve = (path: string, method = "GET", basePath = "/tLib") =>
  resolveIngress(method, path, "Test Server", basePath);

beforeEach(() => clear());

describe("reaching an app", () => {
  test("a mounted path resolves to its own loopback upstream, never to us", () => {
    register(proxyMount());
    const r = resolve("/dispatch/app.wasm");
    expect(r.kind).toBe("upstream");
    // The whole design rests on this being a DIFFERENT process. An upstream
    // pointing at tLib's own listener is the crash this file's subject avoids.
    expect(r).toMatchObject({ host: "127.0.0.1", port: 7777, path: "/dispatch/app.wasm" });
  });

  test("the query string survives into the upstream path", () => {
    register(proxyMount());
    const r = resolve("/dispatch/app.js?v=3");
    expect(r.kind === "upstream" && r.path).toBe("/dispatch/app.js?v=3");
  });

  test("stripPrefix removes the mount, as the listener does", () => {
    register(proxyMount({ stripPrefix: true }));
    const r = resolve("/dispatch/app.js");
    expect(r.kind === "upstream" && r.path).toBe("/app.js");
  });
});

/**
 * ⛔ The bug this group exists for, found by following a redirect in a browser.
 *
 * Every path the registry holds is absolute from the ROUTER's root, but this
 * door is mounted one level down at `/<resource>`. Emitting the registry's path
 * verbatim sent the browser to `/dispatch/`, which is not this resource's
 * namespace — FXServer answers 404 and the app is simply unreachable, with
 * nothing in any log to say why.
 */
describe("the base path is applied to everything a client follows", () => {
  test("an index redirect is prefixed", () => {
    register(proxyMount({ index: "/_/" }));
    const r = resolve("/dispatch");
    expect(r).toMatchObject({ status: 302 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tLib/dispatch/_/");
  });

  test("the trailing-slash redirect is prefixed", () => {
    register(proxyMount({ stripPrefix: true }));
    const r = resolve("/dispatch");
    expect(r).toMatchObject({ status: 301 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tLib/dispatch/");
  });

  test("the single-destination hub redirect is prefixed", () => {
    register(proxyMount());
    const r = resolve("/");
    expect(r).toMatchObject({ status: 302 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tLib/dispatch/");
  });

  test("hub links are prefixed when more than one destination exists", () => {
    register(proxyMount());
    register(proxyMount({ id: "cad", mount: "/cad", title: "CAD", resourceName: "tCAD" }));
    const r = resolve("/");
    expect(r.kind === "inline" && r.status).toBe(200);
    const html = r.kind === "inline" ? r.body : "";
    expect(html).toContain('href="/tLib/dispatch/"');
    expect(html).toContain('href="/tLib/cad/"');
    // The unprefixed form is what shipped before this was caught; a card
    // carrying it is the regression, so assert its absence directly.
    expect(html).not.toContain('href="/dispatch/"');
  });

  test("an empty base path leaves paths untouched, which is the listener's case", () => {
    register(proxyMount());
    const r = resolveIngress("GET", "/", "Test Server", "");
    expect(r.kind === "inline" && r.headers.Location).toBe("/dispatch/");
  });
});

describe("refusals match the listener's", () => {
  test("an unknown path is a 404 page, not an upstream", () => {
    const r = resolve("/nothing-here");
    expect(r).toMatchObject({ kind: "inline", status: 404 });
  });

  test("an absolute-form target is refused — this is not a forward proxy", () => {
    const r = resolve("http://example.com/");
    expect(r).toMatchObject({ kind: "inline", status: 400 });
  });

  test("a traversal attempt never reaches an upstream", () => {
    register(proxyMount());
    // `normalizePath` is shared with the listener, so this holds by construction
    // — asserted anyway because the consequence of it ever not holding is a path
    // escaping the mount it was meant to be confined to.
    //
    // ⚠ A PERCENT-ENCODED separator is deliberately NOT in this list, and that is
    // not an oversight. FXServer decodes `request.path` before the handler sees
    // it, so `/dispatch/..%2f..%2fetc` arrives here already decoded and is caught
    // by the plain case above. Measured live on both doors: the ingress answers
    // 404, the listener answers 200 and forwards the encoded form to the app.
    // Feeding the encoded string to this function directly tests a shape that
    // cannot reach it through this door, and would assert a guarantee the ingress
    // does not make.
    expect(resolve("/dispatch/../../etc/passwd")).toMatchObject({
      kind: "inline",
      status: 404,
    });

    // CONTROL, and the reason the case above means something: a `..` that stays
    // INSIDE the mount is resolved, not refused. Without this, a blanket
    // rejection of every path containing `..` would pass the assertion above
    // while breaking every app that builds a URL with a relative segment.
    expect(resolve("/dispatch/sub/../x")).toMatchObject({
      kind: "upstream",
      path: "/dispatch/x",
    });
  });

  test("the hub is GET/HEAD only, as it is on the listener", () => {
    register(proxyMount());
    const r = resolve("/", "POST");
    expect(r).toMatchObject({ kind: "inline", status: 405 });
    expect(r.kind === "inline" && r.headers.Allow).toBe("GET, HEAD");
  });

  test("an in-process mount answers 501 rather than being relayed", () => {
    // Relaying one would mean an HTTP call into our own process, which is the
    // fatal case. Today the only in-process mount is realtime, which is
    // WebSocket-only, so nothing visible is lost by refusing here.
    register({
      kind: "inprocess",
      id: "realtime",
      mount: "/realtime",
      title: "Realtime",
      listed: false,
      resourceName: "tLib",
      onRequest: () => {},
    } as unknown as Parameters<typeof register>[0]);
    const r = resolve("/realtime/socket");
    expect(r).toMatchObject({ kind: "inline", status: 501 });
  });
});

/**
 * ⛔ `res.writeHead(status, {})` CRASHES FXSERVER.
 *
 * Not a hang, not a 500 — "The application has crashed!", the whole game server,
 * in about 2.4 s. Bisected 2026-10-27: the identical call with one header present
 * is fine, with the same status variable, so it is the empty table and nothing
 * else. An empty Lua table marshals as an empty ARRAY rather than an object,
 * which is the same ambiguity `shared/data_defaults.lua` documents for data.json.
 *
 * The Lua relay seeds its header table to make this unreachable there. These
 * assertions cover the other half: every inline answer built HERE is handed
 * straight to `writeHead` by `sv_http_ingress.lua`, so one with no headers would
 * be a server crash shipped from TypeScript.
 */
describe("no inline answer may carry an empty header table", () => {
  const cases: [string, () => unknown][] = [
    ["404", () => resolve("/nothing-here")],
    ["400 absolute-form", () => resolve("http://example.com/")],
    ["405 on the hub", () => resolve("/", "POST")],
    [
      "302 index redirect",
      () => {
        register(proxyMount({ index: "/_/" }));
        return resolve("/dispatch");
      },
    ],
    [
      "301 trailing slash",
      () => {
        register(proxyMount({ stripPrefix: true }));
        return resolve("/dispatch");
      },
    ],
    [
      "302 single destination",
      () => {
        register(proxyMount());
        return resolve("/");
      },
    ],
    [
      "200 hub page",
      () => {
        register(proxyMount());
        register(proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD" }));
        return resolve("/");
      },
    ],
  ];

  for (const [label, make] of cases) {
    test(`${label} has at least one header`, () => {
      const r = make() as { kind: string; headers?: Record<string, string> };
      expect(r.kind).toBe("inline");
      expect(Object.keys(r.headers ?? {}).length).toBeGreaterThan(0);
    });
  }
});

describe("every answer carries the listener's hardening", () => {
  test("nosniff is set on an inline response", () => {
    const r = resolve("/nothing-here");
    expect(r.kind === "inline" && r.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("the hub page is not cacheable — visibility changes on a resource restart", () => {
    register(proxyMount());
    register(proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD" }));
    const r = resolve("/");
    expect(r.kind === "inline" && r.headers["Cache-Control"]).toBe("no-store");
  });
});

/**
 * The boot line. It previously printed a literal `<your-server>` placeholder,
 * which is not a URL anybody can use — the whole point of this door is that an
 * operator does not have to work anything out.
 */
describe("the URL printed for the second door", () => {
  test("swaps the listener's port for the FiveM one", () => {
    expect(ingressUrlFrom("http://203.0.113.9:7777", true, "30120", "tLib")).toBe(
      "http://203.0.113.9:30120/tLib"
    );
  });

  test("keeps an IPv6 authority intact", () => {
    expect(ingressUrlFrom("http://[2001:db8::1]:7777", true, "30120", "tLib")).toBe(
      "http://[2001:db8::1]:30120/tLib"
    );
  });

  test("refuses to guess when the operator configured the address", () => {
    // A name means a proxy terminating TLS and forwarding to the listener. That
    // proxy knows nothing about the FXServer port, so a port-swapped URL would
    // be unreachable — and a printed URL that does not work is worse than none.
    expect(ingressUrlFrom("https://radio.example.com", false, "30120", "tLib")).toBeNull();
    expect(ingressUrlFrom("http://203.0.113.9:7777", false, "30120", "tLib")).toBeNull();
  });

  test("refuses when there is no port to swap", () => {
    expect(ingressUrlFrom("https://radio.example.com", true, "30120", "tLib")).toBeNull();
  });

  test("refuses a nonsense netPort rather than printing it", () => {
    expect(ingressUrlFrom("http://203.0.113.9:7777", true, "", "tLib")).toBeNull();
    expect(ingressUrlFrom("http://203.0.113.9:7777", true, "0", "tLib")).toBeNull();
    expect(ingressUrlFrom("http://203.0.113.9:7777", true, "99999", "tLib")).toBeNull();
  });

  test("tolerates a trailing slash on the resolved URL", () => {
    expect(ingressUrlFrom("http://203.0.113.9:7777/", true, "30120", "tLib")).toBe(
      "http://203.0.113.9:30120/tLib"
    );
  });
});
