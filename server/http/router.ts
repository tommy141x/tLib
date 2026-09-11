// router.ts — the single externally-bound listener.
//
// One port for the whole server. `/` is the hub; every other path belongs to a
// registered mount. Mount selection happens ONLY through the registry — the
// Host header and absolute-form request targets never influence which upstream
// is chosen, because that is what separates a router from an open relay.

import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import type { HttpConfig } from "./config";
import { badGatewayPage, notFoundPage, renderIndex } from "./hub";
import { forwardPath, normalizePath } from "./paths";
import { type Log, proxyRequest, proxyUpgrade } from "./proxy";
import { listed, match } from "./registry";

export class Router {
  private server: http.Server | null = null;

  constructor(
    private readonly cfg: HttpConfig,
    private readonly serverName: () => string,
    private readonly log: Log
  ) {}

  start(): void {
    if (this.server) return;

    const server = http.createServer();
    server.maxConnections = this.cfg.maxConnections;

    server.on("request", (req, res) => this.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));

    server.on("error", (err: NodeJS.ErrnoException) => {
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
      this.log("info", `listening on ${this.cfg.host}:${this.cfg.port}`);
    });

    server.listen(this.cfg.port, this.cfg.host);
    this.server = server;
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  // ---- request path ----

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const raw = req.url ?? "/";

    // Absolute-form request target (`GET http://host/ HTTP/1.1`). Legal only
    // for a forward proxy, which we are explicitly not.
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
      this.serveHub(res);
      return;
    }

    const mount = match(pathname);
    if (!mount) {
      this.sendHtml(res, 404, notFoundPage(pathname));
      return;
    }

    // An app whose entry point is not its root declares where to go — e.g.
    // PocketBase, which serves nothing at "/" and its admin UI at "/_/", so
    // visiting the bare mount otherwise returns a JSON 404 that reads like the
    // router is broken. 302, not 301: the entry point is the app's to change,
    // and a cached permanent redirect would outlive the decision.
    if (mount.index && (pathname === mount.mount || pathname === `${mount.mount}/`)) {
      res.writeHead(302, { location: `${mount.mount}${mount.index}${search}` });
      res.end();
      return;
    }

    // `/db` and `/db/` are the same resource, but only the second lets a
    // browser resolve the app's relative URLs correctly. Redirect rather than
    // serve the index from a path the page's own links are relative to.
    // Only when we strip: an un-stripped upstream sees the path verbatim and
    // gets to make this call itself.
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
   * The hub index — or a redirect straight to the only thing there is.
   * A chooser with one choice is friction, not navigation.
   */
  private serveHub(res: ServerResponse): void {
    const visible = listed();

    if (visible.length === 1) {
      res.writeHead(302, { location: `${visible[0].mount}/` });
      res.end();
      return;
    }

    this.sendHtml(res, 200, renderIndex(visible, this.serverName()));
  }

  // ---- upgrade path ----

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

  // ---- helpers ----

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
