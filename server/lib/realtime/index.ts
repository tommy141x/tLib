// Registers the rt* exports at tLib boot. The WebSocket server itself starts on
// the first consumer call, so tLib stays a pure library until a resource
// declares `tlib_module { 'realtime' }` and uses it.

import { resolveConfig as resolveHttpConfig } from "../http/config";
import { makeEmitHooks, registerBridge } from "./bridge";
import { composeWsUrl, resolveConfig } from "./config";
import {
  fGetCurrentResourceName,
  fGetNumResourceMetadata,
  fGetNumResources,
  fGetResourceByFindIndex,
  fGetResourceMetadata,
  fOn,
} from "./fivem";
import { resolvePublicIP } from "./public-ip";
import { RealtimeServer } from "./server";

let instance: RealtimeServer | null = null;

function log(level: "info" | "warn" | "error", msg: string): void {
  const prefix = "[tLib/realtime]";
  if (level === "error") console.error(`${prefix} ${msg}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

/** Returns the running server, starting it on first call. */
export function getOrStart(): RealtimeServer {
  if (instance) return instance;
  const cfg = resolveConfig();
  const server = new RealtimeServer(cfg, makeEmitHooks(), log);
  server.start();
  instance = server;

  // Resolving the public IP and logging the advertised URL happens here rather
  // than in installRealtime(), so a server where nothing touches realtime stays
  // silent at boot.
  if (cfg.publicUrlOverride) {
    log("info", `public url (override): ${cfg.publicUrlOverride}`);
  } else {
    const port = resolveHttpConfig().port;
    resolvePublicIP().then((ip) => {
      if (ip) log("info", `public url: ${composeWsUrl(null, ip, port)}`);
      else log("warn", "could not resolve public IP; clients will receive ws://localhost");
    });
  }

  return server;
}

export function current(): RealtimeServer | null {
  return instance;
}

/** True iff `resource` declares the realtime module in its manifest.
 *
 *  Both spellings, because imports.lua accepts both: `tlib_module { 'realtime' }`
 *  and `tlib_modules { 'kvp', 'realtime' }`. Checking only the singular meant
 *  realtime never installed for any resource that used the plural form — which
 *  is every consumer in this repo. */
function requestsRealtime(resource: string): boolean {
  for (const key of ["tlib_module", "tlib_modules"]) {
    const count = fGetNumResourceMetadata(resource, key);
    for (let j = 0; j < count; j++) {
      if (fGetResourceMetadata(resource, key, j) === "realtime") return true;
    }
  }
  return false;
}

function anyResourceRequestsRealtime(): boolean {
  const selfName = fGetCurrentResourceName();
  const n = fGetNumResources();
  for (let i = 0; i < n; i++) {
    const res = fGetResourceByFindIndex(i);
    if (!res || res === selfName) continue;
    if (requestsRealtime(res)) return true;
  }
  return false;
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;

  const cfg = resolveConfig();
  registerBridge(() => getOrStart(), cfg);

  const selfName = fGetCurrentResourceName();
  fOn("onResourceStop", (stopped: unknown) => {
    if (stopped !== selfName) return;
    if (instance) {
      instance.stop();
      instance = null;
    }
  });
}

/**
 * Called once from server/main.ts, and does nothing unless a consumer opts in
 * with `tlib_module { 'realtime' }`. The gate is re-checked whenever a resource
 * starts, so an `ensure` after boot still wires things up while a server that
 * never needs realtime sees no registrations, no port and no log line.
 */
export function installRealtime(): void {
  if (anyResourceRequestsRealtime()) {
    install();
    return;
  }

  fOn("onResourceStart", (started: unknown) => {
    if (installed || typeof started !== "string") return;
    const selfName = fGetCurrentResourceName();
    if (started === selfName) return;
    if (requestsRealtime(started)) install();
  });
}
