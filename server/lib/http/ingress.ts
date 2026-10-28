// What the FXServer-port ingress does with a path, performed in Lua by `server/sv_http_ingress.lua`.
//
// The answer is a value and not a response because `PerformHttpRequest` to tLib's router from
// inside tLib's handler gives "The application has crashed!", no stack, on the first request,
// every time. Relaying is otherwise fine (measured 2026-10-27, 55/55, including a resource
// relaying to its own listener), so this returns a finished response or a loopback address to
// relay to. Fixtures, and the claim this replaced — "same process is fatal", measured before the
// empty-header crash was known and too broad — are in
// `[tScripts]/internal/reference/fxserver-http-ingress-findings.md`.
//
// Not an exported router: `Router.onRequest` takes Node's `IncomingMessage`/`ServerResponse` and
// `proxyRequest` streams into a socket, neither of which exists in Lua, so a shim would be a
// second implementation that drifts. This duplicates routing decisions only, and
// `ingress.test.ts` holds it to the answers `router.test.ts` asserts.

import { badGatewayPage, notFoundPage, renderIndex, renderError } from "./hub";
import { forwardPath, normalizePath, samePath } from "./paths";
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
  /**
   * What a root-relative path out of this app must be prefixed with to stay inside this door —
   * its `X-Forwarded-Prefix`, and what a `Location` or cookie `Path` is rewritten with. Decided
   * here because it depends on the base path, whether the mount was stripped and whether the
   * mount appears in the URL at all; getting it wrong costs every asset on the page.
   */
  prefix: string;
}

export type IngressResolution = InlineResponse | UpstreamTarget;

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

