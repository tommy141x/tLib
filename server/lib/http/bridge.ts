// The Lua-facing surface of the router.
//
//   exports['tLib']:RegisterWebApp({
//     id         = 'radio',              -- stable identifier
//     mount      = '/dispatch',          -- path prefix to serve it under
//     port       = 54231,                -- YOUR loopback listen port, read off your own
//                                        -- listener. An operator sets none by default.
//     host       = '127.0.0.1',          -- optional, must be loopback
//     stripPrefix= false,                -- true if you cannot emit the prefix
//     websocket  = true,                 -- forward WS upgrades
//     index      = '/_/',                -- optional, where the bare mount lands
//     legacyMounts = { '/db' },          -- optional; old paths, answered 301. Name the mount
//                                        -- after your resource ('/tDB'): on the FiveM server
//                                        -- port a path's first segment IS the resource name, so
//                                        -- a mount matching it is the SAME path on both doors.
//     -- Hub card. All optional; a bad value costs the decoration, not the mount.
//     title      = 'Dispatch',           -- shown on the hub
//     icon       = 'radio-tower',        -- any Lucide icon name
//     description= 'Radio and dispatch', -- one line under the title
//     accent     = '#4f8ef7',            -- #rgb or #rrggbb
//     listed     = true,                 -- primary destination visibility only
//     hubLinks   = {                     -- optional sibling cards, NOT mounts
//       { id = 'admin', path = '/admin', title = 'Radio Admin', listed = false },
//     },                                 -- paths must stay within this mount
//   })
//
// Returns { ok = true, url = '...' } or { ok = false, error = '...' }, and { ok = false,
// retryable = true } while tLib is still discovering its public address or has no door to publish
// on. Call after your own listener is up; subscribe to 'tLib:http:status' and re-register after
// onResourceStart('tLib') to catch readiness. Mounts drop when the owner or tLib stops.
//
// `url` is the mount's address on whichever door serves, which is NOT always publicUrl plus the
// mount: on the FiveM server port an app answers under its owning resource. Use what this
// returns; never compose it.
//
// GetHttpStatus.localUrl is the real listener, for health checks — null whenever no listener
// binds, which is the default, and then there is nothing to probe. publicUrl may name an HTTPS
// proxy on another port. GetHubUrl is '' until a door and an address are both known.

import {
  fExports,
  fGetInvokingResource,
  fGetNumResourceMetadata,
  fGetResourceMetadata,
} from "./fivem";
import type { Log } from "./proxy";
import { resolveIngress } from "./ingress";
import { ingressPath, list, type Mount, register, unregisterResource } from "./registry";
import type { HttpStatus } from "./status";

/** The script a consumer must load to answer anything on the FiveM server port. */
const INGRESS_DOOR_SUFFIX = "tlib/server/sv_http_ingress.lua";

/**
 * Does `resource` load tLib's ingress door?
 *
 * On the FiveM server port, `http://<host>:<port>/<resource>/<path>` is routed to THAT
 * resource's own `SetHttpHandler` before any resource code runs, so only the owner can
 * serve the owner's paths. A consumer that mounts but never loads
 * `@tLib/server/sv_http_ingress.lua` therefore registers fine, appears on the hub with a
 * working-looking card, and every link to it answers FXServer's own bare `Not found.` —
 * which names nothing and cannot be traced back to the mount.
 *
 * Read from the engine's parsed metadata rather than by matching on fxmanifest.lua: a
 * regex over a manifest also matches the same text inside a comment, and these are the
 * entries FXServer actually loaded.
 *
 * ⚠ FAILS OPEN. Any error, or a runtime that cannot answer, returns true — a diagnostic
 * that cries wolf on a healthy server is worse than one that stays quiet, and this one's
 * whole job is to be believed when it fires.
 *
 * Exported for `bridge.test.ts`: the alternative is asserting on a log line through two
 * layers of injected fakes, which tests the message rather than the decision.
 */
