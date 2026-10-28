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

import { fExports, fGetInvokingResource } from "./fivem";
import type { Log } from "./proxy";
import { resolveIngress } from "./ingress";
import { ingressPath, list, type Mount, register, unregisterResource } from "./registry";
import type { HttpStatus } from "./status";

export function registerBridge(
  status: () => HttpStatus,
  log: Log,
  runtime = { exports: fExports, invokingResource: fGetInvokingResource }
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

    // No success line: the consumer prints this URL in its own startup banner one line later.
    return { ok: true, url: mountUrl(current.publicUrl, result.mount, current.door) };
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
