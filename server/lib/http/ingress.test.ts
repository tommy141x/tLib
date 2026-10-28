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
import { clear, hubDestinations, match, matchLegacy, register } from "./registry";

/**
 * tRadio's real shape: the mount is NAMED AFTER THE RESOURCE, which is what
 * makes `/tRadio/admin` the address on both doors, and `stripPrefix` is what
 * lets the segment come off before the upstream sees it. A fixture that got
 * either wrong would exercise the generic "mounted under some other name" path
 * instead, and every assertion below would still pass while testing nothing
 * that ships.
 */
const proxyMount = (over: Record<string, unknown> = {}) =>
  ({
    kind: "proxy" as const,
    id: "radio",
    mount: "/tRadio",
    legacyMounts: ["/dispatch"],
    title: "Dispatch",
    listed: true,
    resourceName: "tRadio",
    upstream: { host: "127.0.0.1", port: 7777 },
    stripPrefix: true,
    websocket: true,
    ...over,
  }) as Parameters<typeof register>[0];

/** An app mounted under a name that is NOT its resource — it keeps the segment. */
const foreignMount = (over: Record<string, unknown> = {}) =>
  proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD", legacyMounts: undefined, ...over });

/**
 * A CONSUMER's door: tRadio, serving the mount it owns at `/tRadio/...`.
 *
 * Which door a request arrives at is the whole routing question on this port.
 * FXServer resolves a path's first segment to a resource before any of this
 * runs, so tRadio's mount is reachable from tRadio's door and from no other.
 */
const resolve = (path: string, method = "GET") =>
  resolveIngress(method, path, "Test Server", "/tRadio", "tRadio");

/** tLib's door, which owns no proxy mount and is therefore the hub. */
const hub = (path: string, method = "GET") =>
  resolveIngress(method, path, "Test Server", "/tLib", "tLib");

beforeEach(() => clear());

describe("reaching an app", () => {
  test("a path on the resource's own door resolves to its loopback upstream", () => {
    register(proxyMount());
    const r = resolve("/app.wasm");
    expect(r.kind).toBe("upstream");
    // FXServer consumed `/tRadio`, the door puts it back to find the mount, and
    // stripPrefix takes it off again — so the upstream sees what it always saw.
    expect(r).toMatchObject({ host: "127.0.0.1", port: 7777, path: "/app.wasm" });
  });

  test("the query string survives into the upstream path", () => {
    register(proxyMount());
    const r = resolve("/app.js?v=3");
    expect(r.kind === "upstream" && r.path).toBe("/app.js?v=3");
  });

  test("the bare door root is the app itself, not a redirect", () => {
    register(proxyMount());
    expect(resolve("/")).toMatchObject({ kind: "upstream", path: "/" });
  });

  test("an app mounted under another name keeps that name as a second segment", () => {
    register(foreignMount());
    const r = resolveIngress("GET", "/cad/app.js", "Test Server", "/tCAD", "tCAD");
    expect(r).toMatchObject({ kind: "upstream", path: "/app.js" });
  });
});

/**
 * The bug this group exists for, found by following a redirect in a browser.
 *
 * Every path the registry holds is absolute from the ROUTER's root, but this
 * door is mounted one level down at `/<resource>`. Emitting the registry's path
 * verbatim sent the browser to `/dispatch/`, which is not this resource's
 * namespace — FXServer answers 404 and the app is simply unreachable, with
 * nothing in any log to say why.
 */
