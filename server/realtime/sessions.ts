// sessions.ts — connection lifecycle, auth tokens, per-session rate limiting.

import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

export type SessionId = number;
export type PlayerId = number;

export type SessionState = "awaiting_auth" | "authed" | "closed";

export interface Session {
  id: SessionId;
  state: SessionState;
  ws: WebSocket;
  remoteAddr: string;
  playerId: PlayerId | null;
  connectedAt: number;
  authedAt: number | null;
  // rate limit buckets (refilled lazily on use)
  binBucket: TokenBucket;
  evtBucket: TokenBucket;
  // per-session room set; Room objects hold the reverse index
  rooms: Set<string>;
}

interface TokenRecord {
  token: string;
  playerId: PlayerId;
  expiresAt: number;
  // extra metadata the consumer may want to stash for later inspection
  meta?: Record<string, unknown>;
}

export interface TokenBucketSpec {
  capacity: number; // max tokens
  refillPerSec: number; // tokens added per second
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number
  ) {
    this.tokens = capacity;
    this.last = nowMs();
  }
  tryConsume(n = 1): boolean {
    const now = nowMs();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

function nowMs(): number {
  return Date.now();
}

export interface SessionManagerOptions {
  authTimeoutMs: number;
  tokenTtlMs: number;
  maxSessionsPerPlayer: number;
  binBucket: TokenBucketSpec;
  evtBucket: TokenBucketSpec;
  onAuthed?: (session: Session) => void;
  onClosed?: (session: Session, code: number, reason: string) => void;
}

export class SessionManager {
  private nextId = 1;
  private sessions = new Map<SessionId, Session>();
  private byPlayer = new Map<PlayerId, Set<SessionId>>();
  private tokens = new Map<string, TokenRecord>();
  private tokenSweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionManagerOptions) {
    // periodic cleanup of expired tokens
    this.tokenSweepTimer = setInterval(() => this.sweepTokens(), 30_000);
    this.tokenSweepTimer.unref?.();
  }

  // ---- token issuance (consumer calls this via Lua bridge) ----

  issueToken(
    playerId: PlayerId,
    meta?: Record<string, unknown>
  ): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString("hex");
    const expiresAt = nowMs() + this.opts.tokenTtlMs;
    this.tokens.set(token, { token, playerId, expiresAt, meta });
    return { token, expiresAt };
  }

  redeemToken(token: string): TokenRecord | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt < nowMs()) {
      this.tokens.delete(token);
      return null;
    }
    // one-shot — successful redeem consumes
    this.tokens.delete(token);
    return rec;
  }

  private sweepTokens() {
    const now = nowMs();
    for (const [t, rec] of this.tokens) {
      if (rec.expiresAt < now) this.tokens.delete(t);
    }
  }

  // ---- session lifecycle ----

  create(ws: WebSocket, remoteAddr: string): Session {
    const id = this.nextId++;
    const session: Session = {
      id,
      state: "awaiting_auth",
      ws,
      remoteAddr,
      playerId: null,
      connectedAt: nowMs(),
      authedAt: null,
      binBucket: new TokenBucket(this.opts.binBucket.capacity, this.opts.binBucket.refillPerSec),
      evtBucket: new TokenBucket(this.opts.evtBucket.capacity, this.opts.evtBucket.refillPerSec),
      rooms: new Set(),
    };
    this.sessions.set(id, session);

    // auth timeout
    setTimeout(() => {
      if (session.state === "awaiting_auth") {
        this.close(id, 4401, "auth timeout");
      }
    }, this.opts.authTimeoutMs).unref?.();

    return session;
  }

  authenticate(sessionId: SessionId, playerId: PlayerId): Session | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.state !== "awaiting_auth") return null;

    // enforce per-player session cap — oldest wins eviction
    const existing = this.byPlayer.get(playerId);
    if (existing && existing.size >= this.opts.maxSessionsPerPlayer) {
      const oldest = [...existing].sort((a, b) => {
        const sa = this.sessions.get(a);
        const sb = this.sessions.get(b);
        return (sa?.connectedAt ?? 0) - (sb?.connectedAt ?? 0);
      })[0];
      if (oldest != null) this.close(oldest, 4409, "replaced by newer session");
    }

    s.state = "authed";
    s.playerId = playerId;
    s.authedAt = nowMs();

    let set = this.byPlayer.get(playerId);
    if (!set) {
      set = new Set();
      this.byPlayer.set(playerId, set);
    }
    set.add(sessionId);

    this.opts.onAuthed?.(s);
    return s;
  }

  close(sessionId: SessionId, code = 1000, reason = ""): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.state === "closed") return;
    s.state = "closed";

    try {
      s.ws.close(code, reason);
    } catch {
      /* already dead */
    }

    this.sessions.delete(sessionId);
    if (s.playerId != null) {
      const set = this.byPlayer.get(s.playerId);
      if (set) {
        set.delete(sessionId);
        if (set.size === 0) this.byPlayer.delete(s.playerId);
      }
    }

    this.opts.onClosed?.(s, code, reason);
  }

  get(sessionId: SessionId): Session | undefined {
    return this.sessions.get(sessionId);
  }

  sessionsOf(playerId: PlayerId): Session[] {
    const ids = this.byPlayer.get(playerId);
    if (!ids) return [];
    const out: Session[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  count(): { total: number; authed: number; players: number } {
    let authed = 0;
    for (const s of this.sessions.values()) if (s.state === "authed") authed++;
    return { total: this.sessions.size, authed, players: this.byPlayer.size };
  }

  all(): IterableIterator<Session> {
    return this.sessions.values();
  }

  shutdown(): void {
    if (this.tokenSweepTimer) {
      clearInterval(this.tokenSweepTimer);
      this.tokenSweepTimer = null;
    }
    for (const id of [...this.sessions.keys()]) {
      this.close(id, 1001, "shutdown");
    }
    this.tokens.clear();
  }
}
