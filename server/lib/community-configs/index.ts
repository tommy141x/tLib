// Community-configs module entry. Called once from server/main.ts, and eager
// for the same reason ../marketplace/index.ts is.

import { registerCommunityConfigsBridge } from "./bridge";

let installed = false;

export function installCommunityConfigs(): void {
  if (installed) return;
  installed = true;
  registerCommunityConfigsBridge();
}
