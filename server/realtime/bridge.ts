// bridge.ts — binds the Node-side RealtimeServer to FiveM's event/export surface.
//
// Consumer Lua NEVER calls these exports directly — the imports/realtime/server.lua
// facade wraps them so the consumer-facing API is pure imports.
//
// exports (Lua -> Node, synchronous):
//   rtIssueToken(playerId, metaJson?)      -> { token, expiresAt, wsUrl }
//   rtSetRooms(playerId, roomIds)          -> void
//   rtGetRooms(playerId)                   -> roomIds[]
//   rtKick(playerId, reason?)              -> number (sessions closed)
//   rtPublishServer(roomId, payloadString) -> number (recipients)
//   rtSendEvent(playerId, type, payload)   -> number (sessions reached)
//   rtBroadcastEvent(roomId, type, payload, excludePlayerId?) -> number
//   rtStats()                              -> stats object
//
// events (Node -> Lua, asynchronous broadcast):
//   __tlib:rt:connect    (playerId, sessionId, metaJson)
//   __tlib:rt:disconnect (playerId, sessionId, code, reason)
//   __tlib:rt:event      (playerId, sessionId, type, payload)
//
// Consumer imports/realtime/server.lua:
//   - calls the rt* exports for sync ops
//   - AddEventHandler's __tlib:rt:* for async pushes
//   - presents tlib.realtime:* as pure import-style API

import { composeWsUrl, type RealtimeConfig } from "./config";
import { getControl, startControl, stopControl } from "./control";
import { fEmit, fExports } from "./fivem";
import { getCachedIP } from "./public-ip";
import type { RealtimeServer } from "./server";

const EVT_CONNECT = "__tlib:rt:connect";
const EVT_DISCONNECT = "__tlib:rt:disconnect";
const EVT_EVENT = "__tlib:rt:event";

export function registerBridge(getServer: () => RealtimeServer, cfg: RealtimeConfig): void {
  const currentWsUrl = () => composeWsUrl(cfg.publicUrlOverride, getCachedIP(), cfg.port);

  // ---- exports ----
  // Each of these triggers WS server startup via getServer() on first call,
  // so tLib doesn't open a port unless a consumer actually uses realtime.

  fExports("rtIssueToken", (playerId: unknown, meta?: unknown) => {
    const pid = toPlayerId(playerId);
    if (pid == null) return null;
    const metaObj = parseMeta(meta);
    const { token, expiresAt } = getServer().issueToken(pid, metaObj);
    return { token, expiresAt, wsUrl: currentWsUrl() };
  });

  fExports("rtSetRooms", (playerId: unknown, roomIds: unknown) => {
    const pid = toPlayerId(playerId);
    if (pid == null) return;
    const rooms = normaliseRoomIds(roomIds);
    getServer().setRooms(pid, rooms);
  });

  fExports("rtGetRooms", (playerId: unknown) => {
    const pid = toPlayerId(playerId);
    if (pid == null) return [];
    return getServer().getRooms(pid);
  });

  fExports("rtKick", (playerId: unknown, reason?: unknown) => {
    const pid = toPlayerId(playerId);
    if (pid == null) return 0;
    return getServer().kick(pid, typeof reason === "string" ? reason : "kicked");
  });

  fExports("rtPublishServer", (roomId: unknown, payload: unknown) => {
    if (typeof roomId !== "string" || roomId.length === 0) return 0;
    const buf = toBuffer(payload);
    if (!buf) return 0;
    return getServer().publishServer(roomId, buf);
  });

  fExports("rtSendEvent", (playerId: unknown, type: unknown, payload: unknown) => {
    const pid = toPlayerId(playerId);
    if (pid == null || typeof type !== "string") return 0;
    return getServer().sendEvent(pid, type, payload ?? null);
  });

  fExports(
    "rtBroadcastEvent",
    (roomId: unknown, type: unknown, payload: unknown, excludePid?: unknown) => {
      if (typeof roomId !== "string" || typeof type !== "string") return 0;
      const excl = excludePid == null ? undefined : (toPlayerId(excludePid) ?? undefined);
      return getServer().broadcastEvent(roomId, type, payload ?? null, excl);
    }
  );

  fExports("rtStats", () => getServer().stats());

  fExports("rtConnectionInfo", () => ({ wsUrl: currentWsUrl(), port: cfg.port, host: cfg.host }));

  // ── control client (outbound to CF brain) ────────────────────────────

  fExports("rtStartControl", (licenseIn: unknown, tokenEndpointIn: unknown) => {
    if (typeof licenseIn !== "string" || licenseIn.length === 0)
      return { ok: false, error: "license" };
    if (typeof tokenEndpointIn !== "string" || tokenEndpointIn.length === 0)
      return { ok: false, error: "tokenEndpoint" };
    startControl({ license: licenseIn, tokenEndpoint: tokenEndpointIn }, (level, msg) => {
      const prefix = "[tLib/realtime/control]";
      if (level === "error") console.error(`${prefix} ${msg}`);
      else if (level === "warn") console.warn(`${prefix} ${msg}`);
      else console.log(`${prefix} ${msg}`);
    });
    return { ok: true };
  });

  fExports("rtStopControl", () => {
    stopControl();
    return { ok: true };
  });

  fExports("rtSendControl", (type: unknown, dataJson: unknown, correlation?: unknown) => {
    const c = getControl();
    if (!c) return { ok: false, error: "not started" };
    if (typeof type !== "string") return { ok: false, error: "type" };
    let d: unknown = null;
    if (typeof dataJson === "string" && dataJson.length > 0) {
      try {
        d = JSON.parse(dataJson);
      } catch {
        return { ok: false, error: "bad json" };
      }
    }
    const n = typeof correlation === "number" ? correlation : undefined;
    const sent = c.send({ t: type, d, n });
    return { ok: sent };
  });

  fExports("rtControlState", () => ({ state: getControl()?.getState() ?? "idle" }));
}

/** BridgeHooks for RealtimeServer's constructor — Node-side push events. */
export function makeEmitHooks() {
  return {
    onConnect(playerId: number, sessionId: number, meta?: Record<string, unknown>) {
      fEmit(EVT_CONNECT, playerId, sessionId, meta ? JSON.stringify(meta) : null);
    },
    onDisconnect(playerId: number | null, sessionId: number, code: number, reason: string) {
      fEmit(EVT_DISCONNECT, playerId ?? 0, sessionId, code, reason);
    },
    onEvent(playerId: number, sessionId: number, type: string, payload: unknown) {
      fEmit(EVT_EVENT, playerId, sessionId, type, payload);
    },
  };
}

// ---- arg coercion ----

function toPlayerId(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x) && x > 0) return Math.floor(x);
  if (typeof x === "string") {
    const n = Number.parseInt(x, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseMeta(x: unknown): Record<string, unknown> | undefined {
  if (x == null) return undefined;
  if (typeof x === "object") return x as Record<string, unknown>;
  if (typeof x === "string" && x.length > 0) {
    try {
      const p = JSON.parse(x);
      return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normaliseRoomIds(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) {
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

function toBuffer(x: unknown): Buffer | null {
  if (x == null) return null;
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === "string") return Buffer.from(x, "binary");
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return null;
}
