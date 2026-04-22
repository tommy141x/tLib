// index.ts — registers the rt* exports at tLib boot.
//
// The WebSocket server DOES NOT open a port at boot. It starts lazily on the
// first consumer call (issueToken, setRooms, publish, etc.) — so tLib is a
// pure library until a resource actually declares `tlib_module { 'realtime' }`
// and uses it.

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

  // First time a consumer actually needs the realtime server — only now do
  // we bother resolving the public IP and logging the advertised URL.
  // Keeping this out of installRealtime() means tLib stays silent at boot
  // for servers where no resource ever touches realtime.
  if (cfg.publicUrlOverride) {
    log("info", `public url (override): ${cfg.publicUrlOverride}`);
  } else {
    resolvePublicIP().then((ip) => {
      if (ip) log("info", `public url: ${composeWsUrl(null, ip, cfg.port)}`);
      else log("warn", "could not resolve public IP; clients will receive ws://localhost");
    });
  }

  return server;
}

export function current(): RealtimeServer | null {
  return instance;
}

/** True iff any loaded resource declares `tlib_module { 'realtime' }`. */
function anyResourceRequestsRealtime(): boolean {
  const selfName = fGetCurrentResourceName();
  const n = fGetNumResources();
  for (let i = 0; i < n; i++) {
    const res = fGetResourceByFindIndex(i);
    if (!res || res === selfName) continue;
    const count = fGetNumResourceMetadata(res, "tlib_module");
    for (let j = 0; j < count; j++) {
      if (fGetResourceMetadata(res, "tlib_module", j) === "realtime") return true;
    }
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
 * Called once from tLib/server/main.ts. Does NOTHING unless a consumer
 * resource explicitly opts in via `tlib_module { 'realtime' }` in its
 * fxmanifest. That gate is checked at tLib boot and again whenever a new
 * resource starts — so an `ensure` after boot still wires things up, but
 * servers running tLib + tRadio/tELS/tAFK (none of which need realtime) see
 * no registrations, no port, no log line, nothing.
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
    const count = fGetNumResourceMetadata(started, "tlib_module");
    for (let j = 0; j < count; j++) {
      if (fGetResourceMetadata(started, "tlib_module", j) === "realtime") {
        install();
        return;
      }
    }
  });
}
