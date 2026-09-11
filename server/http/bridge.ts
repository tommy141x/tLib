// bridge.ts — the Lua-facing surface of the router.
//
// Contract for consumer resources:
//
//   exports['tLib']:RegisterWebApp({
//     id         = 'radio',              -- stable identifier
//     mount      = '/dispatch',          -- path prefix to serve it under
//     port       = Config.serverPort,    -- YOUR loopback listen port
//     host       = '127.0.0.1',          -- optional, must be loopback
//     stripPrefix= false,                -- true if you cannot emit the prefix
//     websocket  = true,                 -- forward WS upgrades
//     title      = 'Dispatch',           -- shown on the hub
//     listed     = true,                 -- false hides it from the hub index
//   })
//
// Returns a table: { ok = true, url = 'http://host:7777/dispatch' }
//                  { ok = false, error = '...' }
//
// Call it AFTER your own listener is up. Mounts are dropped automatically when
// the owning resource stops, so a restart just re-registers.

import { getCachedIP } from "../realtime/public-ip";
import { composeHttpUrl, type HttpConfig } from "./config";
import { fExports, fGetInvokingResource } from "./fivem";
import type { Log } from "./proxy";
import { list, type Mount, register, unregisterResource } from "./registry";

export function registerBridge(cfg: HttpConfig, log: Log): void {
  const baseUrl = () => composeHttpUrl(cfg.publicUrlOverride, getCachedIP(), cfg.port);

  fExports("RegisterWebApp", (raw: unknown) => {
    const caller = fGetInvokingResource() ?? "?";
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
      resourceName: caller,
      upstream: { host: str(opts.host) || "127.0.0.1", port },
      stripPrefix: bool(opts.stripPrefix, false),
      websocket: bool(opts.websocket, false),
    };

    const result = register(descriptor);
    if (!result.ok) {
      log("error", `${caller} could not mount '${mount}': ${result.error}`);
      return { ok: false, error: result.error };
    }

    log("info", `${caller} mounted '${result.mount.mount}' -> 127.0.0.1:${port}`);
    return { ok: true, url: `${baseUrl()}${result.mount.mount}` };
  });

  // Explicit teardown. Rarely needed — onResourceStop already handles the
  // normal case — but a resource that rebinds its listener can use it.
  fExports("UnregisterWebApp", () => {
    const caller = fGetInvokingResource() ?? "?";
    const removed = unregisterResource(caller);
    if (removed.length) log("info", `${caller} unmounted ${removed.join(", ")}`);
    return removed.length;
  });

  /** The router's public base URL, for resources composing their own links. */
  fExports("GetHubUrl", () => baseUrl());

  fExports("ListWebApps", () =>
    list().map((m) => ({
      id: m.id,
      mount: m.mount,
      title: m.title,
      listed: m.listed,
      resource: m.resourceName,
      url: `${baseUrl()}${m.mount}`,
    }))
  );
}

// ---- coercion ----
// Lua tables arrive as plain objects, but every field is whatever the caller
// put there. Nothing below trusts a type.

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