export function loadsIngressDoor(
  resource: string,
  countMetadata: (resource: string, key: string) => number,
  readMetadata: (resource: string, key: string, index: number) => string | null
): boolean {
  let count: number;
  try {
    count = countMetadata(resource, "server_script");
  } catch {
    return true;
  }
  if (!Number.isFinite(count) || count <= 0) return true;
  for (let i = 0; i < count; i++) {
    let entry: string | null;
    try {
      entry = readMetadata(resource, "server_script", i);
    } catch {
      continue;
    }
    // `@tLib/...` as written, any separator, any casing of the resource name.
    if (typeof entry === "string" && entry.replace(/\\/g, "/").toLowerCase().endsWith(INGRESS_DOOR_SUFFIX))
      return true;
  }
  return false;
}

/**
 * Injection seam for the FiveM globals this module touches.
 *
 * The two metadata readers are OPTIONAL deliberately: every existing caller builds this
 * object by hand without them and keeps compiling, and when they are absent the
 * ingress-door check is SKIPPED rather than guessed. Same rule as `loadsIngressDoor` —
 * an unknown answer must never produce a diagnostic.
 */
export interface BridgeRuntime {
  exports: typeof fExports;
  invokingResource: typeof fGetInvokingResource;
  countMetadata?: typeof fGetNumResourceMetadata;
  readMetadata?: typeof fGetResourceMetadata;
}

