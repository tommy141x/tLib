/**
 * Browser-side client for the realtime protocol. Rooms are opaque strings and
 * typed events are `type` + arbitrary JSON, so this module carries no app
 * vocabulary. Connect, auth, heartbeat, reconnect and SUB tracking are handled
 * internally; a consumer supplies credentials and receives events.
 *
 * The constants below mirror `tLib/server/realtime/protocol.ts` v1 and change
 * with it.
 */

const OP_PUBLISH = 0x01;
const OP_FRAME = 0x02;

const TT = {
  HELLO: "hello",
  AUTH: "auth",
  AUTHED: "authed",
  PING: "ping",
  PONG: "pong",
  EVENT: "event",
  SUB: "sub",
  ERROR: "error",
} as const;

const MAX_ROOM_ID_BYTES = 255;

export type RealtimeState = "idle" | "connecting" | "authing" | "open" | "closing" | "closed";

export interface RealtimeConnectOptions {
  /** `ws://host:port` from the customer server's session-mint response. */
  url: string;
  /** Short-lived token from tLib's `issueToken` Lua export. One-shot. */
  token: string;
  /** Default true. Exponential backoff between the two bounds below. */
  autoReconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** PING interval; default 15 000 ms, 0 disables. */
  heartbeatMs?: number;
  /** Auth handshake ceiling; default 5 000 ms, matching the server. */
  authTimeoutMs?: number;
  /**
   * Mints a fresh token for the next reconnect. Tokens are one-shot, so
   * without this auto-reconnect can only ever replay a spent one and fail.
   */
  onTokenRefresh?: () => Promise<string>;
}

export interface RealtimeFrame {
  roomId: string;
  /** Server ID of the publisher. `0` when the server itself fan-outs. */
  senderId: number;
  /** Raw payload bytes. Not copied — do not retain beyond the handler. */
  payload: Uint8Array;
}

export interface RealtimeClient {
  connect(opts: RealtimeConnectOptions): Promise<void>;
  disconnect(code?: number, reason?: string): void;

  state(): RealtimeState;
  /** `null` until `AUTHED`. */
  myPlayerId(): number | null;
  myRooms(): string[];
  isInRoom(roomId: string): boolean;

  sendEvent(type: string, payload?: unknown): void;
  /** Returns an unsubscribe. */
  onEvent<T = unknown>(type: string, handler: (payload: T) => void): () => void;
  onAnyEvent(handler: (type: string, payload: unknown) => void): () => void;

  /**
   * Fans out to every other member of the room, not back to the sender.
   * Dropped silently when not a member or the socket is not open.
   */
  publish(roomId: string, payload: ArrayBufferView | ArrayBuffer): void;
  onFrame(handler: (frame: RealtimeFrame) => void): () => void;

  onStateChange(handler: (state: RealtimeState) => void): () => void;
  onRoomsChange(handler: (rooms: string[]) => void): () => void;
  onError(handler: (code: string, msg: string) => void): () => void;
}

type EventHandler = (payload: unknown) => void;

