// Pure header transforms for the proxy path. Split out from proxy.ts so the
// security-relevant rules are testable without standing up sockets.

import type { IncomingHttpHeaders } from "node:http";

/**
 * RFC 9110 §7.6.1. These describe one transport connection; forwarding them
 * causes double-chunking and stuck keep-alives.
 */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Upstreams trust these to describe the edge. tRadio's federation rate limiter
 * buckets per-IP off X-Forwarded-For, so without the strip any client could
 * forge the header and evade it.
 */
const CLIENT_SPOOFABLE = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-real-ip",
]);

export interface ForwardContext {
  /** Direct peer address of the inbound socket. */
  remoteAddress: string;
  /** Host header the client sent, for X-Forwarded-Host. */
  host: string;
  /** Mount prefix, sent as X-Forwarded-Prefix when stripping. */
  prefix: string | null;
}

/**
 * Drops hop-by-hop and anything a client could use to impersonate the edge, then
 * sets our own X-Forwarded-*. For an upgrade, proxy.ts preserves `connection`
 * and the websocket handshake headers itself.
 */
export function buildForwardHeaders(
  incoming: IncomingHttpHeaders,
  ctx: ForwardContext
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || CLIENT_SPOOFABLE.has(key)) continue;
    out[key] = v;
  }

  out["x-forwarded-for"] = ctx.remoteAddress;
  out["x-forwarded-proto"] = "http"; // the router terminates plain HTTP only
  if (ctx.host) out["x-forwarded-host"] = ctx.host;
  if (ctx.prefix) out["x-forwarded-prefix"] = ctx.prefix;

  return out;
}

/** Drop hop-by-hop headers from an upstream response. */
export function sanitizeResponseHeaders(
  incoming: IncomingHttpHeaders
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Only needed under stripPrefix, where the upstream believes it lives at the
 * root and scopes cookies to `/` or `/admin` — leaking them to sibling mounts or
 * never getting them back. A cookie with no Path is left alone: the browser
 * defaults it to the request directory, already prefixed from the client's side.
 */
export function rewriteCookiePath(cookie: string, mount: string): string {
  return cookie.replace(/;\s*Path\s*=\s*([^;]*)/i, (_all, rawPath: string) => {
    const p = rawPath.trim();
    if (!p.startsWith("/")) return `; Path=${mount}`;
    const joined = p === "/" ? `${mount}/` : `${mount}${p}`;
    return `; Path=${joined}`;
  });
}

/**
 * Root-relative only (`/api/x` -> `/db/api/x`). An absolute URL may point at a
 * third party, and a path-relative one already resolves against the prefixed
 * request path.
 */
export function rewriteLocation(location: string, mount: string): string {
  if (!location.startsWith("/")) return location;
  if (location.startsWith("//")) return location; // protocol-relative, not ours
  return mount + location;
}

/** Apply the stripPrefix rewrites to a whole response header set, in place. */
export function rewriteForMount(
  headers: Record<string, string | string[]>,
  mount: string
): Record<string, string | string[]> {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") {
      const v = headers[key];
      headers[key] = Array.isArray(v)
        ? v.map((c) => rewriteCookiePath(c, mount))
        : rewriteCookiePath(String(v), mount);
    } else if (lower === "location") {
      const v = headers[key];
      if (typeof v === "string") headers[key] = rewriteLocation(v, mount);
    }
  }
  return headers;
}
