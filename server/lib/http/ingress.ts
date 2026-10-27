// What the FXServer-port ingress should do with a path — decided here, performed
// in Lua by `server/sv_http_ingress.lua`.
//
// ── WHY THE ANSWER IS A VALUE AND NOT A RESPONSE ────────────────────────────
//
// The obvious ingress is a relay: take the request in Lua, re-issue it to the
// router on loopback, hand the bytes back. It cannot be done. Measured
// 2026-10-27 on FXServer Enhanced b139: `PerformHttpRequest` from inside
// `SetHttpHandler` to a listener IN THE SAME PROCESS crashes the server — "The
// application has crashed!", no stack, first request, every time. The identical
// relay to a listener in a DIFFERENT process is completely stable: 4 MB
// byte-exact in 21 ms, ten in parallel in 429 ms.
//
// So the ingress never speaks HTTP to us. It asks this function what to do and
// gets back either a finished response to send, or the address of a consumer's
// own loopback server — which IS a different process, and therefore the safe
// case. `[tScripts]/internal/reference/fxserver-http-ingress-findings.md` has
// the fixtures and the two wrong theories it took to get here.
//
// ── WHY NOT JUST EXPORT THE ROUTER ──────────────────────────────────────────
//
// `Router.onRequest` is written against Node's `IncomingMessage`/`ServerResponse`
// and `proxyRequest` streams into a socket. Neither exists on the Lua side, and
// shimming them would be a second implementation of the thing most likely to
// drift. This duplicates the ROUTING DECISIONS only — which mount, which path,
// which redirect — and `ingress.test.ts` holds it to the same answers
// `router.test.ts` asserts for the listener.

import { badGatewayPage, notFoundPage, renderIndex, renderError } from "./hub";
import { forwardPath, normalizePath } from "./paths";
import { hubDestinations, list, match } from "./registry";

/** A response the ingress can send as-is. `body` is text; binary never gets here. */
export interface InlineResponse {
  kind: "inline";
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A consumer's own loopback server — a separate process, which is the safe relay. */
export interface UpstreamTarget {
  kind: "upstream";
  host: string;
  port: number;
  /** Path to request from the upstream, already stripped or not per the mount. */
  path: string;
}

export type IngressResolution = InlineResponse | UpstreamTarget;

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

function inline(status: number, body: string, contentType = TEXT): InlineResponse {
  // `nosniff` on every answer, matching what the listener sets unconditionally
  // in `onRequest`. An ingress that quietly dropped it would be a weaker door to
  // the same content.
  return {
    kind: "inline",
    status,
    headers: { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" },
    body,
  };
}

function redirect(status: number, location: string): InlineResponse {
  return {
    kind: "inline",
    status,
    headers: { Location: location, "X-Content-Type-Options": "nosniff" },
    body: "",
  };
}

/**
 * `target` is the path as FXServer gave it, query string included.
 *
 * `serverName` is passed in rather than read here so this stays free of FiveM
 * globals — the same reason `router.ts` takes it as a function.
 */
export function resolveIngress(
  method: string,
  target: string,
  serverName: string,
  basePath = ""
): IngressResolution {
  // Every path the registry knows is absolute from the ROUTER's root, but this
  // door is mounted one level down at `/<resource>`. A Location or an href that
  // skips the prefix leaves the resource's namespace entirely and 404s from
  // FXServer — measured, the single-destination hub redirect sent browsers to
  // `/probe/` instead of `/tLib/probe/`.
  const at = (p: string) => `${basePath}${p}`;
  const verb = (method || "GET").toUpperCase();

  // Absolute-form request target, legal only for a forward proxy — which this
  // explicitly is not. Same refusal as the listener's.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return inline(400, "Bad Request\n");

  const qIndex = target.indexOf("?");
  const search = qIndex === -1 ? "" : target.slice(qIndex);
  const pathname = normalizePath(target);
  if (pathname === null) return inline(400, "Bad Request\n");

  if (pathname === "/") {
    if (verb !== "GET" && verb !== "HEAD") {
      return { kind: "inline", status: 405, headers: { Allow: "GET, HEAD" }, body: "" };
    }
    const mounts = list();
    const destinations = hubDestinations(mounts);
    if (destinations.length === 1) return redirect(302, at(destinations[0].path));
    const page = inline(200, renderIndex(mounts, serverName, basePath), HTML);
    // Visibility changes on a resource restart, so the single-app redirect above
    // must never be cached — and neither must the page that replaces it.
    page.headers["Cache-Control"] = "no-store";
    return page;
  }

  const mount = match(pathname);
  if (!mount) return inline(404, notFoundPage(pathname), HTML);

  if (mount.index && (pathname === mount.mount || pathname === `${mount.mount}/`)) {
    return redirect(302, at(`${mount.mount}${mount.index}${search}`));
  }

  if (pathname === mount.mount && mount.kind === "proxy" && mount.stripPrefix) {
    return redirect(301, at(`${mount.mount}/${search}`));
  }

  if (mount.kind === "inprocess") {
    if (!mount.onRequest) return inline(502, badGatewayPage(mount), HTML);
    // An in-process handler is a live function reference in tLib's own isolate.
    // It cannot be reached from Lua, and it cannot be reached over loopback
    // either — that is the crash this whole file exists to avoid. Today the only
    // one is realtime, which is WebSocket-only and unlisted, so nothing visible
    // is lost; a future one would need its own answer rather than this.
    return inline(
      501,
      renderError(
        501,
        "Not available on this port",
        "This destination is served in-process and is only reachable on tLib's own HTTP port."
      ),
      HTML
    );
  }

  return {
    kind: "upstream",
    host: mount.upstream.host,
    port: mount.upstream.port,
    path: forwardPath(pathname, mount.mount, mount.stripPrefix) + search,
  };
}

/**
 * The URL the FiveM-server-port door answers on, or null when it cannot be known.
 *
 * Derived from the listener's own resolved public URL by swapping the port: the
 * host is the same machine either way, and tLib has already done the work of
 * deciding what address reaches it.
 *
 * ⚠ Returns null unless that URL was DETECTED. An operator who set
 * `tlib_http_public_url` to a name is describing a proxy terminating TLS on 443
 * and forwarding to the listener — that proxy knows nothing about the FXServer
 * port, so swapping the port in would print an address nobody can reach. A
 * printed URL that does not work is worse than no line at all, which is the same
 * reasoning `status.ts` applies to a detected address naming itself.
 */
export function ingressUrlFrom(
  publicUrl: string | null,
  detected: boolean,
  netPort: string,
  resourceName: string
): string | null {
  if (!publicUrl || !detected) return null;
  const port = Number.parseInt(netPort, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // Only an authority with an explicit port is safe to rewrite; anything else is
  // the proxy case above wearing different clothes.
  const m = /^(https?:\/\/)(\[[^\]]+\]|[^/:]+):(\d+)$/i.exec(publicUrl.replace(/\/+$/, ""));
  if (!m) return null;
  return `${m[1]}${m[2]}:${port}/${resourceName}`;
}