export function createRealtimeClient(): RealtimeClient {
  let ws: WebSocket | null = null;
  let state: RealtimeState = "idle";
  let playerId: number | null = null;
  let rooms = new Set<string>();
  let opts: RealtimeConnectOptions | null = null;
  let currentToken: string | null = null;
  let pingSeq = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let manuallyDisconnected = false;
  let authResolve: (() => void) | null = null;
  let authReject: ((err: Error) => void) | null = null;

  const typedEventHandlers = new Map<string, EventHandler[]>();
  const anyEventHandlers: Array<(type: string, payload: unknown) => void> = [];
  const frameHandlers: Array<(frame: RealtimeFrame) => void> = [];
  const stateHandlers: Array<(state: RealtimeState) => void> = [];
  const roomsHandlers: Array<(rooms: string[]) => void> = [];
  const errorHandlers: Array<(code: string, msg: string) => void> = [];

  function setState(next: RealtimeState): void {
    if (state === next) return;
    state = next;
    for (const h of stateHandlers) {
      try {
        h(state);
      } catch (err) {
        console.error("[realtime] stateHandler threw:", err);
      }
    }
  }

  function emitRoomsChanged(): void {
    const snapshot = Array.from(rooms);
    for (const h of roomsHandlers) {
      try {
        h(snapshot);
      } catch (err) {
        console.error("[realtime] roomsHandler threw:", err);
      }
    }
  }

  function emitError(code: string, msg: string): void {
    for (const h of errorHandlers) {
      try {
        h(code, msg);
      } catch (err) {
        console.error("[realtime] errorHandler threw:", err);
      }
    }
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearAuthTimer(): void {
    if (authTimer !== null) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function sendText<T>(type: string, data: T): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ t: type, d: data }));
    } catch (err) {
      console.warn("[realtime] sendText failed:", err);
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    const ms = opts?.heartbeatMs ?? 15_000;
    if (ms <= 0) return;
    heartbeatTimer = setInterval(() => {
      pingSeq = (pingSeq + 1) | 0;
      sendText(TT.PING, { n: pingSeq });
    }, ms);
  }

  const utf8enc = new TextEncoder();
  const utf8dec = new TextDecoder("utf-8", { fatal: false });

  function encodePublishBytes(roomId: string, payload: Uint8Array): ArrayBuffer {
    const roomBytes = utf8enc.encode(roomId);
    if (roomBytes.length === 0 || roomBytes.length > MAX_ROOM_ID_BYTES) {
      throw new Error(`roomId must be 1..${MAX_ROOM_ID_BYTES} bytes`);
    }
    const out = new Uint8Array(2 + roomBytes.length + payload.length);
    out[0] = OP_PUBLISH;
    out[1] = roomBytes.length;
    out.set(roomBytes, 2);
    out.set(payload, 2 + roomBytes.length);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  function decodeBinary(buf: ArrayBuffer): RealtimeFrame | null {
    const view = new Uint8Array(buf);
    if (view.length < 2) return null;
    const op = view[0];
    const roomLen = view[1];
    if (roomLen === 0 || view.length < 2 + roomLen) return null;
    const roomId = utf8dec.decode(view.subarray(2, 2 + roomLen));
    const rest = 2 + roomLen;

    if (op === OP_FRAME) {
      if (view.length < rest + 4) return null;
      const dv = new DataView(buf, view.byteOffset + rest, 4);
      const senderId = dv.getUint32(0, /* littleEndian */ true);
      return { roomId, senderId, payload: view.subarray(rest + 4) };
    }
    return null;
  }

  function handleText(raw: string): void {
    let env: { t?: string; d?: unknown } | null = null;
    try {
      env = JSON.parse(raw) as { t?: string; d?: unknown };
    } catch {
      emitError("bad_text", "non-JSON text frame");
      return;
    }
    if (!env || typeof env.t !== "string") {
      emitError("bad_text", "missing envelope 't'");
      return;
    }

    switch (env.t) {
      case TT.HELLO:
        if (currentToken) sendText(TT.AUTH, { token: currentToken });
        return;

      case TT.AUTHED: {
        const d = env.d as { playerId?: number; rooms?: string[] } | null;
        playerId = typeof d?.playerId === "number" ? d.playerId : null;
        const roomSnapshot = Array.isArray(d?.rooms) ? (d.rooms as string[]) : [];
        rooms = new Set(roomSnapshot);
        clearAuthTimer();
        setState("open");
        emitRoomsChanged();
        reconnectAttempt = 0;
        startHeartbeat();
        if (authResolve) {
          authResolve();
          authResolve = null;
          authReject = null;
        }
        return;
      }

      case TT.SUB: {
        const d = env.d as { add?: string[]; remove?: string[] } | null;
        if (!d) return;
        let changed = false;
        if (Array.isArray(d.add)) {
          for (const r of d.add) {
            if (typeof r === "string" && !rooms.has(r)) {
              rooms.add(r);
              changed = true;
            }
          }
        }
        if (Array.isArray(d.remove)) {
          for (const r of d.remove) {
            if (typeof r === "string" && rooms.delete(r)) {
              changed = true;
            }
          }
        }
        if (changed) emitRoomsChanged();
        return;
      }

      case TT.EVENT: {
        const d = env.d as { type?: string; payload?: unknown } | null;
        if (!d || typeof d.type !== "string") return;
        dispatchEvent(d.type, d.payload);
        return;
      }

      case TT.PING:
        sendText(TT.PONG, env.d ?? {});
        return;

      case TT.PONG:
        return;

      case TT.ERROR: {
        const d = env.d as { code?: string; msg?: string } | null;
        const code = typeof d?.code === "string" ? d.code : "unknown";
        const msg = typeof d?.msg === "string" ? d.msg : "";
        emitError(code, msg);
        return;
      }
    }
  }

  function dispatchEvent(type: string, payload: unknown): void {
    const list = typedEventHandlers.get(type);
    if (list) {
      // Copy first so a handler that unsubscribes doesn't skew the loop.
      const snapshot = list.slice();
      for (const h of snapshot) {
        try {
          h(payload);
        } catch (err) {
          console.error(`[realtime] event handler "${type}" threw:`, err);
        }
      }
    }
    for (const h of anyEventHandlers) {
      try {
        h(type, payload);
      } catch (err) {
        console.error(`[realtime] any-event handler threw for "${type}":`, err);
      }
    }
  }

  function handleBinary(buf: ArrayBuffer): void {
    const frame = decodeBinary(buf);
    if (!frame) return;
    for (const h of frameHandlers) {
      try {
        h(frame);
      } catch (err) {
        console.error("[realtime] frame handler threw:", err);
      }
    }
  }

  async function openSocket(): Promise<void> {
    if (!opts) throw new Error("connect() was not called");
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    setState("connecting");
    const socket = new WebSocket(opts.url);
    socket.binaryType = "arraybuffer";
    ws = socket;

    const authTimeoutMs = opts.authTimeoutMs ?? 5_000;
    const authDone = new Promise<void>((resolve, reject) => {
      authResolve = resolve;
      authReject = reject;
      authTimer = setTimeout(() => {
        if (state !== "open") {
          reject(new Error("auth timeout"));
        }
      }, authTimeoutMs);
    });

    socket.addEventListener("open", () => {
      setState("authing");
      // HELLO arrives first and handleText answers it. A proxy may buffer it,
      // and the auth timer covers a server that never sends it at all.
    });

    socket.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        handleText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        handleBinary(ev.data);
      }
    });

    socket.addEventListener("close", (ev) => {
      clearHeartbeat();
      clearAuthTimer();
      if (authReject) {
        authReject(new Error(`closed before auth (code=${ev.code})`));
        authReject = null;
        authResolve = null;
      }
      setState("closed");
      if (!manuallyDisconnected && (opts?.autoReconnect ?? true)) {
        scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // The 'close' that follows handles state and reconnect.
      emitError("socket", "websocket error");
    });

    await authDone;
  }

  function scheduleReconnect(): void {
    if (!opts) return;
    clearReconnectTimer();
    reconnectAttempt += 1;
    const min = opts.reconnectMinMs ?? 1_000;
    const max = opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** (reconnectAttempt - 1));
    reconnectTimer = setTimeout(async () => {
      if (manuallyDisconnected) return;
      try {
        if (opts?.onTokenRefresh) {
          currentToken = await opts.onTokenRefresh();
        }
        await openSocket();
      } catch {
        // Let the close handler arm the next attempt.
      }
    }, delay);
  }

  async function connect(connectOpts: RealtimeConnectOptions): Promise<void> {
    opts = connectOpts;
    currentToken = connectOpts.token;
    manuallyDisconnected = false;
    reconnectAttempt = 0;
    await openSocket();
  }

  function disconnect(code = 1000, reason = "client disconnect"): void {
    manuallyDisconnected = true;
    clearReconnectTimer();
    clearHeartbeat();
    clearAuthTimer();
    if (ws) {
      setState("closing");
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
      ws = null;
    }
    playerId = null;
    rooms.clear();
    setState("closed");
    emitRoomsChanged();
  }

  function publish(roomId: string, payload: ArrayBufferView | ArrayBuffer): void {
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== "open") return;
    if (!rooms.has(roomId)) return; // server would silently drop anyway
    const bytes =
      payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    try {
      const frame = encodePublishBytes(roomId, bytes);
      ws.send(frame);
    } catch (err) {
      console.warn("[realtime] publish failed:", err);
    }
  }

  function onEvent<T = unknown>(type: string, handler: (payload: T) => void): () => void {
    let list = typedEventHandlers.get(type);
    if (!list) {
      list = [];
      typedEventHandlers.set(type, list);
    }
    list.push(handler as EventHandler);
    return () => {
      const current = typedEventHandlers.get(type);
      if (!current) return;
      const idx = current.indexOf(handler as EventHandler);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) typedEventHandlers.delete(type);
    };
  }

  function subscribeList<T>(list: T[], h: T): () => void {
    list.push(h);
    return () => {
      const idx = list.indexOf(h);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  return {
    connect,
    disconnect,
    state: () => state,
    myPlayerId: () => playerId,
    myRooms: () => Array.from(rooms),
    isInRoom: (roomId) => rooms.has(roomId),

    sendEvent: (type, payload) => sendText(TT.EVENT, { type, payload: payload ?? null }),
    onEvent,
    onAnyEvent: (h) => subscribeList(anyEventHandlers, h),

    publish,
    onFrame: (h) => subscribeList(frameHandlers, h),

    onStateChange: (h) => subscribeList(stateHandlers, h),
    onRoomsChange: (h) => subscribeList(roomsHandlers, h),
    onError: (h) => subscribeList(errorHandlers, h),
  };
}
