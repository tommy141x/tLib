// Integration tests: a real Router in front of a real upstream.
//
// No FiveM globals are touched here — Router/proxy/registry deliberately have
// no dependency on the runtime, which is what makes this possible.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { type Duplex, PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import type { BoundHttpConfig } from "./config";
import { clear, register } from "./registry";
import { Router } from "./router";

const cfg: BoundHttpConfig = {
  host: "127.0.0.1",
  port: 0, // replaced below
  publicUrlOverride: null,
  upstreamTimeoutMs: 2000,
  maxConnections: 64,
  portImplied: false,
};

let upstream: http.Server;
let upstreamPort: number;
/** TCP connections the upstream has accepted, for the socket-reuse assertion. */
let upstreamConnections = 0;
let router: Router;
let routerPort: number;
const routerLogs: string[] = [];

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
    if (at("/dies")) {
      // Headers and a first event, then the process behind the stream goes away.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: hello\ndata: 1\n\n");
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    if (at("/reset")) {
      req.socket.destroy();
      return;
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

  s.on("connection", () => {
    upstreamConnections += 1;
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
 * `Response.json()` is typed `Promise<unknown>`, so every `body.path` in here
 * was a type error nothing reported until `server/` got a typecheck.
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
    (_level, message) => {
      routerLogs.push(message);
    }
  );
  router.start();
  await Bun.sleep(120);
});

afterAll(async () => {
  router.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  clear();
  routerLogs.length = 0;
});

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

  test("every request tells the peer observer who knocked, and what with", async () => {
    const peers: unknown[][] = [];
    let done!: (url: string) => void;
    const listening = new Promise<string>((resolve) => {
      done = resolve;
    });
    const instance = new Router(
      { ...cfg, port: 0 },
      () => "Test",
      () => {},
      (state, url) => {
        if (state === "listening" && url) done(url);
      },
      (address, userAgent) => peers.push([address, userAgent])
    );
    try {
      instance.start();
      const url = await listening;
      await fetch(`${url}/`, { headers: { "user-agent": "probe/1" } });
      expect(peers).toHaveLength(1);
      expect(String(peers[0][0])).toMatch(/127\.0\.0\.1$/);
      expect(peers[0][1]).toBe("probe/1");
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

  // Guards against a removed `POST /` consent switch reappearing. POST must be
  // rejected, not accepted and ignored — that would leave a caller believing it
  // had set something.
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
    expect(routerLogs).toHaveLength(1);
    expect(routerLogs[0]).toContain("failed:");
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

  test("an upstream that dies mid-body ends the caller's response instead of hanging it", async () => {
    // `pipe` ends its destination only on a clean end. A resource restarting under an open
    // SSE stream closes without one, and the caller is then left holding a response nobody
    // is writing to: an EventSource never reconnects, because nothing told it the stream ended.
    mountProxy({ stripPrefix: true });
    const res = await get("/app/dies");
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: hello");

    const next = await Promise.race([
      reader.read().then(
        (r) => (r.done ? "ENDED" : "DATA"),
        () => "ERRORED"
      ),
      Bun.sleep(1500).then(() => "TIMEOUT"),
    ]);
    expect(["ENDED", "ERRORED"]).toContain(next);
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

  // The two cases below hand the router a socket directly. The windows they cover are a few
  // hundred microseconds wide on a real connection, which is exactly why nothing saw them.
  const upgrade = (path: string): PassThrough => {
    const socket = new PassThrough();
    const req = {
      url: path,
      method: "GET",
      headers: { upgrade: "websocket", host: "hub.example.com" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    (
      router as unknown as {
        onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
      }
    ).onUpgrade(req, socket, Buffer.alloc(0));
    return socket;
  };

  test("a caller that resets under a refused upgrade is not an unhandled error", () => {
    // Node's HTTP server removes its own 'error' listener before emitting 'upgrade', and an
    // EventEmitter with none THROWS on 'error' -- out of the socket's own I/O callback.
    const socket = upgrade("/nothing-is-mounted-here");
    expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });

  test("a caller that leaves mid-handshake takes the upstream attempt with it, quietly", async () => {
    // An upstream that accepts the connection and never answers the upgrade.
    let held: net.Socket | null = null;
    let released = false;
    const holder = net.createServer((connection) => {
      held = connection;
      // Drained, or the unread handshake sits in the buffer and this side never reaches
      // the end of the stream to notice the other one has gone.
      connection.resume();
      connection.on("close", () => {
        released = true;
      });
      connection.on("error", () => {});
    });
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    try {
      mountProxy({ upstream: { host: "127.0.0.1", port: (holder.address() as AddressInfo).port } });
      const socket = upgrade("/app/ws");
      for (let i = 0; i < 50 && held === null; i++) await Bun.sleep(10);
      expect(held).not.toBeNull();

      socket.destroy();
      for (let i = 0; i < 50 && !released; i++) await Bun.sleep(10);

      // Well inside upstreamTimeoutMs (2000): the attempt ended because the caller did,
      // not because the timeout eventually noticed.
      expect(released).toBe(true);
      // And nobody is told the upstream failed -- it did not.
      await Bun.sleep(50);
      expect(routerLogs).toEqual([]);
    } finally {
      // Not awaited: `close` calls back only once every connection has gone, so a failed
      // assertion above would be reported as this test timing out instead.
      (held as net.Socket | null)?.destroy();
      holder.close();
    }
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

describe("teardown is not a fault", () => {
  test("a caller that hangs up mid-response is neither logged nor answered", async () => {
    const logs: string[] = [];
    let ready!: (url: string) => void;
    const listening = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const instance = new Router(
      { ...cfg, port: 0 },
      () => "Test",
      (level, msg) => {
        logs.push(`${level}: ${msg}`);
      },
      (state, url) => {
        if (state === "listening" && url) ready(url);
      }
    );
    try {
      instance.start();
      const url = await listening;
      mountProxy();

      const abort = new AbortController();
      const res = await fetch(`${url}/app/sse`, { signal: abort.signal });
      expect(res.status).toBe(200);
      abort.abort();
      await Bun.sleep(200);

      expect(logs).toEqual([]);
      // And the listener is still serving, which an unhandled 'error' would not be.
      expect((await fetch(`${url}/app`)).status).toBe(200);
    } finally {
      instance.stop();
    }
  });

  test("an upstream that resets while the caller still waits is a warning and a 502", async () => {
    // The other half of the case above: the silence is only for callers that left. A reset
    // the caller is waiting on is a real fault and has to stay audible.
    const logs: string[] = [];
    let ready!: (url: string) => void;
    const listening = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const instance = new Router(
      { ...cfg, port: 0 },
      () => "Test",
      (level, msg) => {
        logs.push(`${level}: ${msg}`);
      },
      (state, url) => {
        if (state === "listening" && url) ready(url);
      }
    );
    try {
      instance.start();
      const url = await listening;
      mountProxy();
      const res = await fetch(`${url}/app/reset`);
      expect(res.status).toBe(502);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^warn: .*failed: ECONNRESET$/);
    } finally {
      instance.stop();
    }
  });

  test("upstream sockets are not reused, so an idle close cannot race a write", async () => {
    // Two completed requests must create two upstream connections.
    mountProxy();
    const before = upstreamConnections;
    expect((await get("/app/one")).status).toBe(200);
    expect((await get("/app/two")).status).toBe(200);
    expect(upstreamConnections - before).toBe(2);
  });
});
