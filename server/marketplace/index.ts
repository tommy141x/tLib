// Marketplace module entry. Mirrors realtime/index.ts — tLib boots a
// passive scanner that only wires the bridge if a consumer resource
// declares `tlib_module { 'marketplace' }` in its fxmanifest.
//
// No HTTP is made until a consumer actually calls an mp* export. The bridge
// registration itself is cheap (just `exports(...)` calls) so even if we wire
// eagerly the cost is negligible.

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

function anyResourceRequests(): boolean {
	const self = fGetCurrentResourceName();
	const n = fGetNumResources();
	for (let i = 0; i < n; i++) {
		const res = fGetResourceByFindIndex(i);
		if (!res || res === self) continue;
		const count = fGetNumResourceMetadata(res, "tlib_module");
		for (let j = 0; j < count; j++) {
			if (fGetResourceMetadata(res, "tlib_module", j) === MODULE_NAME) return true;
		}
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
 * via `tlib_module { 'marketplace' }`. Hot-attach on later resource starts
 * mirrors the realtime module.
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
		const count = fGetNumResourceMetadata(started, "tlib_module");
		for (let j = 0; j < count; j++) {
			if (fGetResourceMetadata(started, "tlib_module", j) === MODULE_NAME) {
				install();
				return;
			}
		}
	});
}
