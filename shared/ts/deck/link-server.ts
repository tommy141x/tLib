/**
 * The plugin's end of a Stream Deck link: one WebSocket server on loopback.
 *
 * Every TIMMYG Studios product that talks to a Stream Deck had its own copy of
 * this file, and the copies had diverged into a set of fixes that never
 * travelled. This is the union of the best of each, with the differences that
 * are REAL turned into options and the ones that were accidents collapsed.
 *
 * Taken as the baseline, because they are strictly better:
 *
 *   • A BOUNDED bind budget (tRadar). tRadio retried a busy port forever and
 *     logged it at `warn`, so a port collision presented to the player as a
 *     plugin that simply never appeared, with nothing anywhere saying why.
 *   • Fault state HELD, not just emitted (tRadar, and tELS). A key that mounts
 *     after the bind failed has missed the event, and would otherwise render a
 *     perfectly normal "waiting for the game" — the most misleading thing it
 *     could say, because nothing is ever going to arrive.
 *   • Snapshots MERGED onto the product's offline defaults (tRadar, tRadio).
 *     tELS assigned the payload wholesale, so a snapshot missing a field the
 *     plugin knew about reached a draw function as `undefined`.
 *
 * Direction, and why it is this way round
 *
 * The plugin listens and the page dials out. That is not a preference: a page
 * running in FiveM's CEF (or a dispatcher's browser) cannot accept inbound
 * connections at all, while the plugin is a long-lived Node process that can.
 *
 * Liveness: three layers, because two of them fail on their own
 *
 *   1. A server-initiated WebSocket PING frame, from here. Browsers and CEF
 *      answer ping frames in the NETWORK stack whatever the JS event loop is
 *      doing, so this keeps a live peer marked online even when CEF has frozen
 *      the page's timers. This is the layer immune to throttling, and it is why
 *      the watchdog can be short without being trigger-happy.
 *   2. The page's own application-level keepalive, piggybacked on its state
 *      pushes. Any inbound frame re-arms the watchdog.
 *   3. Hold grace, which can only live on the PAGE side — only the page knows
 *      whether a key is still physically down. See `deck/page/link.ts`.
 *
 * No `@elgato/streamdeck` import, deliberately
 *
 * This module is vendored into three plugins and lives in a library that does
 * not depend on Elgato's SDK. Logging is INJECTED (`log`), which also happens to
 * be what makes the layer testable — and this layer had no socket-level test
 * anywhere, which is a large part of why the fixes above never travelled. See
 * `tLib/tests/integration/deck-link.test.ts`.
 */

import { createServer, type Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_MAX_BIND_ATTEMPTS,
  type InboundFrame,
  PING_MS,
  REBIND_MS,
  STALE_MS,
} from "./protocol.ts";

/** Just enough of a logger. Satisfied by `streamDeck.logger` as-is. */
export interface DeckLinkLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

/** A socket tagged with the source that owns it and its silence watchdog. */
type TaggedSocket = WebSocket & { _source?: string; _stale?: NodeJS.Timeout };

export interface DeckLinkServerOptions<TSnap, TSource extends string> {
  /** Loopback port. Take it from `DECK_PORTS`, never a literal. */
  port: number;

  /**
   * Every source this plugin can ever see, declared up front.
   *
   * Used so a bind failure can repaint keys for sources that have never
   * connected — the case that makes a fault visible to a key which mounted
   * before anything was listening.
   */
  sources: readonly TSource[];

  /** The all-dead snapshot for a source. Merged under every inbound state. */
  offlineFor: (source: TSource) => TSnap;

  /** Where this plugin's diagnostics go. `streamDeck.logger` fits as-is. */
  log: DeckLinkLogger;

  /** Source to assume when a state frame omits one. Back-compat for old pages. */
  defaultSource?: TSource;

  /**
   * Pull the snapshot fields out of a state frame.
   *
   * Defaults to the frame itself, which is right for the products that send
   * their fields FLAT. tELS nests its snapshot under `payload` and passes
   * `(frame) => frame.payload`. Either way the result is merged onto
   * `offlineFor(source)`, so the nesting difference stays a wire detail and
   * does not cost tELS the merge.
   */
  readSnapshot?: (frame: Record<string, unknown>) => unknown;

  /**
   * Render a fault into the handful of characters a 144px key can show.
   *
   * The default is deliberately terse. The long form goes to the log.
   */
  faultText?: (kind: "port-in-use" | "server-error", detail: string) => string;

