// Integration tests: a real Router in front of a real upstream.
//
// No FiveM globals are touched here — Router/proxy/registry deliberately have
// no dependency on the runtime, which is what makes this possible.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { HttpConfig } from "./config";
import { clear, register } from "./registry";
import { Router } from "./router";

const cfg: HttpConfig = {
  host: "127.0.0.1",
  port: 0, // replaced below
  publicUrlOverride: null,
  upstreamTimeoutMs: 2000,
  maxConnections: 64,
};

let upstream: http.Server;
let upstreamPort: number;
let router: Router;
let routerPort: number;

/** Upstream stand-in: echoes what it was asked for, plus the fixtures we need. */
function buildUpstream(): http.Server {
  const s = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");

    // Suffix matching so the same fixture serves both stripPrefix modes:
    // unstripped, the upstream sees /app/redirect rather than /redirect.
    const at = (p: string) => url.pathname === p || url.pathname.endsWith(p);

    if (at("/cookie")) {
      res.writeHead(200, {
        "set-cookie": ["sess=1; Path=/; HttpOnly", "admin=2; Path=/admin"],
        "content-type": "text/plain",
      });
      return res.end("ok");
    }
    if (at("/redirect")) {
      res.writeHead(302, { location: "/landed" });
      return res.end();
    }
    if (at("/sse")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: hello\ndata: 1\n\n");
      return; // deliberately left open
    }
    if (at("/big")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(1024 * 512, 0x41));
    }

    // Default: report back exactly what the upstream saw.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        path: url.pathname,
        search: url.search,
        xff: req.headers["x-forwarded-for"] ?? null,
        prefix: req.headers["x-forwarded-prefix"] ?? null,
        proto: req.headers["x-forwarded-proto"] ?? null,
        realIp: req.headers["x-real-ip"] ?? null,
        connection: req.headers.connection ?? null,
      })
    );
  });

  const wss = new WebSocketServer({ server: s, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo:${m}`)));
  return s;
}

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${routerPort}${path}`, { redirect: "manual", headers });

/** What `buildUpstream`'s echo handler reports back about the proxied request. */
interface Echo {
  path: string;
  prefix: string;
  search: string;
  proto: string;
  xff: string;
  /** Null when the router correctly dropped a spoofed `X-Real-IP`. */
  realIp: string | null;
}

/**
 * `Response.json()` is typed `Promise<unknown>`, so every `body.path` in here was
 * a type error that nothing reported — `server/` had no typecheck until now. One
 * assertion of the upstream's contract beats nine casts at the call sites.
 */
const echo = async (path: string, headers: Record<string, string> = {}): Promise<Echo> =>
  (await get(path, headers)).json() as Promise<Echo>;

beforeAll(async () => {
  upstream = buildUpstream();
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  // Bind the router on an ephemeral port by listening first.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  routerPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  router = new Router(
    { ...cfg, port: routerPort },
    () => "Test Server",
    () => {}
  );
  router.start();
  await Bun.sleep(120);
});

