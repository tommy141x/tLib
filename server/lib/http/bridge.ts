// The Lua-facing surface of the router.
//
//   exports['tLib']:RegisterWebApp({
//     id         = 'radio',              -- stable identifier
//     mount      = '/dispatch',          -- path prefix to serve it under
//     port       = 54231,                -- YOUR loopback listen port, read off
//                                        -- your own listener. tLib's
//                                        -- tlib_http_port is the only port an
//                                        -- operator should have to set.
//     host       = '127.0.0.1',          -- optional, must be loopback
//     stripPrefix= false,                -- true if you cannot emit the prefix
//     websocket  = true,                 -- forward WS upgrades
//     index      = '/_/',                -- optional, where the bare mount lands
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
// Returns { ok = true, url = '...' } or { ok = false, error = '...' }, and
// { ok = false, retryable = true } while tLib is still binding or discovering its
// public address. Call after your own listener is up; subscribe to
// 'tLib:http:status' and re-register after onResourceStart('tLib') to catch
// readiness. Mounts drop automatically when the owning resource or tLib stops.
//
// GetHttpStatus.localUrl is the real listener, for health checks; publicUrl may
// name an HTTPS proxy on another port. GetHubUrl is '' until both are ready.

import { fExports, fGetInvokingResource } from "./fivem";
import type { Log } from "./proxy";
import { resolveIngress } from "./ingress";
import { list, type Mount, register, unregisterResource } from "./registry";
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
  runtime.exports("GetHttpStatus", () => status());

  // The FXServer-port ingress asks what to do with a path; sv_http_ingress.lua
  // performs it. It cannot ask by making an HTTP request to us — that crashes
  // the server, see ingress.ts — so the answer is a value.
  runtime.exports(
    "ResolveHttpIngress",
    (method: unknown, target: unknown, serverName: unknown, basePath: unknown) =>
      resolveIngress(
        String(method ?? "GET"),
        String(target ?? "/"),
        String(serverName ?? ""),
        String(basePath ?? "")
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
      // Refuse rather than claim the mount: the caller's own retry would collide
      // with it once discovery and bind complete.
      return {
        ok: false,
        retryable: true,
        error: current.error ?? "tLib HTTP is waiting for its listener and public address",
      };
    }

    const result = register(descriptor);
    if (!result.ok) {
      log("error", `${caller} could not mount '${mount}': ${result.error}`);
      return { ok: false, error: result.error };
    }

    // No success line: the consumer prints this URL in its own startup banner
    // one line later.
    return { ok: true, url: `${current.publicUrl}${result.mount.mount}` };
  });

  // Rarely needed: onResourceStop covers the normal case. For a resource that
  // rebinds its listener.
  runtime.exports("UnregisterWebApp", () => {
    const caller = runtime.invokingResource() ?? "?";
    return unregisterResource(caller).length;
  });

  /** The router's public base URL, for resources composing their own links. */
  runtime.exports("GetHubUrl", () => baseUrl());

  runtime.exports("ListWebApps", () =>
    list().map((m) => ({
      id: m.id,
      mount: m.mount,
      title: m.title,
      listed: m.listed,
      hubLinks: m.hubLinks ?? [],
      resource: m.resourceName,
      url: status().ready ? `${baseUrl()}${m.mount}` : null,
    }))
  );
}

// A Lua table arrives as a plain object whose every field is whatever the caller
// put there, so nothing below trusts a type.

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
