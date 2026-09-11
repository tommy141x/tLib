// headers.ts — pure header transforms for the proxy path.
//
// Split out from proxy.ts so the security-relevant rules (hop-by-hop stripping,
// X-Forwarded spoof prevention, cookie/redirect rewriting) are testable without
// standing up sockets.

import type { IncomingHttpHeaders } from "node:http";

/**
 * Hop-by-hop headers, per RFC 9110 §7.6.1. These describe a single transport
 * connection and MUST NOT be forwarded — leaking them through a proxy causes
 * real, hard-to-diagnose breakage (double-chunking, stuck keep-alives).
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
 * Headers a client must never be able to set, because upstreams trust them to
 * describe the edge. tRadio's federation rate limiter buckets per-IP off
 * X-Forwarded-For (server/lib/http.ts:84); without this strip, any client could
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
 * Build the header set to send upstream: drop hop-by-hop, drop anything the
 * client could use to impersonate the edge, then set our own X-Forwarded-*.
 *
 * `connection: upgrade` and the websocket handshake headers are preserved by
 * the caller for upgrades — see proxy.ts.
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
 * Re-anchor a `Set-Cookie` Path attribute under the mount.
 *
 * Only needed when stripPrefix is on: the upstream believes it lives at the
 * root and will scope cookies to `/` or `/admin`, which would either leak the
 * cookie to sibling mounts or fail to be sent back at all.
 *
 * A cookie with no Path is left alone — the browser defaults it to the request
 * directory, which is already prefixed from the client's point of view.
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
 * Re-anchor a redirect `Location` under the mount.
 *
 * Handles root-relative targets (`/api/x` → `/db/api/x`). Absolute URLs and
 * path-relative targets are left alone: an absolute URL to a third party must
 * not be rewritten, and a relative one already resolves correctly against the
 * prefixed request path.
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
