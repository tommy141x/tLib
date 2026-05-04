// Registers FiveM exports that the Lua side of tLib and consumer resources
// invoke. All install/HTTP work happens here on the Node runtime; the Lua
// facade in /lua/marketplace/server.lua wraps these with friendlier names
// and fires the consumer's onInstall callback.
//
// Async exports take a Lua callback as their final argument rather than
// returning a Promise — Lua consumers shouldn't need to await userdata.

import * as fs from "node:fs";
import * as path from "node:path";
import { fExports, fGetCurrentResourceName, fGetResourcePath } from "./fivem";
import { installFromData, uninstallItem } from "./installer";
import { list as listTargets, register as registerTarget, unregisterResource } from "./registry";

let installed = false;

type LuaCallback = (result: string) => void;

function safeCallback(cb: unknown): LuaCallback | null {
  return typeof cb === "function" ? (cb as LuaCallback) : null;
}

function errorPayload(e: unknown): string {
  return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
}

export function registerBridge(): void {
  if (installed) return;
  installed = true;

  // Register an install type. Called by consumer resources on boot.
  //
  //   exports.tLib:mpRegisterType(resourceName, type, installPath)
  //
  // resourceName identifies the resource the files will be written into;
  // installPath is relative to that resource's root (e.g., "client/radios").
  fExports("mpRegisterType", (resourceName: unknown, type: unknown, installPath: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    if (typeof type !== "string" || !type) return false;
    if (typeof installPath !== "string" || !installPath) return false;
    registerTarget({ resourceName, type, installPath });
    return true;
  });

  // Called by Lua when a consumer resource stops — drops its registered types.
  fExports("mpUnregisterResource", (resourceName: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    unregisterResource(resourceName);
    return true;
  });

  // Synchronously returns a JSON string of registered types, for diagnostics.
  fExports("mpListTypes", () => JSON.stringify(listTargets()));

  // Sync: Lua writes the downloaded zip to a temp file (bypassing the
  // Lua→JS binary string encoding issue), Node.js reads it from disk.
  // tmpRelPath is relative to the tLib resource root (e.g. '.tmp/install-x.zip').
  fExports("mpInstallFromFile", (resourceName: unknown, type: unknown, slug: unknown, tmpRelPath: unknown, expectedHash: unknown, expectedSize: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return JSON.stringify({ ok: false, error: "resourceName required" });
    if (typeof type !== "string" || !type) return JSON.stringify({ ok: false, error: "type required" });
    if (typeof slug !== "string" || !slug) return JSON.stringify({ ok: false, error: "slug required" });
    if (typeof tmpRelPath !== "string" || !tmpRelPath) return JSON.stringify({ ok: false, error: "tmpRelPath required" });

    const tLibRoot = fGetResourcePath(fGetCurrentResourceName());
    if (!tLibRoot) return JSON.stringify({ ok: false, error: "could not resolve tLib resource path" });

    const fullPath = path.join(tLibRoot, tmpRelPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(fullPath);
    } catch (err) {
      return JSON.stringify({ ok: false, error: `could not read temp file: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      try { fs.unlinkSync(fullPath); } catch { /* best-effort cleanup */ }
    }

    const hash = typeof expectedHash === "string" ? expectedHash : "";
    const size = typeof expectedSize === "number" ? expectedSize : 0;
    return JSON.stringify(installFromData(resourceName, type, slug, buf, hash, size));
  });

  // Sync: delete installed files for a slug. Returns JSON of UninstallOutcome.
  fExports("mpUninstall", (resourceName: unknown, type: unknown, slug: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return JSON.stringify({ ok: false, error: "resourceName required" });
    if (typeof type !== "string") return JSON.stringify({ ok: false, error: "type required" });
    if (typeof slug !== "string") return JSON.stringify({ ok: false, error: "slug required" });
    return JSON.stringify(uninstallItem(resourceName, type, slug));
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const p = JSON.parse(s);
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
