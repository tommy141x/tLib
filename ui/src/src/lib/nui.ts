/**
 * NUI communication bridge for tLib.
 * Handles both FiveM NUI messages and Helix WebUI events.
 */

type NuiHandler<T = unknown> = (data: T) => void;

const handlers = new Map<string, NuiHandler[]>();

/** Register a handler for a NUI event from Lua */
export function onNuiEvent<T = unknown>(event: string, handler: NuiHandler<T>): void {
	if (!handlers.has(event)) handlers.set(event, []);
	handlers.get(event)!.push(handler as NuiHandler);
}

/** Send a callback response to Lua (FiveM NUI callback pattern) */
export async function fetchNui<T = unknown>(event: string, data?: unknown): Promise<T> {
	try {
		const resp = await fetch(`https://tLib/${event}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data ?? {}),
		});
		return await resp.json();
	} catch {
		return null as T;
	}
}

// FiveM NUI message listener
window.addEventListener("message", (e) => {
	const msg = e.data;
	if (!msg) return;

	// FiveM format: { name: string, args: [data] }
	if (msg.name && handlers.has(msg.name)) {
		const data = msg.args?.[0] ?? msg.data ?? msg;
		for (const fn of handlers.get(msg.name)!) fn(data);
		return;
	}

	// Legacy/direct format: { type: string, ... }
	if (msg.type && handlers.has(msg.type)) {
		for (const fn of handlers.get(msg.type)!) fn(msg);
	}
});