function inline(status: number, body: string, contentType = TEXT): InlineResponse {
  // `nosniff` on every answer, matching what the listener sets unconditionally in `onRequest`.
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
 * `target` is the path as FXServer gave it, query string included. `serverName` is passed in so
 * this stays free of FiveM globals, as `router.ts` does.
 *
 * `owner` is the resource whose door this is and decides what it can reach. FXServer routes by
 * resource name, so `/tRadio/dispatch/` can only be answered by tRadio: a mount is reachable
 * under its owner's name and nowhere else. tLib's own door therefore serves the hub and nothing
 * else — `/tLib/dispatch/` is a 404 by design, because the one URL for that app is
 * `/tRadio/dispatch/`. `null` is the listener, one door for everything on the router's flat paths.
 */
export function resolveIngress(
  method: string,
  target: string,
  serverName: string,
  basePath = "",
  owner: string | null = null
): IngressResolution {
  // Registry paths are absolute from the ROUTER's root; this door is mounted at `/<resource>`, and
  // a path that skips the prefix 404s from FXServer. Measured: the single-destination hub redirect
  // sent browsers to `/probe/` instead of `/tLib/probe/`.
  const at = (p: string) => `${basePath}${p}`;
  const verb = (method || "GET").toUpperCase();

  // Absolute-form request target, legal only for a forward proxy. Refused, as the listener does.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return inline(400, "Bad Request\n");

  const qIndex = target.indexOf("?");
  const search = qIndex === -1 ? "" : target.slice(qIndex);
  const pathname = normalizePath(target);
  if (pathname === null) return inline(400, "Bad Request\n");

  // Only the owner's own mounts, so one app has one URL. Empty on tLib's door, which registers no
  // proxy mount — that is what makes it the hub rather than a second route to everyone's apps.
  const reachable = owner === null ? list() : list().filter((m) => m.resourceName === owner);

  // The app named after this door's own resource. FXServer already consumed that segment, so it
  // goes back on before the mount table is consulted and comes off on the way out — which is what
  // makes `/tRadio/admin` the address on BOTH doors. `registry.ingressPath` must agree, being the
  // same rule for a hub link. One such mount per door; the alternative was `/tRadio/tRadio/`.
  const selfNamed =
    owner === null
      ? null
      : (reachable.find((m) => m.mount === basePath && m.kind === "proxy" && m.stripPrefix) ?? null);

  const logical = selfNamed ? `${basePath}${pathname}` : pathname;
  const publicPath = (p: string) =>
    selfNamed ? at(p.slice(selfNamed.mount.length) || "/") : at(p);

  // The one app this door exists for, when there is exactly one. An in-process mount is not it:
  // tLib's realtime mount is the only one, and treating it as this door's app sends the hub to 501.
  const sole =
    owner !== null && reachable.length === 1 && reachable[0].kind === "proxy"
      ? reachable[0]
      : null;

  if (pathname === "/" && !selfNamed) {
    if (verb !== "GET" && verb !== "HEAD") {
      return { kind: "inline", status: 405, headers: { Allow: "GET, HEAD" }, body: "" };
    }
    // A door with one app opens onto it. Counting hub DESTINATIONS instead sent `/tRadio/` to a
    // two-card picker, because the dispatch panel lists its admin page as a sibling.
    if (sole) {
      const only = redirect(302, publicPath(`${sole.mount}${sole.index ?? "/"}`));
      only.headers["Cache-Control"] = "no-store";
      return only;
    }
    const destinations = hubDestinations(reachable);
    if (destinations.length === 1) {
      const only = redirect(302, at(destinations[0].path));
      only.headers["Cache-Control"] = "no-store";
      return only;
    }
    const page =
      destinations.length === 0
        ? inline(200, renderIndex(list(), serverName, "", true), HTML)
        : inline(200, renderIndex(reachable, serverName, basePath), HTML);
    // Visibility changes on a resource restart, so none of this may be cached.
    page.headers["Cache-Control"] = "no-store";
    return page;
  }

  // No `legacyMounts` here, deliberately: this door is new, so nothing is bookmarked into it, and
  // for a self-named mount an old path like `/tRadio/dispatch/` is INSIDE the app, for the app to
  // answer. The 301 belongs on the listener, where the old URLs were published — `router.ts`.
  const mount = match(logical, reachable);
  if (!mount) return inline(404, notFoundPage(pathname), HTML);

  if (mount.index && (samePath(logical, mount.mount) || samePath(logical, `${mount.mount}/`))) {
    return redirect(302, publicPath(`${mount.mount}${mount.index}`) + search);
  }

  if (samePath(logical, mount.mount) && mount.kind === "proxy" && mount.stripPrefix) {
    return redirect(301, `${publicPath(`${mount.mount}/`)}${search}`);
  }

  if (mount.kind === "inprocess") {
    if (!mount.onRequest) return inline(502, badGatewayPage(mount), HTML);
    // A live function reference in tLib's own isolate: unreachable from Lua, and over loopback it
    // is the crash this file exists to avoid. Only realtime today, WebSocket-only and unlisted, so
    // nothing visible is lost; a future one would need its own answer rather than this.
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
    path: forwardPath(logical, mount.mount, mount.stripPrefix) + search,
    // A self-named app writes `/x` for `/tRadio/x`; one mounted under another name and stripped
    // writes `/x` for `/thatRes/thatMount/x`; an unstripped one already writes its own mount.
    prefix: selfNamed || !mount.stripPrefix ? basePath : `${basePath}${mount.mount}`,
  };
}

/**
 * The URL the FiveM-server-port door answers on, or null when it cannot be known — derived from
 * the listener's resolved public URL by swapping the port, since it is the same machine either way.
 *
 * Null when the URL carries NO explicit port, which is what a name configured in
 * `tlib_http_public_url` looks like: a proxy terminating TLS on 443 that knows nothing about the
 * FXServer port. Swapping it in would print an address nobody can reach, worse than no line.
 *
 * The test is the port, not whether the address was detected: a first version keyed on `detected`
 * printed nothing on a dev box, where tLib resolves `http://localhost:7777` as configured.
 */
export function ingressUrlFrom(
  publicUrl: string | null,
  netPort: string,
  resourceName: string
): string | null {
  if (!publicUrl) return null;
  const port = Number.parseInt(netPort, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  const m = /^(https?:\/\/)(\[[^\]]+\]|[^/:]+):(\d+)$/i.exec(publicUrl.replace(/\/+$/, ""));
  if (!m) return null;
  return `${m[1]}${m[2]}:${port}/${resourceName}`;
}