  /**
   * Keep the last snapshot when a source disconnects, rather than reverting to
   * `offlineFor`.
   *
   * tELS does this: its keys switch to a dedicated "no feed" card, which
   * already says everything a blanked snapshot would, and keeping the values
   * means the card can still show what was last true. Default is to revert,
   * which is what tRadar and tRadio do.
   */
  keepSnapshotOnDisconnect?: boolean;

  /** Bind attempts before giving up. Default `DEFAULT_MAX_BIND_ATTEMPTS` (6). */
  maxBindAttempts?: number;
  /** Silence before a peer is dropped. Default `STALE_MS`. */
  staleMs?: number;
  /** Ping frame interval. Default `PING_MS`. */
  pingMs?: number;
  /** Delay between bind attempts. Default `REBIND_MS`. */
  rebindMs?: number;

  /**
   * Keep the process alive while this server is up.
   *
   * Default false, and false is what a plugin wants: `unref()`-ing the server,
   * its sockets and its timers ties the plugin's lifetime to its Stream Deck
   * host connection, so a reload makes the OLD process exit and free the port
   * instead of lingering as an orphan squatting on it. Tests set this true,
   * because an unref'd server does not hold a test runner open either.
   */
  keepProcessAlive?: boolean;
}

/** What the link tells its actions about. */
export interface DeckLinkServerEvents<TSnap, TSource extends string> {
  /** A source's snapshot or connected flag changed. */
  update: (source: TSource, snapshot: TSnap, connected: boolean) => void;
  /** The server gave up binding. Carries key-sized text. */
  fault: (text: string) => void;
  /** The server is bound. Carries the port actually in use. */
  listening: (port: number) => void;
}

export interface DeckLinkServer<TSnap, TSource extends string> {
  /** Latest snapshot for a source; offline defaults until one arrives. */
  stateOf(source: TSource): TSnap;
  /** True while a source has a live socket. */
  isConnected(source: TSource): boolean;
  /**
   * Why the link is unusable, or null while it is fine.
   *
   * Held as state, not merely emitted, so a late-mounting key can ask.
   */
  fault(): string | null;
  /** Push a message to a source's socket. True if it reached an open one. */
  send(source: TSource, message: object): boolean;
  /** Bind and start serving. Idempotent. */
  start(): void;
  /** Close the server and every socket, and stop retrying. Idempotent. */
  stop(): void;
  /** The bound port, or null while not listening. */
  boundPort(): number | null;
  on<K extends keyof DeckLinkServerEvents<TSnap, TSource>>(
    event: K,
    listener: DeckLinkServerEvents<TSnap, TSource>[K]
  ): void;
  off<K extends keyof DeckLinkServerEvents<TSnap, TSource>>(
    event: K,
    listener: DeckLinkServerEvents<TSnap, TSource>[K]
  ): void;
}

const defaultFaultText = (kind: "port-in-use" | "server-error", detail: string): string =>
  kind === "port-in-use" ? `PORT ${detail}\nIN USE` : "LINK ERROR";

