// index.ts — starts the router at tLib boot.
//
// Unlike realtime (which opened its port lazily on first use), the router binds
// EAGERLY. server/marketplace/index.ts:52-62 already documents why: a consumer
// resource's Lua can run before tLib's own onResourceStart handler does. A
// backend calling RegisterWebApp into a router that has not been installed yet
// would lose its mount, and the failure would look like a routing bug.
//
// The cost of binding eagerly is one listening socket on a server where nobody
// registers anything — which still serves the hub, so it is not wasted.

import { resolvePublicIP } from "../realtime/public-ip";
import { registerBridge } from "./bridge";
import { resolveConfig } from "./config";
import { fEmit, fGetConvar, fGetCurrentResourceName, fOn } from "./fivem";
import { registerInProcess } from "./mounts";
import { clear, unregisterResource } from "./registry";
import { Router } from "./router";
import { HttpReadiness } from "./status";

let router: Router | null = null;

function log(level: "info" | "warn" | "error", msg: string): void {
  const prefix = "[tLib/http]";
  if (level === "error") console.error(`${prefix} ${msg}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

/** sv_hostname with FiveM colour codes (^1, ^*, ~r~) stripped. */
function serverName(): string {
  try {
    const raw = fGetConvar("sv_hostname", "");
    const clean = raw
      .replace(/\^[0-9*_~=]/g, "")
      .replace(/~[a-z]~/gi, "")
      .trim();
    return clean || "FiveM Server";
  } catch {
    return "FiveM Server";
  }
}

export function current(): Router | null {
  return router;
}

export function installHttp(): void {
  if (router) return;

  const cfg = resolveConfig();
  const readiness = new HttpReadiness(cfg.publicUrlOverride, cfg.port, (status) => {
    // Server-local notification only. Subscribe then query GetHttpStatus so a
    // consumer starting after this notification cannot miss readiness.
    if (status.ready) log("info", `hub: ${status.publicUrl}`);
    else if (status.publicUrlState === "failed") log("warn", status.error!);
    fEmit("tLib:http:status", status);
  });
  registerBridge(() => readiness.snapshot(), log);

  const installedRouter = new Router(cfg, serverName, log, (state, localUrl, error) =>
    readiness.listener(state, localUrl, error)
  );
  router = installedRouter;

  // tLib's own in-process mounts (realtime at /rt).
  registerInProcess(log);
  router.start();

  // Never publish implicit localhost while discovery is outstanding or failed.
  // Invalid overrides retain the documented detection fallback, but say so.
  if (readiness.snapshot().publicUrlState === "resolving") {
    if (cfg.publicUrlOverride) {
      log("warn", "Invalid tlib_http_public_url; attempting public IP detection instead");
    }
    resolvePublicIP().then(
      (ip) => readiness.resolveAddress(ip),
      () => readiness.resolveAddress(null)
    );
  }

  const selfName = fGetCurrentResourceName();

  // Any resource stopping drops its mounts. Without this a restarted resource
  // could not re-register, because the registry refuses collisions.
  fOn("onResourceStop", (stopped: unknown) => {
    if (typeof stopped !== "string" || router !== installedRouter) return;

    if (stopped === selfName) {
      installedRouter.stop();
      // A same-process restart must not collide with stale consumer mounts.
      clear();
      router = null;
      return;
    }

    const removed = unregisterResource(stopped);
    if (removed.length) log("info", `${stopped} stopped — unmounted ${removed.join(", ")}`);
  });
}
