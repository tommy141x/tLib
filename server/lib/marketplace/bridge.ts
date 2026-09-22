// The FiveM exports the Lua side calls into. All install and HTTP work happens
// here on the Node runtime; server/sv_marketplace.lua wraps these with
// friendlier names and fires the consumer's onInstall callback.
//
// An async export takes a Lua callback as its last argument rather than
// returning a Promise, so no Lua consumer has to await userdata.

import * as fs from "node:fs";
import * as path from "node:path";
import { fExports, fGetCurrentResourceName, fGetResourcePath } from "./fivem";
import { installFromData, uninstallItem } from "./installer";
import { list as listTargets, register as registerTarget, unregisterResource } from "./registry";

let installed = false;

export function registerBridge(): void {
  if (installed) return;
  installed = true;

  //   exports.tLib:mpRegisterType(resourceName, type, installPath)
  //
  // Files are written into resourceName, at installPath relative to its root.
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

  // Lua writes the downloaded zip to a temp file and Node reads it back off
  // disk, which sidesteps the Lua→JS binary string encoding problem.
  // tmpRelPath is relative to the tLib resource root, e.g. '.tmp/install-x.zip'.
  fExports(
    "mpInstallFromFile",
    (
      resourceName: unknown,
      type: unknown,
      slug: unknown,
      tmpRelPath: unknown,
      expectedHash: unknown,
      expectedSize: unknown
    ) => {
      if (typeof resourceName !== "string" || !resourceName)
        return JSON.stringify({ ok: false, error: "resourceName required" });
      if (typeof type !== "string" || !type)
        return JSON.stringify({ ok: false, error: "type required" });
      if (typeof slug !== "string" || !slug)
        return JSON.stringify({ ok: false, error: "slug required" });
      if (typeof tmpRelPath !== "string" || !tmpRelPath)
        return JSON.stringify({ ok: false, error: "tmpRelPath required" });

      const tLibRoot = fGetResourcePath(fGetCurrentResourceName());
      if (!tLibRoot)
        return JSON.stringify({ ok: false, error: "could not resolve tLib resource path" });

      const fullPath = path.join(tLibRoot, tmpRelPath);
      let buf: Buffer;
      try {
        buf = fs.readFileSync(fullPath);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `could not read temp file: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          /* best-effort cleanup */
        }
      }

      const hash = typeof expectedHash === "string" ? expectedHash : "";
      const size = typeof expectedSize === "number" ? expectedSize : 0;
      return JSON.stringify(installFromData(resourceName, type, slug, buf, hash, size));
    }
  );

  // Sync: delete installed files for a slug. Returns JSON of UninstallOutcome.
  fExports("mpUninstall", (resourceName: unknown, type: unknown, slug: unknown) => {
    if (typeof resourceName !== "string" || !resourceName)
      return JSON.stringify({ ok: false, error: "resourceName required" });
    if (typeof type !== "string") return JSON.stringify({ ok: false, error: "type required" });
    if (typeof slug !== "string") return JSON.stringify({ ok: false, error: "slug required" });
    return JSON.stringify(uninstallItem(resourceName, type, slug));
  });
}
