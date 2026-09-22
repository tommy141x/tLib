// Community-configs module entry. Called once from server/main.ts, and eager
// for the same reason the marketplace module is: the `cc*` exports must exist
// before any consumer resource's Lua runs, and initialising from
// onResourceStart lost that race.

import { registerCommunityConfigsBridge } from "./bridge";

let installed = false;

export function installCommunityConfigs(): void {
  if (installed) return;
  installed = true;
  registerCommunityConfigsBridge();
}
