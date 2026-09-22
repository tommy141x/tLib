// The WebSocket server and message dispatcher, wiring SessionManager (lifecycle,
// tokens, rate limits) and RoomManager (membership, fan-out) to the protocol
// codec and the bridge hooks that carry events out to Lua.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { RealtimeConfig } from "./config";
import {
  decodeBinary,
  decodeText,
  encodeFanout,
  encodeText,
  OP,
  ProtocolError,
  TEXT_TYPE,
} from "./protocol";
import { RoomManager } from "./rooms";
import { type PlayerId, type Session, type SessionId, SessionManager } from "./sessions";

export interface BridgeHooks {
  /** Called after a session successfully authenticates. */
  onConnect(playerId: PlayerId, sessionId: SessionId, meta?: Record<string, unknown>): void;
  /** Called on socket close. */
  onDisconnect(playerId: PlayerId | null, sessionId: SessionId, code: number, reason: string): void;
  /** Called when an authed client sends a typed event. */
  onEvent(playerId: PlayerId, sessionId: SessionId, type: string, payload: unknown): void;
}

export interface Stats {
  sessions: { total: number; authed: number; players: number };
  rooms: { rooms: number; totalMemberships: number };
  uptimeMs: number;
}

export class RealtimeServer {
  private wss: WebSocketServer | null = null;
  private readonly sessions: SessionManager;
  private readonly rooms: RoomManager;
  private readonly startedAt = Date.now();

  constructor(
    private readonly cfg: RealtimeConfig,
    private readonly hooks: BridgeHooks,
    private readonly log: (level: "info" | "warn" | "error", msg: string) => void
  ) {
    this.sessions = new SessionManager({
      authTimeoutMs: cfg.authTimeoutMs,
      tokenTtlMs: cfg.tokenTtlMs,
      maxSessionsPerPlayer: cfg.maxSessionsPerPlayer,
      binBucket: { capacity: cfg.rateLimit.binBurst, refillPerSec: cfg.rateLimit.binFramesPerSec },
      evtBucket: { capacity: cfg.rateLimit.eventsBurst, refillPerSec: cfg.rateLimit.eventsPerSec },
      onAuthed: (s) => this.onSessionAuthed(s),
      onClosed: (s, code, reason) => this.onSessionClosed(s, code, reason),
    });

    this.rooms = new RoomManager({
      maxRoomsPerSession: cfg.maxRoomsPerSession,
      onMembershipChanged: (s, added, removed) => this.pushMembership(s, added, removed),
    });
  }

