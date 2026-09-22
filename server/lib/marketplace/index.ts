// Marketplace module entry. Called once from server/main.ts, and always eager:
// exports like mpRegisterType must exist before any consumer resource's Lua runs,
// and initializing from onResourceStart lost that race.

import { registerBridge } from "./bridge";
import { fOn } from "./fivem";
import { unregisterResource } from "./registry";

let installed = false;

export function installMarketplace(): void {
  if (installed) return;
  installed = true;
  registerBridge();

  // Drop registered install types for any resource that stops.
  fOn("onResourceStop", (stopped: unknown) => {
    if (typeof stopped !== "string") return;
    unregisterResource(stopped);
  });
}
