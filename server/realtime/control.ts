// control.ts — outbound WebSocket from this (customer) box to a remote brain.
//
// tLib realtime hosts a generic local pub/sub + rooms server (see server.ts).
// When a consumer resource (e.g. tRadio2) configures a control endpoint, we
// open a persistent WS upstream to it. The remote end (the brain) pushes
// rule/subscription updates down; we stream live-state events up.
//
// See tRadio2/radio-worker/PROTOCOL-CONTROL.md for the wire format. This
// module is generic — it doesn't know or care about channels, alerts, or
// permissions. It just relays JSON envelopes both ways.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import WebSocket from "ws";
import { fEmit, fOn } from "./fivem";

const EVT_RECV = "__tlib:rt:control:recv"; // wire → Lua (consumer reacts)
const EVT_STATE = "__tlib:rt:control:state"; // connection state changes for observability

type State = "idle" | "fetching-token" | "connecting" | "open" | "closed";

interface Envelope {
	t: string;
	d?: unknown;
	n?: number;
}

export interface ControlConfig {
	/** License key pasted into the customer's server.cfg convar. */
	license: string;
	/** Endpoint the customer hits to trade license → WS URL + auth token. */
	tokenEndpoint: string;
	/** Reconnect backoff caps, optional tuning. */
	reconnect?: {
		minMs?: number;
		maxMs?: number;
		factor?: number;
	};
}

interface TokenResponse {
	ok: boolean;
	token?: string;
	wsUrl?: string;
	expiresAt?: number;
	error?: string;
}

const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 45_000; // three missed pings

export class ControlClient {
	private ws: WebSocket | null = null;
	private state: State = "idle";
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private pingTimer: NodeJS.Timeout | null = null;
	private lastRecvAt = 0;

	private tokenExpiresAt = 0;
	private currentWsUrl: string | null = null;

	private readonly reconnectMin: number;
	private readonly reconnectMax: number;
	private readonly reconnectFactor: number;

	constructor(
		private readonly cfg: ControlConfig,
		private readonly log: (level: "info" | "warn" | "error", msg: string) => void,
	) {
		this.reconnectMin = cfg.reconnect?.minMs ?? 1_000;
		this.reconnectMax = cfg.reconnect?.maxMs ?? 30_000;
		this.reconnectFactor = cfg.reconnect?.factor ?? 2;
	}

	async start(): Promise<void> {
		if (this.state !== "idle" && this.state !== "closed") return;
		await this.connect();
	}

	stop(): void {
		this.clearTimers();
		this.state = "closed";
		if (this.ws) {
			try {
				this.ws.close(1000, "shutdown");
			} catch {
				/* ignore */
			}
			this.ws = null;
		}
		this.emitState();
	}