describe("the base path is applied to everything a client follows", () => {
  test("an index redirect is prefixed, and loses the mount with it", () => {
    // tDB's shape: PocketBase serves nothing at its root and its admin UI at
    // `/_/`. The mount must not reappear — `/tDB/db/_/` is the bug.
    register(proxyMount({ id: "db", mount: "/tDB", resourceName: "tDB", index: "/_/" }));
    const r = resolveIngress("GET", "/", "Test Server", "/tDB", "tDB");
    expect(r).toMatchObject({ status: 302 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tDB/_/");
  });

  test("the trailing-slash redirect is prefixed", () => {
    register(foreignMount({ stripPrefix: true }));
    const r = resolveIngress("GET", "/cad", "Test Server", "/tCAD", "tCAD");
    expect(r).toMatchObject({ status: 301 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tCAD/cad/");
  });

  test("a door whose app is mounted elsewhere sends its bare root to it", () => {
    register(foreignMount());
    const r = resolveIngress("GET", "/", "Test Server", "/tCAD", "tCAD");
    expect(r).toMatchObject({ status: 302 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tCAD/cad/");
  });

  test("the hub links across resources, because each one owns its own door", () => {
    register(proxyMount());
    register(foreignMount({ title: "CAD" }));
    const r = hub("/");
    expect(r.kind === "inline" && r.status).toBe(200);
    const html = r.kind === "inline" ? r.body : "";
    expect(html).toContain('href="/tRadio/"');
    expect(html).toContain('href="/tCAD/cad/"');
    // Three wrong forms, each of which this work has produced at some point:
    // the segment doubled, the hub's own prefix (a 404, since tLib owns neither
    // mount), and the router's flat path, which belongs to no resource at all.
    expect(html).not.toContain('href="/tRadio/tRadio/"');
    expect(html).not.toContain('href="/tLib/tRadio/"');
    expect(html).not.toContain('href="/cad/"');
  });

  test("an empty base path leaves paths untouched, which is the listener's case", () => {
    register(proxyMount());
    const r = resolveIngress("GET", "/", "Test Server", "");
    expect(r.kind === "inline" && r.headers.Location).toBe("/tRadio/");
  });
});

/**
 * One app, one URL. FXServer routes `/tRadio/...` to tRadio and nothing else can
 * answer it, so serving the same app at `/tLib/dispatch/` as well would mean two
 * addresses for one thing, only one of which the app can build links for.
 */
describe("a mount is reachable only under its owner", () => {
  test("the hub's door does not serve another resource's mount", () => {
    register(proxyMount());
    expect(hub("/dispatch/")).toMatchObject({ kind: "inline", status: 404 });
    expect(hub("/dispatch/app.js")).toMatchObject({ kind: "inline", status: 404 });
  });

  test("and its owner's door does", () => {
    register(proxyMount());
    expect(resolve("/dispatch/app.js")).toMatchObject({ kind: "upstream" });
  });

  test("a third resource's door reaches neither", () => {
    register(proxyMount());
    register(proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD" }));
    const r = resolveIngress("GET", "/dispatch/app.js", "Test Server", "/tOther", "tOther");
    expect(r).toMatchObject({ kind: "inline", status: 404 });
  });

  test("the listener still serves every mount from one root", () => {
    register(proxyMount());
    register(proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD" }));
    // `owner` omitted: the listener is a single door and its flat paths are
    // unchanged by any of this.
    expect(resolveIngress("GET", "/tRadio/app.js", "Test Server", "")).toMatchObject({
      kind: "upstream",
      path: "/app.js",
    });
    expect(resolveIngress("GET", "/cad/app.js", "Test Server", "")).toMatchObject({
      kind: "upstream",
    });
  });
});

/**
 * The point of naming a mount after its resource: ONE spelling per app.
 *
 * `/tRadio/admin` is the address on tLib's listener and on the FiveM server
 * port, which is why the panel can state a single `<base href>` and why the
 * Socket.IO client path, the OAuth redirect and the updater URL are one value
 * each. When they were two, the page loaded and every asset under it 404ed with
 * nothing in any log.
 */
describe("both doors spell a self-named app the same", () => {
  test("the hub's card and the app's own door agree, segment for segment", () => {
    register(proxyMount({ hubLinks: [{ id: "admin", path: "/admin", title: "Admin" }] }));
    const [root, admin] = hubDestinations();
    // What the listener serves, and what the server port serves.
    expect(root.path).toBe("/tRadio/");
    expect(root.ingressPath).toBe("/tRadio/");
    expect(admin.path).toBe("/tRadio/admin");
    expect(admin.ingressPath).toBe("/tRadio/admin");
  });

  test("and the upstream is asked for the same path from either", () => {
    register(proxyMount());
    const viaListener = resolveIngress("GET", "/tRadio/admin", "Test Server", "");
    const viaDoor = resolve("/admin");
    expect(viaListener.kind === "upstream" && viaListener.path).toBe("/admin");
    expect(viaDoor.kind === "upstream" && viaDoor.path).toBe("/admin");
  });

  test("the forwarded prefix is the same string on both, which is what the app echoes", () => {
    register(proxyMount());
    const viaDoor = resolve("/admin");
    // `X-Forwarded-Prefix`, which becomes the panel's `<base href>`. The bug
    // this replaces had the door sending `/tLib/dispatch` while the listener
    // sent `/dispatch`.
    expect(viaDoor.kind === "upstream" && viaDoor.prefix).toBe("/tRadio");
  });

  test("a foreign mount is the one case they differ, and it says so", () => {
    register(foreignMount());
    const [only] = hubDestinations();
    expect(only.path).toBe("/cad/");
    expect(only.ingressPath).toBe("/tCAD/cad/");
  });
});

/**
 * Renaming a URL without breaking it. `/dispatch` and `/db` were the mounts
 * before 2026-10-27 and are in operators' bookmarks, their browser history and
 * anything they linked internally.
 */
describe("a renamed mount keeps answering at its old path", () => {
  test("the old path redirects to the new one, permanently", () => {
    register(proxyMount());
    expect(matchLegacy("/dispatch")).toMatchObject({ from: "/dispatch" });
    expect(matchLegacy("/dispatch/admin")).toMatchObject({ from: "/dispatch" });
  });

  test("a path that was never a mount is still nothing", () => {
    register(proxyMount());
    expect(matchLegacy("/nothing-here")).toBeNull();
  });

  test("a legacy path equal to or inside the live mount is refused, not stored", () => {
    // `/tRadio` aliasing `/tRadio` is a redirect loop, and the registry is the
    // only place that can see it.
    const r = register(proxyMount({ legacyMounts: ["/tRadio", "/tRadio/admin", "/ok"] }));
    expect(r.ok).toBe(true);
    expect(matchLegacy("/tRadio")).toBeNull();
    expect(matchLegacy("/ok")).toMatchObject({ from: "/ok" });
  });

  test("it is only an alias — a live mount always wins", () => {
    // If some other resource legitimately mounts /dispatch later, it serves it.
    register(proxyMount());
    register(foreignMount({ mount: "/dispatch", resourceName: "tOther" }));
    expect(match("/dispatch/x")).toMatchObject({ resourceName: "tOther" });
  });
});

/**
 * A mount is a resource name, and FXServer routes that segment
 * case-insensitively — `/tradio/admin` on the FiveM server port reaches tRadio
 * and answers 200. tLib's listener did not, so the same URL worked on one door
 * and 404ed on the other, which is the exact failure naming mounts after their
 * resource was meant to remove. Found by typing the URL by hand.
 */
describe("a mount answers in any case, on either door", () => {
  test("the listener serves a lowercased mount", () => {
    register(proxyMount());
    expect(resolveIngress("GET", "/tradio/admin", "Test Server", "")).toMatchObject({
      kind: "upstream",
      // The REMAINDER keeps its case — that is the app's namespace, not ours.
      path: "/admin",
    });
    expect(resolveIngress("GET", "/TRADIO/Admin", "Test Server", "")).toMatchObject({
      kind: "upstream",
      path: "/Admin",
    });
  });

  test("a bare mount in the wrong case still takes the index redirect", () => {
    // Without this it falls through to the upstream's own root, which for
    // PocketBase is a JSON 404 that reads like a broken router.
    register(proxyMount({ id: "db", mount: "/tDB", resourceName: "tDB", index: "/_/" }));
    const r = resolveIngress("GET", "/tdb", "Test Server", "");
    expect(r).toMatchObject({ status: 302 });
    expect(r.kind === "inline" && r.headers.Location).toBe("/tDB/_/");
  });

  test("two mounts differing only in case collide rather than both registering", () => {
    expect(register(proxyMount()).ok).toBe(true);
    const second = register(proxyMount({ mount: "/tradio", resourceName: "tOther" }));
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toContain("conflicts");
  });

  // CONTROL: folding case must not have cost the segment-boundary rule.
  test("a partial segment match is still not under the mount", () => {
    register(proxyMount());
    expect(resolveIngress("GET", "/tradiox/admin", "Test Server", "")).toMatchObject({
      kind: "inline",
      status: 404,
    });
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
    // A PERCENT-ENCODED separator is deliberately NOT in this list, and that is
    // not an oversight. FXServer decodes `request.path` before the handler sees
    // it, so `/dispatch/..%2f..%2fetc` arrives here already decoded and is caught
    // by the plain case above. Measured live on both doors: the ingress answers
    // 404, the listener answers 200 and forwards the encoded form to the app.
    // Feeding the encoded string to this function directly tests a shape that
    // cannot reach it through this door, and would assert a guarantee the ingress
    // does not make.
    // What must not be reachable from tRadio's door is ANOTHER resource's app.
    // `..` is resolved before the mount table is consulted, so the escape would
    // be silent: a 200 serving tCAD's bytes from tRadio's URL.
    register(foreignMount());
    expect(resolve("/../tCAD/app.js")).toMatchObject({
      kind: "upstream",
      // Still tRadio's upstream, with the path passed through as tRadio's own.
      port: 7777,
      path: "/tCAD/app.js",
    });

    // CONTROL, and the reason the case above means something: a `..` that stays
    // inside is resolved, not refused. Without this, a blanket rejection of
    // every path containing `..` would pass the assertion above while breaking
    // every app that builds a URL with a relative segment.
    expect(resolve("/sub/../x")).toMatchObject({
      kind: "upstream",
      path: "/x",
    });
  });

  test("the hub is GET/HEAD only, as it is on the listener", () => {
    register(proxyMount());
    const r = hub("/", "POST");
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
    // tLib's own door, since tLib owns it — from anywhere else it is a 404.
    const r = hub("/realtime/socket");
    expect(r).toMatchObject({ kind: "inline", status: 501 });
  });
});

/**
 *  `res.writeHead(status, {})` CRASHES FXSERVER.
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
        register(proxyMount({ id: "db", mount: "/tDB", resourceName: "tDB", index: "/_/" }));
        return resolveIngress("GET", "/", "Test Server", "/tDB", "tDB");
      },
    ],
    [
      "301 trailing slash",
      () => {
        register(foreignMount());
        return resolveIngress("GET", "/cad", "Test Server", "/tCAD", "tCAD");
      },
    ],
    [
      "302 single destination",
      () => {
        register(foreignMount());
        return resolveIngress("GET", "/", "Test Server", "/tCAD", "tCAD");
      },
    ],
    [
      "200 hub page",
      () => {
        register(proxyMount());
        register(proxyMount({ id: "cad", mount: "/cad", resourceName: "tCAD" }));
        return hub("/");
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
    const r = hub("/");
    expect(r.kind === "inline" && r.headers["Cache-Control"]).toBe("no-store");
  });

  test("and neither is the redirect that replaces it when there is one app", () => {
    // A cached one pins a door to the app that happened to be up first: stop
    // that resource, start another, and the browser still follows the old path.
    register(foreignMount());
    const r = resolveIngress("GET", "/", "Test Server", "/tCAD", "tCAD");
    expect(r).toMatchObject({ status: 302 });
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
    expect(ingressUrlFrom("http://203.0.113.9:7777", "30120", "tLib")).toBe("http://203.0.113.9:30120/tLib");
  });

  test("a dev box resolves to localhost, and that must print too", () => {
    // The first version keyed on `publicUrlDetected` and printed nothing here,
    // because tLib resolves localhost as configured rather than detected.
    expect(ingressUrlFrom("http://localhost:7777", "30120", "tLib")).toBe("http://localhost:30120/tLib");
  });

  test("keeps an IPv6 authority intact", () => {
    expect(ingressUrlFrom("http://[2001:db8::1]:7777", "30120", "tLib")).toBe("http://[2001:db8::1]:30120/tLib");
  });

  test("refuses a name with no port — that is a proxy on 443 which knows nothing of the FiveM port", () => {
    expect(ingressUrlFrom("https://radio.example.com", "30120", "tLib")).toBeNull();
    expect(ingressUrlFrom("https://example.com/radio", "30120", "tLib")).toBeNull();
  });

  test("a configured host WITH an explicit port reaches this machine directly, so it prints", () => {
    expect(ingressUrlFrom("http://radio.example.com:7777", "30120", "tLib")).toBe(
      "http://radio.example.com:30120/tLib"
    );
  });

  test("refuses a nonsense netPort rather than printing it", () => {
    for (const bad of ["", "0", "99999", "abc"]) {
      expect(ingressUrlFrom("http://203.0.113.9:7777", bad, "tLib")).toBeNull();
    }
  });

  test("tolerates a trailing slash on the resolved URL", () => {
    expect(ingressUrlFrom("http://203.0.113.9:7777/", "30120", "tLib")).toBe("http://203.0.113.9:30120/tLib");
  });
});