export function registerBridge(
  status: () => HttpStatus,
  log: Log,
  runtime: BridgeRuntime = {
    exports: fExports,
    invokingResource: fGetInvokingResource,
    countMetadata: fGetNumResourceMetadata,
    readMetadata: fGetResourceMetadata,
  }
): void {
  const baseUrl = () => {
    const current = status();
    return current.ready ? (current.publicUrl ?? "") : "";
  };

  /**
   * A mount's own address on whichever door is serving. The two doors spell the same mount
   * differently — `registry.ingressPath` is the one rule for the FiveM server port — so this is
   * not `publicUrl + mount`. The trailing slash `ingressPath` gives a self-named mount's root is
   * dropped: this is a base a consumer appends its own paths to, and a doubled slash is a
   * different URL to a browser and to an OAuth redirect allowlist.
   */
  const mountUrl = (base: string, mount: Mount, door: HttpStatus["door"]) =>
    door === "ingress"
      ? `${base}${ingressPath(mount, mount.mount).replace(/\/$/, "")}`
      : `${base}${mount.mount}`;
  runtime.exports("GetHttpStatus", () => status());

  // The FXServer-port ingress asks what to do with a path; sv_http_ingress.lua performs it. It
  // cannot ask over HTTP — that crashes the server, see ingress.ts — so the answer is a value.
  //
  // `owner` is the calling resource's own `GetCurrentResourceName()`, not `GetInvokingResource()`,
  // which is not dependable across the Lua→JS export boundary. Not an access gate and does not
  // need to be: it decides which prefix an app's URLs are built under, and a resource wanting
  // another's mount table could already read it from `ListWebApps`.
  runtime.exports(
    "ResolveHttpIngress",
    (method: unknown, target: unknown, serverName: unknown, basePath: unknown, owner: unknown) =>
      resolveIngress(
        String(method ?? "GET"),
        String(target ?? "/"),
        String(serverName ?? ""),
        String(basePath ?? ""),
        typeof owner === "string" && owner !== "" ? owner : null
      )
  );

  runtime.exports("RegisterWebApp", (raw: unknown) => {
    const caller = runtime.invokingResource() ?? "?";
    const opts = asRecord(raw);
    if (!opts) return { ok: false, error: "RegisterWebApp expects a table" };

    const id = str(opts.id) || caller;
    const mount = str(opts.mount);
    if (!mount) return { ok: false, error: "'mount' is required" };

    const port = int(opts.port);
    if (port === null) return { ok: false, error: "'port' is required and must be a number" };

    const descriptor: Mount = {
      kind: "proxy",
      id,
      mount,
      title: str(opts.title) || id,
      listed: bool(opts.listed, true),
      hubLinks: Array.isArray(opts.hubLinks) ? opts.hubLinks : undefined,
      legacyMounts: Array.isArray(opts.legacyMounts) ? opts.legacyMounts.map(String) : undefined,
      resourceName: caller,
      upstream: { host: str(opts.host) || "127.0.0.1", port },
      stripPrefix: bool(opts.stripPrefix, false),
      websocket: bool(opts.websocket, false),
      index: str(opts.index) || undefined,
      // Validated in register(), and dropped rather than rejected if unusable.
      icon: str(opts.icon) || undefined,
      description: str(opts.description) || undefined,
      accent: str(opts.accent) || undefined,
    };

    const current = status();
    if (!current.ready || !current.publicUrl) {
      // Refuse rather than claim the mount: the caller's retry would collide once bind completes.
      return {
        ok: false,
        retryable: true,
        error: current.error ?? "tLib HTTP is still resolving its public address",
      };
    }

    const result = register(descriptor);
    if (!result.ok) {
      log("error", `${caller} could not mount '${mount}': ${result.error}`);
      return { ok: false, error: result.error };
    }

    // The mount is accepted either way — the app works and Socket.IO falls back to long polling.
    // But the upgrade cannot cross the FiveM server port at all, and a silent fallback shows up as
    // latency rather than as an error, which is the hardest shape of this to diagnose later.
    if (descriptor.websocket && current.door === "ingress") {
      log(
        "warn",
        `${caller} mounted '${result.mount.mount}' asking for WebSocket, which the FiveM ` +
          `server port cannot carry — it will fall back to polling. Set 'tlib_http_port' ` +
          `to bind a listener if that app needs a real socket.`
      );
    }

    const url = mountUrl(current.publicUrl, result.mount, current.door);

    // ⛔ Mounted, hub-listed, and completely unreachable — the one failure this router
    // could not previously name.
    //
    // Reported 2026-11-02 by a server running a current tLib against a tRadio from before
    // tRadio shipped the door. The hub rendered two confident cards; both links answered
    // FXServer's bare `Not found.`, which says nothing about tLib, the mount, or the
    // resource. The server console had the mount line and the WebSocket warning and no
    // hint that the app could not be reached at all.
    //
    // An error, not a warning: unlike the WebSocket fallback above, nothing works.
    if (
      current.door === "ingress" &&
      runtime.countMetadata !== undefined &&
      runtime.readMetadata !== undefined &&
      !loadsIngressDoor(caller, runtime.countMetadata, runtime.readMetadata)
    ) {
      log(
        "error",
        `${caller} mounted '${result.mount.mount}' but does not load tLib's ingress door, ` +
          `so ${url} will answer FXServer's own 404 and nothing will say why. On the FiveM ` +
          `server port the first path segment IS the resource name and is routed before any ` +
          `resource code runs, so only ${caller} can serve ${caller}'s paths. Fix: add ` +
          `server_script '@tLib/server/sv_http_ingress.lua' to ${caller}'s fxmanifest — if ` +
          `${caller} is a product, update it. Or set 'tlib_http_port' to bind tLib's own ` +
          `listener, which serves every mount without this.`
      );
    }

    // No success line: the consumer prints this URL in its own startup banner one line later.
    return { ok: true, url };
  });

  // Rarely needed: onResourceStop covers the normal case. For a resource that rebinds its listener.
  runtime.exports("UnregisterWebApp", () => {
    const caller = runtime.invokingResource() ?? "?";
    return unregisterResource(caller).length;
  });

  /** The router's public base URL, for resources composing their own links. */
  runtime.exports("GetHubUrl", () => baseUrl());

  runtime.exports("ListWebApps", () => {
    const current = status();
    return list().map((m) => ({
      id: m.id,
      mount: m.mount,
      title: m.title,
      listed: m.listed,
      hubLinks: m.hubLinks ?? [],
      resource: m.resourceName,
      url: current.ready && current.publicUrl ? mountUrl(current.publicUrl, m, current.door) : null,
    }));
  });
}

// A Lua table arrives as a plain object whose fields are whatever the caller put there, so nothing
// below trusts a type.

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function int(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
