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

describe("hub", () => {
  test("renders an empty index when nothing is mounted", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No web resources are registered");
  });

  test("redirects to the only listed mount rather than showing a chooser", async () => {
    mountProxy();
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/");
  });

  test("lists mounts when there is more than one", async () => {
    mountProxy();
    mountProxy({ mount: "/two", id: "two", title: "Second" });
    const body = await (await get("/")).text();
    expect(body).toContain("App");
    expect(body).toContain("Second");
  });

  test("omits unlisted mounts but still routes them", async () => {
    mountProxy();
    mountProxy({ mount: "/hidden", id: "hidden", title: "Hidden", listed: false });

    const body = await (await get("/")).text();
    expect(body).not.toContain("Hidden");
    expect((await get("/hidden/x")).status).toBe(200);
  });

  test("404s an unmounted path", async () => {
    mountProxy();
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("proxying", () => {
  test("forwards the full path when not stripping", async () => {
    mountProxy();
    const body = await (await get("/app/deep/thing")).json();
    expect(body.path).toBe("/app/deep/thing");
  });

  test("strips the mount when stripping", async () => {
    mountProxy({ stripPrefix: true });
    const body = await (await get("/app/deep/thing")).json();
    expect(body.path).toBe("/deep/thing");
    expect(body.prefix).toBe("/app");
  });

  test("preserves the query string", async () => {
    mountProxy();
    const body = await (await get("/app/x?a=1&b=2")).json();
    expect(body.search).toBe("?a=1&b=2");
  });

  test("sets X-Forwarded-Proto and overwrites a spoofed X-Forwarded-For", async () => {
    mountProxy();
    const body = await (await get("/app/x", { "x-forwarded-for": "9.9.9.9" })).json();
    expect(body.proto).toBe("http");
    expect(body.xff).not.toBe("9.9.9.9");
  });

  test("drops a spoofed X-Real-IP", async () => {
    mountProxy();
    const body = await (await get("/app/x", { "x-real-ip": "9.9.9.9" })).json();
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
    const body = await (await get("/app/../app/x")).json();
    expect(body.path).toBe("/x");
  });

  test("encoded traversal is normalized before matching", async () => {
    mountProxy({ stripPrefix: true });
    const body = await (await get("/app/%2e%2e/app/deep")).json();
    expect(body.path).toBe("/deep");
  });
});
