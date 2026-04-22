// Registers FiveM exports that the Lua side of tLib and consumer resources
// invoke. All install/HTTP work happens here on the Node runtime; the Lua
// facade in /lua/marketplace/server.lua wraps these with friendlier names
// and fires the consumer's onInstall callback.
//
// Async exports take a Lua callback as their final argument rather than
// returning a Promise — Lua consumers shouldn't need to await userdata.

import { getItem, listItems } from "./api";
import { fExports } from "./fivem";
import { installItem } from "./installer";
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

	// Async: browse items. Invokes cb(jsonString). On error cb({ ok: false, error }).
	// paramsJson is a JSON string with optional { type, search, cursor, limit }.
	fExports("mpList", (paramsJson: unknown, cb: unknown) => {
		const callback = safeCallback(cb);
		if (!callback) return;
		const params = typeof paramsJson === "string" && paramsJson ? safeParse(paramsJson) : {};
		listItems(params)
			.then((r) => callback(JSON.stringify({ ok: true, data: r })))
			.catch((e) => callback(errorPayload(e)));
	});

	fExports("mpGetItem", (slug: unknown, cb: unknown) => {
		const callback = safeCallback(cb);
		if (!callback) return;
		if (typeof slug !== "string" || !slug) {
			callback(errorPayload(new Error("slug required")));
			return;
		}
		getItem(slug)
			.then((r) => callback(JSON.stringify({ ok: true, data: r })))
			.catch((e) => callback(errorPayload(e)));
	});

	// Async: download + install. Callback receives JSON of InstallOutcome.
	fExports("mpInstall", (type: unknown, slug: unknown, version: unknown, cb: unknown) => {
		const callback = safeCallback(cb);
		if (!callback) return;
		if (typeof type !== "string") {
			callback(JSON.stringify({ ok: false, error: "type required" }));
			return;
		}
		if (typeof slug !== "string") {
			callback(JSON.stringify({ ok: false, error: "slug required" }));
			return;
		}
		if (typeof version !== "string") {
			callback(JSON.stringify({ ok: false, error: "version required" }));
			return;
		}
		installItem(type, slug, version)
			.then((outcome) => callback(JSON.stringify(outcome)))
			.catch((e) => callback(errorPayload(e)));
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