afterAll(async () => {
  router.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => clear());

const mountProxy = (over: Record<string, unknown> = {}) =>
  register({
    kind: "proxy",
    id: "app",
    mount: "/app",
    title: "App",
    listed: true,
    resourceName: "tTest",
    upstream: { host: "127.0.0.1", port: upstreamPort },
    stripPrefix: false,
    websocket: true,
    ...over,
  } as Parameters<typeof register>[0]);

describe("listener readiness", () => {
  test("reports the actual ephemeral local endpoint and clears it on stop", async () => {
    const changes: Array<{ state: string; url: string | null }> = [];
    let done!: (url: string) => void;
    const listening = new Promise<string>((resolve) => {
      done = resolve;
    });
    const instance = new Router(
      { ...cfg, port: 0 },
      () => "Test",
      () => {},
      (state, url) => {
        changes.push({ state, url });
        if (state === "listening" && url) done(url);
      }
    );
    try {
      instance.start();
      const url = await listening;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(url).not.toEndWith(":0");
      expect((await fetch(`${url}/`)).status).toBe(200);
      instance.stop();
      expect(changes.at(-1)).toEqual({ state: "stopped", url: null });
    } finally {
      instance.stop();
    }
  });

  test("occupied port reports failed rather than ready", async () => {
    let done!: (value: { state: string; url: string | null; error: string | null }) => void;
    const failed = new Promise<{ state: string; url: string | null; error: string | null }>(
      (resolve) => {
        done = resolve;
      }
    );
    const instance = new Router(
      { ...cfg, port: upstreamPort },
      () => "Test",
      () => {},
      (state, url, error) => {
        if (state === "failed" || state === "listening") done({ state, url, error });
      }
    );
    try {
      instance.start();
      const result = await failed;
      expect(result.state).toBe("failed");
      expect(result.url).toBeNull();
      expect(result.error).toBeTruthy();
    } finally {
      instance.stop();
    }
  });
});

describe("hub", () => {
  test("renders an empty index when nothing is mounted", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No destinations are listed");
  });

  test("redirects to the only visible destination without caching the decision", async () => {
    mountProxy();
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  test("renders the card's icon, description and accent", async () => {
    mountProxy({ mount: "/two", id: "two" });
    mountProxy({
      icon: "database",
      description: "The server's data",
      accent: "#4F8EF7",
    });
    const body = await (await get("/")).text();
    expect(body).toContain("--accent:#4f8ef7");
    expect(body).toContain("The server&#39;s data");
    expect(body).toContain("<svg");
  });

  test("falls back to the destination path when no description is given", async () => {
    mountProxy();
    mountProxy({ mount: "/two", id: "two" });
    const body = await (await get("/")).text();
    expect(body).toContain('class="path">/app/<');
  });

  test("drops presentation a resource got wrong without losing the card", async () => {
    mountProxy({ mount: "/two", id: "two" });
    mountProxy({ icon: "not-a-real-icon", accent: "red; background:url(x)" });
    const body = await (await get("/")).text();
    expect(body).toContain('href="/app/"');
    expect(body).not.toContain("background:url");
    // No style attribute at all — the card falls back to the sheet's default.
    expect(body).not.toContain('<a class="card" href="/app/" style=');
  });

  test("lists mounts when there is more than one", async () => {
    mountProxy();
    mountProxy({ mount: "/two", id: "two", title: "Second" });
    const body = await (await get("/")).text();
    expect(body).toContain("App");
    expect(body).toContain("Second");
  });

  test("omits unlisted mounts but still routes them", async () => {
    mountProxy({ mount: "/two", id: "two" });
    mountProxy();
    mountProxy({ mount: "/hidden", id: "hidden", title: "Hidden", listed: false });

    const body = await (await get("/")).text();
    expect(body).not.toContain("Hidden");
    expect((await get("/hidden/x")).status).toBe(200);
  });

  test("an independently listed admin is the only destination even with its parent hidden", async () => {
    mountProxy({
      mount: "/dispatch",
      listed: false,
      hubLinks: [{ id: "admin", path: "/admin", title: "Radio Admin", listed: true }],
    });
    const res = await get("/?next=https://evil.example");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dispatch/admin");
    expect((await get("/dispatch/private-api")).status).toBe(200);
  });

  test("Dispatch and Radio Admin appear as sibling cards from one proxy mount", async () => {
    mountProxy({
      mount: "/dispatch",
      title: "Dispatch",
      hubLinks: [{ id: "admin", path: "/admin", title: "Radio Admin", listed: true }],
    });
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("2 destinations available");
    expect(html).toContain('href="/dispatch/"');
    expect(html).toContain('href="/dispatch/admin"');
    expect(html).toContain("Radio Admin");
  });

  test("all hidden gives the same empty state while direct URLs still work", async () => {
    mountProxy({ listed: false, hubLinks: [{ id: "admin", path: "/admin", listed: false }] });
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No destinations are listed");
    expect((await get("/app/admin")).status).toBe(200);
  });

  test("unsafe child links never become root redirects", async () => {
    mountProxy({
      listed: false,
      hubLinks: [
        { id: "external", path: "//evil.example" },
        { id: "encoded", path: "/%2e%2e/other" },
        { id: "escape", path: "/../other" },
      ],
    });
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("duplicate destinations still count as one", async () => {
    mountProxy({ hubLinks: [{ id: "alias", path: "/" }] });
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
  });

  test("HEAD matches GET status and headers without a body for zero, one, and many", async () => {
    for (const count of [0, 1, 2]) {
      clear();
      if (count >= 1) mountProxy();
      if (count === 2) mountProxy({ mount: "/two", id: "two" });
      const normal = await get("/");
      const head = await fetch(`http://127.0.0.1:${routerPort}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(head.status).toBe(normal.status);
      expect(head.headers.get("location")).toBe(normal.headers.get("location"));
      expect(head.headers.get("content-length")).toBe(normal.headers.get("content-length"));
      expect(await head.text()).toBe("");
      await normal.text();
    }
  });

  // THE PERMANENT GUARD, router half. A `POST /` consent switch lived here
  // briefly; this listener binds `0.0.0.0` by default and its index is public
  // and unauthenticated by design, with no auth primitive in this tree to gate a
  // writer with, so it was removed. POST is REJECTED — not accepted and ignored,
  // which would leave a caller believing it had set something. And the original
  // promise is unchanged: a non-navigation method is never redirected into an
  // app, single destination or not.
  test("non-navigation methods at the hub are rejected, not redirected into an app", async () => {
    mountProxy();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`http://127.0.0.1:${routerPort}/`, {
        method,
        redirect: "manual",
        ...(method === "POST" ? { body: "consent=on" } : {}),
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("404s an unmounted path", async () => {
    mountProxy();
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("proxying", () => {
  test("forwards the full path when not stripping", async () => {
    mountProxy();
    const body = await echo("/app/deep/thing");
    expect(body.path).toBe("/app/deep/thing");
  });

  test("strips the mount when stripping", async () => {
    mountProxy({ stripPrefix: true });
    const body = await echo("/app/deep/thing");
    expect(body.path).toBe("/deep/thing");
    expect(body.prefix).toBe("/app");
  });

  test("preserves the query string", async () => {
    mountProxy();
    const body = await echo("/app/x?a=1&b=2");
    expect(body.search).toBe("?a=1&b=2");
  });

  test("sets X-Forwarded-Proto and overwrites a spoofed X-Forwarded-For", async () => {
    mountProxy();
    const body = await echo("/app/x", { "x-forwarded-for": "9.9.9.9" });
    expect(body.proto).toBe("http");
    expect(body.xff).not.toBe("9.9.9.9");
  });

  test("drops a spoofed X-Real-IP", async () => {
    mountProxy();
    const body = await echo("/app/x", { "x-real-ip": "9.9.9.9" });
    expect(body.realIp).toBeNull();
  });

  test("streams a large body intact", async () => {
    mountProxy();
    const buf = await (await get("/app/big")).arrayBuffer();
    expect(buf.byteLength).toBe(1024 * 512);
  });

  test("502s when the upstream is registered but not listening", async () => {
    mountProxy({ upstream: { host: "127.0.0.1", port: 1 } });
    const res = await get("/app/x");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not responding");
  });
});

describe("rewriting under stripPrefix", () => {
  test("re-anchors Set-Cookie paths", async () => {
    mountProxy({ stripPrefix: true });
    const raw = (await get("/app/cookie")).headers.getSetCookie();
    expect(raw.some((c) => c.includes("Path=/app/"))).toBe(true);
    expect(raw.some((c) => c.includes("Path=/app/admin"))).toBe(true);
  });

  test("re-anchors a redirect Location", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/landed");
  });

  test("leaves Location alone when not stripping", async () => {
    mountProxy({ stripPrefix: false });
    expect((await get("/app/redirect")).headers.get("location")).toBe("/landed");
  });
});

describe("streaming", () => {
  test("SSE reaches the client without being buffered", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app/sse");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const chunk = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      Bun.sleep(1500).then(() => "TIMEOUT"),
    ]);
    expect(chunk).toContain("event: hello");
    await reader.cancel();
  });
});

describe("websocket upgrade", () => {
  const wsEcho = (path: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${routerPort}${path}`);
      const t = setTimeout(() => {
        resolve("TIMEOUT");
        ws.close();
      }, 3000);
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (e) => {
        clearTimeout(t);
        resolve(String(e.data));
        ws.close();
      };
      ws.onerror = () => {
        clearTimeout(t);
        resolve("ERROR");
      };
    });

  test("forwards an upgrade to a proxy mount", async () => {
    mountProxy({ stripPrefix: true });
    expect(await wsEcho("/app/ws")).toBe("echo:hi");
  });

  test("dispatches an upgrade to an in-process mount", async () => {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`rt:${m}`)));
    register({
      kind: "inprocess",
      id: "rt",
      mount: "/rt",
      title: "Realtime",
      listed: false,
      resourceName: "tLib",
      onUpgrade: (req, socket, head) =>
        wss.handleUpgrade(req as never, socket as never, head as never, (ws) =>
          wss.emit("connection", ws, req)
        ),
    });
    expect(await wsEcho("/rt")).toBe("rt:hi");
    wss.close();
  });

  test("refuses an upgrade on a mount that did not opt into websockets", async () => {
    mountProxy({ websocket: false });
    expect(await wsEcho("/app/ws")).toBe("ERROR");
  });
});

describe("security", () => {
  test("rejects an absolute-form request target — not a forward proxy", async () => {
    mountProxy();
    // Raw socket, because fetch() will not emit an absolute-form target.
    const status = await new Promise<string>((resolve) => {
      const sock = require("node:net").connect(routerPort, "127.0.0.1", () => {
        sock.write("GET http://evil.example.com/ HTTP/1.1\r\nHost: evil.example.com\r\n\r\n");
      });
      sock.on("data", (d: Buffer) => {
        resolve(d.toString().split("\r\n")[0]);
        sock.destroy();
      });
    });
    expect(status).toContain("400");
  });

  test("the Host header cannot select an upstream", async () => {
    mountProxy();
    const res = await get("/nope", { host: "app" });
    expect(res.status).toBe(404);
  });

  test("traversal out of a mount does not reach another mount", async () => {
    mountProxy({ stripPrefix: true });
    mountProxy({ mount: "/other", id: "other" });
    // /app/../other/x normalizes to /other/x and is routed as such — never
    // forwarded to /app's upstream with a traversal still in it.
    const body = await echo("/app/../app/x");
    expect(body.path).toBe("/x");
  });

  test("encoded traversal is normalized before matching", async () => {
    mountProxy({ stripPrefix: true });
    const body = await echo("/app/%2e%2e/app/deep");
    expect(body.path).toBe("/deep");
  });
});

describe("trailing slash", () => {
  test("forwards the client's trailing slash verbatim", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app/sub/");
    expect(await res.json()).toMatchObject({ path: "/sub/" });
  });

  test("does not invent a trailing slash", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app/sub");
    expect(await res.json()).toMatchObject({ path: "/sub" });
  });

  // Without this the upstream serves its index at /app, and every relative URL
  // on that page resolves against / instead of /app/.
  test("redirects the bare mount to the mount root when stripping", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/app/");
  });

  test("carries the query string through that redirect", async () => {
    mountProxy({ stripPrefix: true });
    const res = await get("/app?a=1");
    expect(res.headers.get("location")).toBe("/app/?a=1");
  });

  // Not stripping means the upstream sees the path untouched and owns the
  // decision, so the router must stay out of it.
  test("leaves the bare mount alone when not stripping", async () => {
    mountProxy({ stripPrefix: false });
    const res = await get("/app");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "/app" });
  });
});

// An app whose entry point is not its root — PocketBase serves nothing at "/"
// and its admin UI at "/_/", so without this the bare mount returns the
// upstream's own 404 and reads like a broken router.
describe("index path", () => {
  test("redirects the bare mount to the declared entry point", async () => {
    mountProxy({ stripPrefix: true, index: "/_/" });
    const res = await get("/app");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/_/");
  });

  test("redirects the mount root too, which the hub links to", async () => {
    mountProxy({ stripPrefix: true, index: "/_/" });
    const res = await get("/app/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/_/");
  });

  test("carries the query string", async () => {
    mountProxy({ stripPrefix: true, index: "/_/" });
    const res = await get("/app/?a=1&b=2");
    expect(res.headers.get("location")).toBe("/app/_/?a=1&b=2");
  });

  test("does not intercept anything below the mount", async () => {
    mountProxy({ stripPrefix: true, index: "/_/" });
    expect((await get("/app/api/health")).status).toBe(200);
  });

  test("applies without stripPrefix, where there is no slash redirect to hide it", async () => {
    mountProxy({ index: "/_/" });
    expect((await get("/app")).headers.get("location")).toBe("/app/_/");
  });

  // Without an index the bare mount keeps the 301-to-slash behaviour.
  test("is inert when no index was declared", async () => {
    mountProxy({ stripPrefix: true });
    expect((await get("/app")).status).toBe(301);
    expect((await get("/app/")).status).toBe(200);
  });
});
