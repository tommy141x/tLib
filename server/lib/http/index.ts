// index.ts — installs the router at tLib boot.
//
// The mount table and the bridge are installed eagerly whether or not a
// listener binds: a consumer's Lua can run RegisterWebApp before tLib's own
// onResourceStart handler does, and a registry that isn't installed yet would
// lose the mount silently. When `tlib_http_port`/`tlib_http_host` ask for a
// listener it binds eagerly too, for the same reason.

import { resolvePublicIP } from "../realtime/public-ip";
import { registerBridge } from "./bridge";
import { resolveConfig } from "./config";
import { fEmit, fGetConvar, fGetCurrentResourceName, fOn } from "./fivem";
import { ingressUrlFrom } from "./ingress";
import { registerInProcess } from "./mounts";
import { clear, unregisterResource } from "./registry";
import { Router } from "./router";
import { HttpReadiness } from "./status";

let router: Router | null = null;
// Separate from `router`, which is legitimately null for the whole lifetime of a
// server that binds no listener.
let installed = false;

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
  if (installed) return;

  const cfg = resolveConfig();
  const ingressEnabled = fGetConvar("tlib_http_ingress", "true") !== "false";

  /**
   * The published port: the listener's when one binds, the FiveM server port's
   * when none does.
   *
   * READ LAZILY. `netPort` is NOT populated when a resource's bundle loads —
   * FXServer fills it later in boot, and `GetConvar("netPort", "")` returns the
   * string "0" until it does. Snapshotting it here published
   * `http://<host>:0`, and `0` is finite so no guard caught it. Measured live:
   * "0" at install, "30120" once the server was up.
   *
   * A function rather than a retry loop because readiness already re-runs on
   * every status transition, and by the time an address is published the port
   * is there.
   */
  const advertisedPort = (): number | null => {
    if (cfg.port !== null) return cfg.port;
    const n = Number.parseInt(fGetConvar("netPort", ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (cfg.port === null && !ingressEnabled) {
    log(
      "error",
      "'tlib_http_ingress' is false and 'tlib_http_port' is unset, so tLib has no door: " +
        "the hub and every resource behind it are unreachable. Set 'tlib_http_port' to bind " +
        "a listener, or drop 'tlib_http_ingress false' to serve on the FiveM server port."
    );
  }

  const doors = { listener: cfg.port !== null, ingress: ingressEnabled };
  const readiness = new HttpReadiness(cfg.publicUrlOverride, advertisedPort, (status) => {
    // Server-local notification; subscribe then query GetHttpStatus so a late
    // consumer cannot miss readiness. The hub URL goes to tLib's startup banner,
    // not a separate log line; a failure still logs loudly.
    //
    // A detected address names itself and the convar (`tlib_http_public_url`) in
    // the same row — see `status.ts` on why a guess must not read as a fact.
    if (status.ready) {
      // THE BANNER NAMES THE DOOR THAT IS ACTUALLY OPEN.
      //
      // A listener's port is reachable only on a server whose owner forwarded
      // it. Printing it as *the* hub address told every install that had one to
      // visit a port nothing can reach, while the address that works with no
      // configuration at all sat on a secondary line below. The FiveM server
      // port needs no firewall rule by construction — it is how the game
      // connects — so when the ingress can be named, it IS the hub address and
      // the listener is the footnote.
      //
      // `ingressUrlFrom` returns null when the public URL carries no explicit
      // port, which is the reverse-proxy case: that proxy knows nothing about
      // the FiveM port, so the configured address stays the headline there.
      const ingressUrl = ingressEnabled
        ? ingressUrlFrom(status.publicUrl, fGetConvar("netPort", ""), fGetCurrentResourceName())
        : null;

      // The host is a guess in both URLs, so the hint travels with whichever is
      // shown — see `status.ts` on why a guess must not read as a fact.
      const detected = status.publicUrlDetected
        ? " (detected — set tlib_http_public_url if players reach you another way)"
        : "";

      // One row, one address, no second line. The listener's URL is not news at
      // boot: an operator who opened that port knows its number, and one who did
      // not must not be told to go there. Which door carries what belongs in the
      // docs, not in a status line.
      fEmit("tlib:vcInfo:hub", `${ingressUrl ?? status.publicUrl}${detected}`);
    } else if (status.publicUrlState === "failed") log("warn", status.error!);
    fEmit("tLib:http:status", status);
  }, doors);
  registerBridge(() => readiness.snapshot(), log);
  installed = true;

  // tLib's own in-process mounts (realtime at /rt). Registered either way: with
  // no listener the ingress answers it 501, which is the honest answer for a
  // destination that cannot be served through that door.
  registerInProcess(log);

  if (cfg.port !== null) {
    const bound = new Router({ ...cfg, port: cfg.port }, serverName, log, (state, localUrl, error) => {
      //  `tlib_http_port` set to the FiveM server port means "serve there",
      // which is what happens anyway — so it must behave exactly like leaving it
      // unset, not like a broken listener. Binding it cannot work: FXServer
      // already owns that socket, so the attempt fails EADDRINUSE and a
      // perfectly reasonable-looking config produced a server with no door.
      //
      // Compared HERE rather than before `start()` because `netPort` is not
      // readable yet on a COLD BOOT — it reads "0" while FXServer is still
      // starting, and only a resource restart sees the real value. By the time a
      // bind has failed it is always readable.
      if (state === "failed" && cfg.port === Number.parseInt(fGetConvar("netPort", ""), 10)) {
        log(
          "info",
          "'tlib_http_port' is the FiveM server port, which already serves the hub — " +
            "no second listener is needed, and none was bound."
        );
        readiness.listener("disabled", null, null);
        return;
      }
      readiness.listener(state, localUrl, error);
    });
    router = bound;
    bound.start();
  }

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
    // `installed` rather than an identity check on the router: there may be no
    // router, and clearing it is what makes a handler from a previous lifetime
    // inert once this one has torn down.
    if (typeof stopped !== "string" || !installed) return;

    if (stopped === selfName) {
      // `Router.stop()` reports "stopped" itself. With no listener nothing else
      // would, and an outstanding IP detection would then land on a dead
      // lifetime and publish into it.
      if (router) router.stop();
      else readiness.listener("stopped");
      router = null;
      installed = false;
      clear();
      return;
    }

    unregisterResource(stopped);
  });
}