export function createDeckLinkServer<TSnap, TSource extends string>(
  options: DeckLinkServerOptions<TSnap, TSource>
): DeckLinkServer<TSnap, TSource> {
  const {
    port,
    sources,
    offlineFor,
    log,
    defaultSource,
    readSnapshot,
    faultText = defaultFaultText,
    keepSnapshotOnDisconnect = false,
    maxBindAttempts = DEFAULT_MAX_BIND_ATTEMPTS,
    staleMs = STALE_MS,
    pingMs = PING_MS,
    rebindMs = REBIND_MS,
    keepProcessAlive = false,
  } = options;

  /** Hold the process open only when asked; see `keepProcessAlive`. */
  const unref = (h: { unref?: () => unknown } | null | undefined): void => {
    if (!keepProcessAlive) h?.unref?.();
  };

  type Entry = { ws: TaggedSocket | null; snap: TSnap };
  const bySource = new Map<TSource, Entry>();

  let started = false;
  let stopped = false;
  let attempts = 0;
  let faultReason: string | null = null;
  let activeServer: Server | null = null;
  let activeWss: WebSocketServer | null = null;
  let rebindTimer: NodeJS.Timeout | null = null;
  let listeningPort: number | null = null;
  /**
   * The ping interval, at CLOSURE scope rather than inside `listen()`.
   *
   * It was a local, so `stop()` could not reach it: a stopped server left an
   * interval walking an empty client set every `pingMs` for the life of the
   * process, and a start/stop cycle left one behind each time. Invisible in
   * production because it is `unref()`-ed and iterates nothing — and exactly
   * the shape that makes a test runner that calls `stop()` leak timers.
   */
  let heartbeat: NodeJS.Timeout | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  /* A minimal typed emitter
   * Rather than `node:events`, whose generic signatures differ between the
   * three products' TypeScript versions, and whose `error` event semantics are
   * a trap this layer has no use for.
   */
  type Events = DeckLinkServerEvents<TSnap, TSource>;
  const listeners: { [K in keyof Events]: Set<Events[K]> } = {
    update: new Set(),
    fault: new Set(),
    listening: new Set(),
  };
  const emit = <K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void => {
    for (const fn of [...listeners[event]]) {
      try {
        (fn as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (err) {
        // One action throwing in its repaint must not stop the others being
        // told, and must never reach the socket callback that started this.
        log.warn(`deck-link: listener for "${String(event)}" threw: ${String(err)}`);
      }
    }
  };

  const stateOf = (source: TSource): TSnap => bySource.get(source)?.snap ?? offlineFor(source);
  const isConnected = (source: TSource): boolean => bySource.get(source)?.ws != null;

  /** (Re)arm the "silent for staleMs" watchdog for a socket. */
  const armStale = (ws: TaggedSocket): void => {
    if (ws._stale) clearTimeout(ws._stale);
    ws._stale = setTimeout(() => {
      log.info(`deck-link: ${ws._source ?? "peer"} went silent — dropping`);
      ws.terminate();
    }, staleMs);
    unref(ws._stale);
  };

  /** Mark a source offline, but only if `ws` still owns it. */
  const setOffline = (source: TSource, ws: TaggedSocket): void => {
    const entry = bySource.get(source);
    if (entry && entry.ws !== ws) return; // an already-replaced socket
    const snap = keepSnapshotOnDisconnect
      ? (entry?.snap ?? offlineFor(source))
      : offlineFor(source);
    bySource.set(source, { ws: null, snap });
    log.info(`deck-link: ${source} disconnected`);
    emit("update", source, snap, false);
  };

  const onDisconnect = (ws: TaggedSocket): void => {
    if (ws._stale) clearTimeout(ws._stale);
    const source = (ws._source ?? defaultSource) as TSource | undefined;
    if (source) setOffline(source, ws);
  };

  const onMessage = (ws: TaggedSocket, text: string): void => {
    // Any message at all proves the peer is alive, a keepalive included.
    armStale(ws);

    let msg: InboundFrame<Record<string, unknown>> & Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn("deck-link: dropped malformed message");
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // `ping`/`pong` are liveness only — the watchdog is already re-armed.
    if (msg.type === "ping" || msg.type === "pong") return;

    if (msg.type === "bye") {
      const source = ((msg.source as TSource | undefined) ?? ws._source ?? defaultSource) as
        | TSource
        | undefined;
      if (source) setOffline(source, ws);
      return;
    }

    if (msg.type !== "state") return;

    const source = ((msg.source as TSource | undefined) ?? defaultSource) as TSource | undefined;
    if (!source) {
      log.warn("deck-link: state frame with no source and no default — dropped");
      return;
    }
    ws._source = source;

    // Latest socket wins. Two pages can briefly overlap on a UI reload or a
    // game restart, and the older one would otherwise keep overwriting the
    // newer one's state.
    const existing = bySource.get(source);
    if (existing?.ws && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      try {
        existing.ws.close();
      } catch {
        /* already going away */
      }
    }

    // Merged onto the offline defaults so a snapshot missing a field the
    // plugin knows about renders as that field's dead value rather than
    // reaching a draw function as `undefined`.
    const raw = readSnapshot ? readSnapshot(msg) : msg;
    const snap = { ...offlineFor(source), ...(raw as object) } as TSnap;
    bySource.set(source, { ws, snap });
    emit("update", source, snap, true);
  };

  const clearFault = (): void => {
    if (faultReason === null) return;
    faultReason = null;
    // Repaint out of the fault treatment using whatever is true now.
    for (const source of sources) emit("update", source, stateOf(source), isConnected(source));
  };

  const setFault = (keyText: string, logText: string): void => {
    faultReason = keyText;
    log.error(logText);
    emit("fault", keyText);
    // Re-announce every source as offline so keys already on screen repaint
    // into the fault treatment rather than sitting on a stale "waiting".
    // `sources` rather than just the connected ones, because the key this
    // exists for is precisely the one that has never seen a connection.
    const seen = new Set<TSource>();
    for (const source of [...bySource.keys(), ...sources]) {
      if (seen.has(source)) continue;
      seen.add(source);
      emit("update", source, offlineFor(source), false);
    }
  };

  const listen = (): void => {
    if (stopped) return;

    const server: Server = createServer();
    const wss = new WebSocketServer({ server });
    activeServer = server;
    activeWss = wss;
    // A retry builds a second server, so the previous attempt's interval has to
    // go even though the error path normally clears it.
    stopHeartbeat();
    // `ws` re-emits a listen error on BOTH the http server and the WSS, so
    // without this guard the same failure is handled twice.
    let handled = false;

    const onError = (err: NodeJS.ErrnoException): void => {
      if (handled) return;
      handled = true;
      stopHeartbeat();
      listeningPort = null;
      try {
        wss.close();
        server.close();
      } catch {
        /* already down */
      }
      if (stopped) return;

      if (err.code !== "EADDRINUSE") {
        setFault(faultText("server-error", err.message), `deck-link server error: ${err.message}`);
        return;
      }

      attempts += 1;
      if (attempts >= maxBindAttempts) {
        setFault(
          faultText("port-in-use", String(port)),
          `deck-link: port ${port} still busy after ${attempts} attempt(s) — giving up. ` +
            "Another plugin or a stale instance is holding it."
        );
        return;
      }
      log.warn(
        `deck-link: port ${port} busy (orphaned instance?) — ` +
          `retry ${attempts}/${maxBindAttempts} in ${rebindMs / 1000}s`
      );
      rebindTimer = setTimeout(listen, rebindMs);
      unref(rebindTimer);
    };

    server.on("error", onError);
    wss.on("error", onError);

    wss.on("connection", (ws: TaggedSocket, req) => {
      // A connected client must not hold the process open either, or a page
      // still connected would stop this instance exiting on reload.
      if (!keepProcessAlive) req.socket.unref?.();
      armStale(ws);
      ws.on("message", (raw) => onMessage(ws, raw.toString()));
      // A pong proves the peer is alive even when its JS timers are frozen.
      ws.on("pong", () => armStale(ws));
      ws.on("close", () => onDisconnect(ws));
      ws.on("error", (e) => log.warn(`deck-link socket error: ${e.message}`));
    });

    server.listen(port, "127.0.0.1", () => {
      // A successful bind clears the budget, so a plugin that recovers from a
      // transient failure is not left one stumble away from its own limit.
      attempts = 0;
      const addr = server.address();
      listeningPort = typeof addr === "object" && addr ? addr.port : port;
      clearFault();
      log.info(`deck-link listening on 127.0.0.1:${listeningPort}`);
      unref(server);
      emit("listening", listeningPort);
    });

    heartbeat = setInterval(() => {
      for (const client of wss.clients as Set<TaggedSocket>) {
        try {
          client.ping();
        } catch {
          /* dropping peers is the close handler's job */
        }
      }
    }, pingMs);
    unref(heartbeat);
  };

  return {
    stateOf,
    isConnected,
    fault: () => faultReason,
    send(source, message) {
      const ws = bySource.get(source)?.ws;
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(message));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    start() {
      if (started) return;
      started = true;
      stopped = false;
      // A restart gets the whole budget back. Without this a link that had
      // already given up stayed given-up: `attempts` was only ever reset by a
      // SUCCESSFUL bind, so `stop()` then `start()` spent its one remaining
      // attempt and re-faulted immediately — which is the opposite of what
      // restarting it means.
      attempts = 0;
      listen();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      listeningPort = null;
      if (rebindTimer) clearTimeout(rebindTimer);
      rebindTimer = null;
      stopHeartbeat();
      for (const entry of bySource.values()) {
        if (entry.ws?._stale) clearTimeout(entry.ws._stale);
        try {
          entry.ws?.terminate();
        } catch {
          /* going away regardless */
        }
      }
      try {
        for (const client of (activeWss?.clients ?? new Set()) as Set<TaggedSocket>) {
          if (client._stale) clearTimeout(client._stale);
          client.terminate();
        }
        activeWss?.close();
        activeServer?.close();
      } catch {
        /* already down */
      }
      activeWss = null;
      activeServer = null;
    },
    boundPort: () => listeningPort,
    on(event, listener) {
      listeners[event].add(listener);
    },
    off(event, listener) {
      listeners[event].delete(listener);
    },
  };
}