  // Binds no port: tLib owns exactly one external socket, the router in
  // server/http, and realtime is a mount on it at /rt. The router hands upgrades
  // on that path to handleUpgrade below.
  start(): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.cfg.maxPayloadBytes + 4096, // room id + overhead
      // Voice-like binary does not compress, and the CPU cost is real at 50Hz per
      // talker. A consumer that needs it can turn it back on.
      perMessageDeflate: false,
    });

    this.wss.on("error", (err) => {
      this.log("error", `wss error: ${err.message}`);
    });

    this.wss.on("connection", (ws, req) => {
      const addr = req.socket.remoteAddress ?? "?";
      const session = this.sessions.create(ws, addr);
      this.attach(session, ws);
    });
  }

  /** `start()` must already have run; getOrStart() guarantees that. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit("connection", ws, req);
    });
  }

  stop(): void {
    this.sessions.shutdown();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  issueToken(
    playerId: PlayerId,
    meta?: Record<string, unknown>
  ): { token: string; expiresAt: number } {
    return this.sessions.issueToken(playerId, meta);
  }

  setRooms(playerId: PlayerId, roomIds: string[]): void {
    for (const s of this.sessions.sessionsOf(playerId)) {
      if (s.state !== "authed") continue;
      this.rooms.setRooms(s, roomIds);
    }
  }

  getRooms(playerId: PlayerId): string[] {
    const out = new Set<string>();
    for (const s of this.sessions.sessionsOf(playerId)) {
      for (const r of s.rooms) out.add(r);
    }
    return [...out];
  }

  /** senderId 0 marks a publish as coming from the server itself. */
  publishServer(roomId: string, payload: Buffer): number {
    return this.fanout(roomId, /*fromSession*/ null, /*senderPlayerId*/ 0, payload);
  }

  sendEvent(playerId: PlayerId, type: string, payload: unknown): number {
    let count = 0;
    for (const s of this.sessions.sessionsOf(playerId)) {
      if (s.state !== "authed") continue;
      this.sendText(s, TEXT_TYPE.EVENT, { type, payload });
      count++;
    }
    return count;
  }

  broadcastEvent(
    roomId: string,
    type: string,
    payload: unknown,
    excludePlayerId?: PlayerId
  ): number {
    let count = 0;
    this.rooms.forEachMember(roomId, null, (sid) => {
      const s = this.sessions.get(sid);
      if (!s || s.state !== "authed") return;
      if (excludePlayerId != null && s.playerId === excludePlayerId) return;
      this.sendText(s, TEXT_TYPE.EVENT, { type, payload });
      count++;
    });
    return count;
  }

  kick(playerId: PlayerId, reason = "kicked"): number {
    let n = 0;
    for (const s of this.sessions.sessionsOf(playerId)) {
      this.sessions.close(s.id, 4000, reason);
      n++;
    }
    return n;
  }

  stats(): Stats {
    return {
      sessions: this.sessions.count(),
      rooms: this.rooms.stats(),
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  private attach(session: Session, ws: WebSocket): void {
    // HELLO goes out at once; the client has authTimeoutMs to answer with AUTH.
    this.sendText(session, TEXT_TYPE.HELLO, {
      v: 1,
      sessionId: session.id,
      now: Date.now(),
    });

    ws.on("message", (data, isBinary) => {
      if (session.state === "closed") return;
      try {
        if (isBinary) {
          this.handleBinary(session, data as Buffer);
        } else {
          const raw = typeof data === "string" ? data : (data as Buffer).toString("utf8");
          this.handleText(session, raw);
        }
      } catch (err) {
        const code = err instanceof ProtocolError ? err.code : "internal";
        const msg = err instanceof Error ? err.message : String(err);
        this.sendText(session, TEXT_TYPE.ERROR, { code, msg });
        if (err instanceof ProtocolError) {
          // App-level errors do not close the socket; only repeated abuse does.
        } else {
          this.log("error", `session ${session.id} handler crash: ${msg}`);
        }
      }
    });

    ws.on("close", (code, reasonBuf) => {
      this.sessions.close(session.id, code, reasonBuf?.toString("utf8") ?? "");
    });

    ws.on("error", (err) => {
      this.log("warn", `session ${session.id} ws error: ${err.message}`);
    });
  }

  private handleText(session: Session, raw: string): void {
    const env = decodeText(raw);

    if (session.state === "awaiting_auth") {
      if (env.t !== TEXT_TYPE.AUTH) {
        this.sessions.close(session.id, 4401, "auth required");
        return;
      }
      const token = (env.d as { token?: unknown } | null)?.token;
      if (typeof token !== "string" || token.length === 0) {
        this.sessions.close(session.id, 4400, "missing token");
        return;
      }
      const record = this.sessions.redeemToken(token);
      if (!record) {
        this.sessions.close(session.id, 4401, "invalid token");
        return;
      }
      const authed = this.sessions.authenticate(session.id, record.playerId);
      if (!authed) {
        this.sessions.close(session.id, 4401, "auth failed");
        return;
      }
      this.sendText(authed, TEXT_TYPE.AUTHED, {
        playerId: authed.playerId,
        sessionId: authed.id,
        rooms: [...authed.rooms],
      });
      this.hooks.onConnect(record.playerId, authed.id, record.meta);
      return;
    }

    switch (env.t) {
      case TEXT_TYPE.PING: {
        const n = (env.d as { n?: number } | null)?.n ?? 0;
        this.sendText(session, TEXT_TYPE.PONG, { n });
        break;
      }
      case TEXT_TYPE.EVENT: {
        if (!session.evtBucket.tryConsume()) {
          this.sendText(session, TEXT_TYPE.ERROR, {
            code: "rate_event",
            msg: "event rate limit",
          });
          return;
        }
        const d = env.d as { type?: unknown; payload?: unknown } | null;
        if (typeof d?.type !== "string") {
          throw new ProtocolError("bad_event", "event missing type");
        }
        this.hooks.onEvent(session.playerId as PlayerId, session.id, d.type, d.payload ?? null);
        break;
      }
      default:
        // Unknown types are ignored, for forward compatibility.
        break;
    }
  }

  private handleBinary(session: Session, buf: Buffer): void {
    if (session.state !== "authed") {
      this.sessions.close(session.id, 4401, "binary before auth");
      return;
    }
    const frame = decodeBinary(buf);
    if (frame.op !== OP.PUBLISH) {
      throw new ProtocolError("bad_opcode", "only PUBLISH is valid from client");
    }
    if (frame.payload.length > this.cfg.maxPayloadBytes) {
      throw new ProtocolError("too_big", `payload exceeds ${this.cfg.maxPayloadBytes}B`);
    }
    // Both drops are silent: a straggler after unsubscribe is harmless and would
    // spam the log, and answering a rate-limited sender with ERROR frames would
    // be DoS amplification.
    if (!session.rooms.has(frame.roomId)) return;
    if (!session.binBucket.tryConsume()) return;
    this.fanout(frame.roomId, session.id, session.playerId as PlayerId, frame.payload);
  }

  private fanout(
    roomId: string,
    fromSession: SessionId | null,
    senderPlayerId: PlayerId,
    payload: Buffer
  ): number {
    const out = encodeFanout(roomId, senderPlayerId, payload);
    let delivered = 0;
    this.rooms.forEachMember(roomId, fromSession, (sid) => {
      const s = this.sessions.get(sid);
      if (!s || s.state !== "authed") return;
      try {
        s.ws.send(out, { binary: true });
        delivered++;
      } catch {
        /* socket dead; the close handler cleans up */
      }
    });
    return delivered;
  }

  private sendText(session: Session, type: string, data: unknown): void {
    try {
      session.ws.send(encodeText(type, data));
    } catch (err) {
      this.log("warn", `sendText failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private pushMembership(session: Session, added: string[], removed: string[]): void {
    if (session.state !== "authed") return;
    this.sendText(session, TEXT_TYPE.SUB, { add: added, remove: removed });
  }

  private onSessionAuthed(_s: Session): void {
    // Reserved: onConnect fires from handleText, once the initial rooms are set.
  }

  private onSessionClosed(s: Session, code: number, reason: string): void {
    this.rooms.drop(s);
    this.hooks.onDisconnect(s.playerId, s.id, code, reason);
  }
}
