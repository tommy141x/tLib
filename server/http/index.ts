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
import { composeHttpUrl, resolveConfig } from "./config";
import { fGetConvar, fGetCurrentResourceName, fOn } from "./fivem";
import { registerInProcess } from "./mounts";
import { unregisterResource } from "./registry";
import { Router } from "./router";

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
  registerBridge(cfg, log);

  router = new Router(cfg, serverName, log);
  router.start();

  // tLib's own in-process mounts (realtime at /rt).
  registerInProcess(log);

  // Always log the COMPOSED url, never the convar: the convar takes shorthand
  // ("fivem.example.com"), and the operator needs to see what tLib made of it
  // to catch a wrong guess without having to reason about the rules.
  if (cfg.publicUrlOverride) {
    log("info", `hub: ${composeHttpUrl(cfg.publicUrlOverride, null, cfg.port)}`);
  } else {
    // Detection runs in the background — a mount registered before it lands
    // reports the localhost form, which is cosmetic.
    resolvePublicIP().then((ip) => {
      const url = composeHttpUrl(null, ip, cfg.port);
      if (ip) {
        log("info", `hub: ${url}`);
      } else {
        log(
          "warn",
          `could not resolve this server's public IP, so clients are being told ` +
            `'${url}', which only works on this machine. Set tlib_http_public_url ` +
            `to your server's address or domain.`
        );
      }
    });
  }

  const selfName = fGetCurrentResourceName();

  // Any resource stopping drops its mounts. Without this a restarted resource
  // could not re-register, because the registry refuses collisions.
  fOn("onResourceStop", (stopped: unknown) => {
    if (typeof stopped !== "string") return;

    if (stopped === selfName) {
      router?.stop();
      router = null;
      return;
    }

    const removed = unregisterResource(stopped);
    if (removed.length) log("info", `${stopped} stopped — unmounted ${removed.join(", ")}`);
  });
}
