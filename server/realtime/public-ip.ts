// public-ip.ts — one-shot discovery of the server's public IP.
//
// Fired at tLib boot. Consumers reading the wsUrl via rtConnectionInfo or
// rtIssueToken before the lookup completes get `ws://localhost:PORT` as a
// fallback — fine for dev, insufficient for remote players. Production logs
// a warning when the resolved IP lands so the operator sees the real URL.

import * as https from "node:https";

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Returns the cached public IP, or null if not yet known. */
export function getCachedIP(): string | null {
	return cached;
}

/** Kicks off resolution. Idempotent — subsequent calls return the same promise. */
export function resolvePublicIP(): Promise<string | null> {
	if (cached) return Promise.resolve(cached);
	if (inflight) return inflight;

	inflight = new Promise<string | null>((resolve) => {
		const req = https.get(
			"https://api.ipify.org",
			{ timeout: 5000 },
			(res) => {
				let body = "";
				res.on("data", (c) => {
					body += c;
				});
				res.on("end", () => {
					const ip = body.trim();
					cached = isPlausibleIP(ip) ? ip : null;
					resolve(cached);
				});
			},
		);
		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
	}).finally(() => {
		inflight = null;
	});

	return inflight;
}

function isPlausibleIP(s: string): boolean {
	if (!s || s.length > 45) return false;
	// trivial shape check; ipify returns raw ip
	return /^[0-9a-fA-F:.]+$/.test(s);
}
