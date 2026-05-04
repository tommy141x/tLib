// Marketplace module entry. Mirrors realtime/index.ts — tLib boots a
// passive scanner that only wires the bridge if a consumer resource
// declares `tlib_module { 'marketplace' }` (singular) or includes
// 'marketplace' in `tlib_modules { ... }` (plural array) in its fxmanifest.

import { registerBridge } from "./bridge";
import {
  fGetCurrentResourceName,
  fGetNumResourceMetadata,
  fGetNumResources,
  fGetResourceByFindIndex,
  fGetResourceMetadata,
  fOn,
} from "./fivem";
import { unregisterResource } from "./registry";

const MODULE_NAME = "marketplace";

/** Check both `tlib_module` (singular) and `tlib_modules` (plural array). */
function resourceRequestsMarketplace(res: string): boolean {
  for (const key of ["tlib_module", "tlib_modules"]) {
    const count = fGetNumResourceMetadata(res, key);
    for (let j = 0; j < count; j++) {
      if (fGetResourceMetadata(res, key, j) === MODULE_NAME) return true;
    }
  }
  return false;
}

function anyResourceRequests(): boolean {
  const self = fGetCurrentResourceName();
  const n = fGetNumResources();
  for (let i = 0; i < n; i++) {
    const res = fGetResourceByFindIndex(i);
    if (!res || res === self) continue;
    if (resourceRequestsMarketplace(res)) return true;
  }
  return false;
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  registerBridge();

  // Drop registered install types for any resource that stops.
  fOn("onResourceStop", (stopped: unknown) => {
    if (typeof stopped !== "string") return;
    unregisterResource(stopped);
  });
}

/**
 * Called once from server/main.ts. No-op unless a consumer resource opts in
 * via `tlib_module { 'marketplace' }` or `tlib_modules { ..., 'marketplace', ... }`.
 * Hot-attach on later resource starts mirrors the realtime module.
 */
export function installMarketplace(): void {
  if (anyResourceRequests()) {
    install();
    return;
  }

  fOn("onResourceStart", (started: unknown) => {
    if (installed || typeof started !== "string") return;
    const self = fGetCurrentResourceName();
    if (started === self) return;
    if (resourceRequestsMarketplace(started)) {
      install();
    }
  });
}
