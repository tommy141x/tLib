/**
 * tLib realtime — iframe / browser-side client.
 *
 * Speaks the wire protocol defined in `tLib/server/realtime/protocol.ts`
 * (v1). The Node server on the customer's FiveM box hosts this. Any
 * browser-embedded app (radio iframe, dispatch panel, CAD console, pager,
 * intercom — anything that needs rooms + typed events + binary fan-out)
 * imports this client.
 *
 * Consumer responsibilities end at "here are my credentials, here's the
 * room membership I want, please deliver my events". The client handles
 * connect / auth / heartbeat / reconnect / SUB tracking transparently.
 *
 * This module has no radio (or CAD, or pager) vocabulary. Rooms are opaque
 * strings; typed events are `type` + arbitrary JSON payload.
 */

// ─── Protocol constants (mirror of server/realtime/protocol.ts) ──────────
// Keep these values in sync with tLib/server/realtime/protocol.ts. If the
// protocol ever bumps to v2, both sides change together.

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

// ─── Public types ────────────────────────────────────────────────────────

export type RealtimeState = "idle" | "connecting" | "authing" | "open" | "closing" | "closed";

export interface RealtimeConnectOptions {
  /** `ws://host:port` from the customer server's session-mint response. */
  url: string;
  /** Short-lived token from tLib's `issueToken` Lua export. One-shot. */
  token: string;
  /**
   * Reconnect automatically when the socket closes unexpectedly. On by
   * default. Exponential backoff between `reconnectMinMs` and
   * `reconnectMaxMs`. Set to `false` to opt into manual reconnection.
   */
  autoReconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /**
   * How often to send PING text frames. Server echoes with PONG. Default
   * 15 000 ms. Set to 0 to disable.
   */
  heartbeatMs?: number;
  /**
   * Hard ceiling for the auth handshake. Default 5 000 ms — matches the
   * server default.
   */
  authTimeoutMs?: number;
  /**
   * Called when the client MUST re-fetch a token to reconnect (e.g. the
   * old token was consumed and a new session needs to be minted). Return
   * a fresh token; the client will plug it into the next reconnect.
   *
   * If omitted, reconnects reuse the original token — which will fail
   * (tokens are one-shot), so auto-reconnect becomes useless. Production
   * integrations should always supply this.
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
  // Lifecycle ─────────────────────────────────────────────────────────────
  connect(opts: RealtimeConnectOptions): Promise<void>;
  disconnect(code?: number, reason?: string): void;

  /** Current connection state. */
  state(): RealtimeState;
  /** Player ID assigned by the server. `null` until `AUTHED`. */
  myPlayerId(): number | null;
  /** Current room membership as a snapshot array. */
  myRooms(): string[];
  /** Whether a given room is currently in the membership set. */
  isInRoom(roomId: string): boolean;

  // Typed events ──────────────────────────────────────────────────────────
  /** Send an app-level typed event. No reply. */
  sendEvent(type: string, payload?: unknown): void;
  /** Subscribe to one event type. Returns an unsubscribe. */
  onEvent<T = unknown>(type: string, handler: (payload: T) => void): () => void;
  /** Subscribe to every typed event. Useful for logging / debugging. */
  onAnyEvent(handler: (type: string, payload: unknown) => void): () => void;

  // Binary fan-out ────────────────────────────────────────────────────────
  /**
   * Publish a binary payload to a room. The server fans out to every other
   * member (not back to the sender). Silently dropped if the sender isn't
   * a member of the room or the socket isn't open.
   */
  publish(roomId: string, payload: ArrayBufferView | ArrayBuffer): void;
  /** Receive binary frames from any room. */
  onFrame(handler: (frame: RealtimeFrame) => void): () => void;

  // State observers ───────────────────────────────────────────────────────
  onStateChange(handler: (state: RealtimeState) => void): () => void;
  onRoomsChange(handler: (rooms: string[]) => void): () => void;
  onError(handler: (code: string, msg: string) => void): () => void;
}

// ─── Implementation ──────────────────────────────────────────────────────

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

  // Listener maps
  const typedEventHandlers = new Map<string, EventHandler[]>();
  const anyEventHandlers: Array<(type: string, payload: unknown) => void> = [];
  const frameHandlers: Array<(frame: RealtimeFrame) => void> = [];
  const stateHandlers: Array<(state: RealtimeState) => void> = [];
  const roomsHandlers: Array<(rooms: string[]) => void> = [];
  const errorHandlers: Array<(code: string, msg: string) => void> = [];

  // ─── Helpers ───────────────────────────────────────────────────────────

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

  // ─── Binary codec (ArrayBuffer flavour; protocol.ts uses Node Buffer) ──

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
    // Return as ArrayBuffer (WebSocket.send accepts both, but ArrayBuffer
    // is the cleanest cross-browser type).
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
      // u32 LE senderId
      const dv = new DataView(buf, view.byteOffset + rest, 4);
      const senderId = dv.getUint32(0, /* littleEndian */ true);
      return { roomId, senderId, payload: view.subarray(rest + 4) };
    }
    // Only FRAME opcodes should reach the iframe (PUBLISH is outbound).
    return null;
  }

  // ─── Message handlers ──────────────────────────────────────────────────

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
        // Server announces itself; respond with AUTH. Auth timer was
        // already armed when we opened the socket.
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
        reconnectAttempt = 0; // successful auth resets backoff
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
        // Server-initiated ping — echo back.
        sendText(TT.PONG, env.d ?? {});
        return;

      case TT.PONG:
        // Ignored. We send PINGs; PONGs are liveness confirmations.
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

  // ─── Connect / reconnect ───────────────────────────────────────────────

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
      // Server sends HELLO first; we respond to AUTH inside handleText.
      // Some proxies buffer HELLO for a few ms; the auth timer handles
      // a server that never actually emits it.
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
      // The 'close' event that follows will handle state + reconnect.
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
    const delay = Math.min(max, min * Math.pow(2, reconnectAttempt - 1));
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

  // ─── Public API ────────────────────────────────────────────────────────

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
    const bytes = payload instanceof ArrayBuffer
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
