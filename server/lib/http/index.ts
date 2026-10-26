// index.ts — starts the router at tLib boot.
//
// Unlike realtime (which opens its port lazily on first use), the router binds
// eagerly: a consumer's Lua can run RegisterWebApp before tLib's own
// onResourceStart handler does, and a router that isn't installed yet would
// lose the mount silently. The cost is one idle listening socket, which still
// serves the hub.

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
    // Server-local notification; subscribe then query GetHttpStatus so a late
    // consumer cannot miss readiness. The hub URL goes to tLib's startup banner,
    // not a separate log line; a failure still logs loudly.
    //
    // A detected address names itself and the convar (`tlib_http_public_url`) in
    // the same row. Printing a detected URL bare used to read as fact rather
    // than a guess — when the guess was wrong it surfaced later as a CORS
    // refusal or an unreachable OAuth redirect, far from the cause, and v7
    // moved public routing off a config key onto convars, so operators kept
    // searching config.lua for a setting that no longer lived there.
    if (status.ready) {
      fEmit(
        "tlib:vcInfo:hub",
        status.publicUrlDetected
          ? `${status.publicUrl} (detected — set tlib_http_public_url if players reach you another way)`
          : status.publicUrl
      );
    } else if (status.publicUrlState === "failed") log("warn", status.error!);
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

  // Any resource stopping drops its mounts, or a restarted resource could not
  // re-register since the registry refuses collisions.
  fOn("onResourceStop", (stopped: unknown) => {
    if (typeof stopped !== "string" || router !== installedRouter) return;

    if (stopped === selfName) {
      installedRouter.stop();
      clear();
      router = null;
      return;
    }

    unregisterResource(stopped);
  });
}
