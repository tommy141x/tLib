// Forwards a matched request or upgrade to its loopback upstream.
//
// Everything streams. tRadio serves imbe_dvm.wasm, whole layouts/** skin trees
// and an updater .exe through here and tDB serves an SSE stream, so buffering a
// response would break both size and latency.

import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import type { HttpConfig } from "./config";
import { buildForwardHeaders, rewriteForMount, sanitizeResponseHeaders } from "./headers";
import { badGatewayPage } from "./hub";
import type { Mount, ProxyMount } from "./registry";

export type Log = (level: "info" | "warn" | "error", msg: string) => void;

type ProxyTarget = Mount & ProxyMount;

function forwardContext(req: IncomingMessage, mount: ProxyTarget) {
  return {
    remoteAddress: req.socket.remoteAddress ?? "",
    host: String(req.headers.host ?? ""),
    prefix: mount.stripPrefix ? mount.mount : null,
  };
}

/** `forwarded` is the already-computed upstream path. */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mount: ProxyTarget,
  forwarded: string,
  search: string,
  cfg: HttpConfig,
  log: Log
): void {
  const headers = buildForwardHeaders(req.headers, forwardContext(req, mount));

  const upstream = http.request({
    host: mount.upstream.host,
    port: mount.upstream.port,
    method: req.method,
    path: forwarded + search,
    headers,
  });

  // Guards the connect and response-header phase only, cleared once headers are
  // through: an SSE stream or a large download stays open far longer than any
  // sane header timeout.
  upstream.setTimeout(cfg.upstreamTimeoutMs, () => {
    upstream.destroy(new Error("upstream timeout"));
  });

  upstream.on("response", (upRes) => {
    upstream.setTimeout(0);

    let outHeaders = sanitizeResponseHeaders(upRes.headers);
    if (mount.stripPrefix) outHeaders = rewriteForMount(outHeaders, mount.mount);

    res.writeHead(upRes.statusCode ?? 502, outHeaders);
    upRes.pipe(res);
  });

  upstream.on("error", (err: NodeJS.ErrnoException) => {
    log("warn", `${mount.mount} -> ${mount.upstream.port} failed: ${err.code ?? err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = badGatewayPage(mount);
    res.writeHead(502, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  res.on("close", () => upstream.destroy());

  req.pipe(upstream);
}

/**
 * Without this, Socket.IO silently falls back to HTTP long-polling and *looks*
 * like it is working, while in-game audio latency quietly degrades.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  mount: ProxyTarget,
  forwarded: string,
  search: string,
  cfg: HttpConfig,
  log: Log
): void {
  const headers = buildForwardHeaders(req.headers, forwardContext(req, mount));

  // buildForwardHeaders drops connection/upgrade as hop-by-hop, which is right
  // for a normal request and wrong here — the handshake IS the hop. Put back
  // exactly the two the upstream needs to recognise an upgrade.
  headers.connection = "Upgrade";
  headers.upgrade = String(req.headers.upgrade ?? "websocket");

  const upstream = http.request({
    host: mount.upstream.host,
    port: mount.upstream.port,
    method: req.method,
    path: forwarded + search,
    headers,
  });

  upstream.setTimeout(cfg.upstreamTimeoutMs, () => {
    upstream.destroy(new Error("upstream upgrade timeout"));
  });

  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    upstream.setTimeout(0);

    const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
    const headerLines = Object.entries(sanitizeUpgradeHeaders(upRes.headers))
      .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join("\r\n") : `${k}: ${v}`))
      .join("\r\n");

    socket.write(`${statusLine}${headerLines}\r\n\r\n`);
    if (upHead?.length) socket.unshift(upHead);
    if (head?.length) upSocket.write(head);

    const bail = () => {
      socket.destroy();
      upSocket.destroy();
    };
    socket.on("error", bail);
    upSocket.on("error", bail);

    // Both are net.Sockets at runtime even though the upgrade signature types
    // the client side as a bare Duplex. Nagle batching adds latency to the small
    // frames that dominate a realtime or voice channel.
    noDelay(socket);
    noDelay(upSocket);

    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  // Upstream answered with a normal response instead of 101 — relay it so the
  // client sees the real refusal rather than a bare socket close.
  upstream.on("response", (upRes) => {
    upstream.setTimeout(0);
    socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
    upRes.pipe(socket);
  });

  upstream.on("error", (err: NodeJS.ErrnoException) => {
    log(
      "warn",
      `${mount.mount} upgrade -> ${mount.upstream.port} failed: ${err.code ?? err.message}`
    );
    socket.destroy();
  });

  upstream.end();
}

function noDelay(s: Duplex): void {
  (s as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
}

/**
 * `connection` and `upgrade` must survive on a 101 — they are the handshake.
 * Everything else hop-by-hop still goes.
 */
function sanitizeUpgradeHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower === "transfer-encoding" || lower === "keep-alive") continue;
    out[k] = v;
  }
  return out;
}
