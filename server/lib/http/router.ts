// The single externally-bound listener: one port for the whole server, `/` is
// the hub, every other path belongs to a registered mount.
//
// Mount selection goes through the registry and nothing else. Neither the Host
// header nor an absolute-form request target influences which upstream is
// chosen — that is what separates a router from an open relay.
//
// `Router`, `proxy` and `registry` TOUCH NO FiveM GLOBAL, and that property
// is load-bearing: it is the whole reason `router.test.ts` can stand a real
// listener in front of a real upstream. Anything here that needs the runtime
// gets injected by `index.ts` rather than imported. A `TelemetryBridge` was the
// one such injection; it went with the diagnostics panel (see `hub.ts`), so the
// constructor is back to config, name, log and the state callback.

import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import type { HttpConfig } from "./config";
import { badGatewayPage, notFoundPage, renderIndex } from "./hub";
import { forwardPath, normalizePath } from "./paths";
import { type Log, proxyRequest, proxyUpgrade } from "./proxy";
import { hubDestinations, list, match } from "./registry";
import type { ListenerState } from "./status";

export class Router {
  private server: http.Server | null = null;

  constructor(
    private readonly cfg: HttpConfig,
    private readonly serverName: () => string,
    private readonly log: Log,
    private readonly onState: (
      state: ListenerState,
      localUrl: string | null,
      error: string | null
    ) => void = () => {}
  ) {}

  start(): void {
    if (this.server) return;

    const server = http.createServer();
    server.maxConnections = this.cfg.maxConnections;

    server.on("request", (req, res) => this.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (this.server !== server) return;
      this.onState("failed", null, err.message);
      if (err.code === "EADDRINUSE") {
        this.log(
          "error",
          `port ${this.cfg.port} is already in use — the hub and every resource ` +
            `behind it will be unreachable. Set 'tlib_http_port' to a free port.`
        );
      } else {
        this.log("error", `listener error: ${err.message}`);
      }
    });

    server.on("listening", () => {
      if (this.server !== server) {
        server.close();
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        this.onState("failed", null, "Listener address unavailable");
        return;
      }
      const host =
        address.address === "0.0.0.0"
          ? "127.0.0.1"
          : address.address === "::"
            ? "::1"
            : address.address;
      const localUrl = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
      // No `listening on <addr>:<port>` line. The banner's `Hub:` row carries
      // the URL an operator actually uses, and this said the same thing one
      // line earlier in a form nobody can paste into a browser. A bind FAILURE
      // still throws and is still reported -- this was only the success case.
      this.onState("listening", localUrl, null);
    });

    this.server = server;
    this.onState("starting", null, null);
    try {
      server.listen(this.cfg.port, this.cfg.host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onState("failed", null, message);
      this.log("error", `listener error: ${message}`);
    }
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    this.onState("stopped", null, null);
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const raw = req.url ?? "/";

    // Absolute-form request target (`GET http://host/ HTTP/1.1`), legal only for
    // a forward proxy — which this explicitly is not.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      this.send(res, 400, "Bad Request");
      return;
    }

    const qIndex = raw.indexOf("?");
    const search = qIndex === -1 ? "" : raw.slice(qIndex);
    const pathname = normalizePath(raw);

    if (pathname === null) {
      this.send(res, 400, "Bad Request");
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");

    if (pathname === "/") {
      this.serveHub(req, res);
      return;
    }

    const mount = match(pathname);
    if (!mount) {
      this.sendHtml(res, 404, notFoundPage(pathname));
      return;
    }

    // An app whose entry point is not its root declares where to go: PocketBase
    // serves nothing at "/" and its admin UI at "/_/", so the bare mount would
    // otherwise answer with a JSON 404 that reads like a broken router. 302 and
    // not 301 — the entry point is the app's to change, and a cached permanent
    // redirect would outlive the decision.
    if (mount.index && (pathname === mount.mount || pathname === `${mount.mount}/`)) {
      res.writeHead(302, { location: `${mount.mount}${mount.index}${search}` });
      res.end();
      return;
    }

    // `/db` and `/db/` are the same resource, but only the second lets a browser
    // resolve the app's relative URLs. Stripping mounts only: an un-stripped
    // upstream sees the path verbatim and makes this call itself.
    if (pathname === mount.mount && mount.kind === "proxy" && mount.stripPrefix) {
      res.writeHead(301, { location: `${mount.mount}/${search}` });
      res.end();
      return;
    }

    if (mount.kind === "inprocess") {
      if (!mount.onRequest) {
        this.sendHtml(res, 502, badGatewayPage(mount));
        return;
      }
      mount.onRequest(req, res, forwardPath(pathname, mount.mount, true));
      return;
    }

    proxyRequest(
      req,
      res,
      mount,
      forwardPath(pathname, mount.mount, mount.stripPrefix),
      search,
      this.cfg,
      this.log
    );
  }

  /**
   * The front door counts visible destinations, independently of exposure.
   *
   * GET/HEAD ONLY, AND NOTHING IS TO BE ADDED. This listener binds `0.0.0.0`
   * by default and is unauthenticated by design (`hub.ts`), and there is no auth
   * primitive in this tree to gate a writer with. A `POST /` consent switch
   * lived here briefly and was removed for exactly that reason; the 405 below is
   * what keeps it gone.
   */
  private serveHub(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const mounts = list();
    const destinations = hubDestinations(mounts);
    // Visibility changes on a resource restart, so the single-app redirect must
    // never be cached. Only canonical registry paths reach here.
    res.setHeader("Cache-Control", "no-store");
    if (destinations.length === 1) {
      res.writeHead(302, { location: destinations[0].path });
      res.end();
      return;
    }
    const html = renderIndex(mounts, this.serverName());
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    res.end(req.method === "HEAD" ? undefined : html);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const raw = req.url ?? "/";
    const qIndex = raw.indexOf("?");
    const search = qIndex === -1 ? "" : raw.slice(qIndex);
    const pathname = normalizePath(raw);

    if (pathname === null) {
      socket.destroy();
      return;
    }

    const mount = match(pathname);
    if (!mount) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }

    if (mount.kind === "inprocess") {
      if (!mount.onUpgrade) {
        socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
        return;
      }
      mount.onUpgrade(req, socket, head);
      return;
    }

    if (!mount.websocket) {
      socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
      return;
    }

    proxyUpgrade(
      req,
      socket,
      head,
      mount,
      forwardPath(pathname, mount.mount, mount.stripPrefix),
      search,
      this.cfg,
      this.log
    );
  }

  private send(res: ServerResponse, code: number, text: string): void {
    res.writeHead(code, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private sendHtml(res: ServerResponse, code: number, html: string): void {
    res.writeHead(code, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
  }
}