	/** Send an envelope upstream. No-op if not connected. */
	send(env: Envelope): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		try {
			this.ws.send(JSON.stringify(env));
			return true;
		} catch (err) {
			this.log("warn", `send failed: ${err instanceof Error ? err.message : err}`);
			return false;
		}
	}

	getState(): State {
		return this.state;
	}

	// ─── connect + reconnect ────────────────────────────────────────────

	private async connect(): Promise<void> {
		this.clearTimers();

		try {
			this.state = "fetching-token";
			this.emitState();
			const tokenResp = await this.fetchToken();
			if (!tokenResp.ok || !tokenResp.token || !tokenResp.wsUrl) {
				throw new Error(tokenResp.error ?? "token fetch failed");
			}
			this.tokenExpiresAt = tokenResp.expiresAt ?? Date.now() + 10 * 60 * 1000;
			this.currentWsUrl = tokenResp.wsUrl;

			this.state = "connecting";
			this.emitState();
			this.ws = new WebSocket(tokenResp.wsUrl);
			this.attachHandlers();
		} catch (err) {
			this.log("warn", `control connect failed: ${err instanceof Error ? err.message : err}`);
			this.scheduleReconnect();
		}
	}

	private fetchToken(): Promise<TokenResponse> {
		// CFX server sandbox has no global `fetch` and exposes natives
		// inconsistently — fall back to Node's http/https which `ws` already
		// depends on.
		return new Promise((resolve) => {
			let url: URL;
			try {
				url = new URL(this.cfg.tokenEndpoint);
			} catch (err) {
				resolve({ ok: false, error: `bad endpoint: ${err instanceof Error ? err.message : err}` });
				return;
			}
			const body = JSON.stringify({ license: this.cfg.license });
			const lib = url.protocol === "https:" ? https : http;
			const req = lib.request(
				{
					method: "POST",
					hostname: url.hostname,
					port: url.port || (url.protocol === "https:" ? 443 : 80),
					path: `${url.pathname}${url.search}`,
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							resolve({ ok: false, error: `HTTP ${status}: ${text.slice(0, 120)}` });
							return;
						}
						try {
							resolve(JSON.parse(text) as TokenResponse);
						} catch (err) {
							resolve({ ok: false, error: `bad json: ${err instanceof Error ? err.message : err}` });
						}
					});
				},
			);
			req.on("error", (err) => {
				resolve({ ok: false, error: err.message });
			});
			req.write(body);
			req.end();
		});
	}

	private attachHandlers(): void {
		if (!this.ws) return;

		this.ws.on("open", () => {
			this.state = "open";
			this.reconnectAttempts = 0;
			this.lastRecvAt = Date.now();
			this.log("info", "control connected");
			this.emitState();
			// greet
			this.send({
				t: "sys:hello",
				d: {
					v: 1,
					fivemVersion: (globalThis as unknown as { GetConvar?: (n: string, d: string) => string }).GetConvar?.(
						"version",
						"",
					) ?? undefined,
					resourceName: "tLib",
					bootedAt: Date.now(),
				},
			});
			this.startPingLoop();
		});

		this.ws.on("message", (raw) => {
			this.lastRecvAt = Date.now();
			if (typeof raw !== "string" && !(raw instanceof Buffer)) return;
			const text = typeof raw === "string" ? raw : raw.toString("utf8");
			let env: Envelope;
			try {
				env = JSON.parse(text);
			} catch {
				return;
			}
			if (typeof env?.t !== "string") return;

			// handle lifecycle locally; relay app-level envelopes to Lua
			if (env.t === "sys:welcome") return;
			if (env.t === "sys:pong") return;
			if (env.t === "sys:ping") {
				this.send({ t: "sys:pong", d: { echo: (env.d as { now?: number })?.now, now: Date.now() } });
				return;
			}

			// forward to consumer Lua so it can drive tlib.realtime:setRooms,
			// publish alerts, etc. Payload is serialized to JSON string — FiveM's
			// event bus flattens structured types unpredictably across resources.
			fEmit(EVT_RECV, env.t, JSON.stringify(env.d ?? null), env.n ?? 0);
		});

		this.ws.on("close", (code, reason) => {
			this.log("warn", `control closed ${code} ${reason?.toString() ?? ""}`);
			this.ws = null;
			this.clearTimers();
			this.state = "closed";
			this.emitState();
			this.scheduleReconnect();
		});

		this.ws.on("error", (err) => {
			this.log("warn", `control error: ${err.message}`);
		});
	}

	private startPingLoop(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
			if (Date.now() - this.lastRecvAt > PING_TIMEOUT_MS) {
				this.log("warn", "control heartbeat lost, reconnecting");
				try {
					this.ws.terminate();
				} catch {
					/* ignore */
				}
				return;
			}
			this.send({ t: "sys:ping", d: { now: Date.now() } });
		}, PING_INTERVAL_MS);
		this.pingTimer.unref?.();
	}

	private scheduleReconnect(): void {
		if (this.state === "closed" && this.stoppingIntentionally()) return;
		const delay = Math.min(
			this.reconnectMin * this.reconnectFactor ** this.reconnectAttempts,
			this.reconnectMax,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
		this.reconnectTimer.unref?.();
	}

	private stoppingIntentionally(): boolean {
		// An explicit stop() sets state to closed AND the timers are cleared.
		// If there's no pending reconnect timer and state is closed, we're shutting down.
		return this.reconnectTimer === null && this.state === "closed";
	}

	private clearTimers(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private emitState(): void {
		fEmit(EVT_STATE, this.state, this.currentWsUrl ?? "");
	}
}

// ─── module-level singleton ────────────────────────────────────────────
// Only one control connection per box — per the protocol, the brain evicts
// older peers for a license, and multiple licenses on one box isn't a thing.

let singleton: ControlClient | null = null;

export function startControl(cfg: ControlConfig, log: ControlClient["log"]): ControlClient {
	if (singleton) {
		log("warn", "control client already started; ignoring second startControl");
		return singleton;
	}
	singleton = new ControlClient(cfg, log);
	void singleton.start();
	return singleton;
}

export function stopControl(): void {
	if (singleton) {
		singleton.stop();
		singleton = null;
	}
}

export function getControl(): ControlClient | null {
	return singleton;
}

/** Listen for upstream envelopes (tRadio2 consumer Lua wires into this). */
export function onControlRecv(_handler: (type: string, dataJson: string, n: number) => void): void {
	// Consumers use the bridge's existing event bus to subscribe. This export
	// just documents the event name for clarity.
	fOn(EVT_RECV, _handler as unknown as (...args: unknown[]) => void);
}

export const CONTROL_EVENTS = {
	recv: EVT_RECV,
	state: EVT_STATE,
};
