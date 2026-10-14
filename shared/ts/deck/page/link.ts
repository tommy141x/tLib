/**
 * The page's end of a Stream Deck link: it dials OUT to the plugin.
 *
 * Direction
 *
 * The plugin is the server and the page is the client, which is the opposite of
 * what it sounds like it should be. A page in FiveM's CEF — or in a dispatcher's
 * browser — cannot accept an inbound connection; the plugin is a long-lived Node
 * process and can listen. Entirely local: the game server is never involved.
 *
 * This file sits one level down from the vendored `deck/` directory so that
 * `deck-render:sync` does NOT copy it: it is DOM code, and the plugins compile
 * with no `DOM` lib.
 *
 * KEEPALIVE IS WHAT THE DESIGN IS FOR. CEF throttles `setInterval` in a hidden
 * page to about one wake-up a minute, and an open WebSocket does not exempt it,
 * so the plugin's watchdog saw a silent peer and terminated the socket under
 * someone still using it -- releasing a key they were physically holding, and
 * cutting a PA off mid-sentence. Three independent answers: the plugin sends
 * protocol-level PINGs (answered by CEF's network stack whatever the event loop
 * is doing), the application keepalive is PIGGYBACKED on `publish()` so a frozen
 * interval is not the only thing keeping the socket alive, and a hold is not
 * thrown away on a transport close -- it survives `holdGraceMs` while the socket
 * reconnects, so the deck's key-up arrives on the new socket.
 *
 * The hold layer is OPT-IN via `hasHold`/`releaseHolds`. A product with no
 * hold-style key gets no grace machinery, which is tRadar's documented choice.
 */

import { KEEPALIVE_MS } from "../protocol.ts";

/**
 * The reconnect schedule: capped exponential backoff. Exported so the arithmetic
 * can be checked exhaustively rather than by stopwatch -- timing a real reconnect
 * proves it came back, not that the delay doubled. The exponent is clamped before
 * the cap so the doubling cannot overflow on a link retrying for days.
 */
export function reconnectDelayFor(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 5));
}

/** Somewhere to put diagnostics. Defaults to `console`. */
export interface DeckLinkClientLogger {
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}

export interface DeckLinkClientOptions<TSnap extends object> {
  /** Loopback port. Take it from `DECK_PORTS`, never a literal. */
  port: number;

  /** This feed's name. Tags every frame so one plugin can host two feeds. */
  source: string;

  /**
   * Build the current snapshot, or null when there is nothing to send yet.
   */
  snapshot: () => TSnap | null;

  /**
   * Handle an inbound frame the link does not handle itself.
   */
  onMessage: (message: Record<string, unknown>) => void;

  /**
   * Is something held that a dropped socket would strand?
   */
  hasHold?: () => boolean;

  /** Put every held control back to rest. Required with `hasHold`. */
  releaseHolds?: () => void;

  /** How long a held key survives its socket dropping. Default 2500 ms. */
  holdGraceMs?: number;

  /** Application keepalive floor. Default `KEEPALIVE_MS`. */
  keepaliveMs?: number;

  /** First reconnect delay, doubling to `reconnectCapMs`. Default 1000 ms. */
  reconnectBaseMs?: number;

  /**
   * Reconnect ceiling. Default 30_000.
   */
  reconnectCapMs?: number;

  /**
   * Skip a state push identical to the one before it. Default true.
   */
  dedupe?: boolean;

  /** Open the socket immediately, without waiting for `setEnabled(true)`. */
  initiallyEnabled?: boolean;

  /** Defaults to `console`. */
  log?: DeckLinkClientLogger;
}

export interface DeckLinkClient {
  /**
   * Turn the link on or off.
   */
  setEnabled(on: boolean): void;
  /** True while the player has the link switched on. */
  isEnabled(): boolean;
  /** True while a socket is open. */
  isOpen(): boolean;
  /**
   * Push the current snapshot.
   */
  publish(force?: boolean): void;
  /**
   * Send one frame outside the snapshot path.
   */
  sendRaw(data: string | ArrayBuffer | ArrayBufferView): void;
  /** Tear everything down: timers, socket, holds. */
  dispose(): void;
}

export function createDeckLinkClient<TSnap extends object>(
  options: DeckLinkClientOptions<TSnap>
): DeckLinkClient {
  const {
    port,
    source,
    snapshot,
    onMessage,
    hasHold,
    releaseHolds,
    holdGraceMs = 2500,
    keepaliveMs = KEEPALIVE_MS,
    reconnectBaseMs = 1000,
    reconnectCapMs = 30_000,
    dedupe = true,
    initiallyEnabled = false,
    log = console,
  } = options;

  const url = `ws://127.0.0.1:${port}`;

  /**
   * Grace only exists when the product tracks holds.
   */
  const holdTracking =
    typeof hasHold === "function" && typeof releaseHolds === "function"
      ? { has: hasHold, release: releaseHolds }
      : null;
  const holding = (): boolean => holdTracking?.has() ?? false;
  const release = (): void => holdTracking?.release();

  let ws: WebSocket | null = null;
  let enabled = initiallyEnabled;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let holdGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastSent = "";
  let lastOutboundAt = 0;

  /** Any frame at all re-arms the plugin's watchdog, so track the clock. */
  const noteOutbound = (): void => {
    lastOutboundAt = Date.now();
  };

  const isOpen = (): boolean => ws != null && ws.readyState === WebSocket.OPEN;

  const raw = (data: string | ArrayBuffer | ArrayBufferView): void => {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      // The overloads differ by argument type, so narrow rather than widening
      // the call — `send` accepts both but TypeScript resolves one signature.
      if (typeof data === "string") sock.send(data);
      else if (data instanceof ArrayBuffer) sock.send(data);
      else sock.send(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
      noteOutbound();
    } catch {
      /* a failed write is a dead socket; onclose handles it */
    }
  };

  const ping = (): void => raw(JSON.stringify({ type: "ping", source }));

  const clearHoldGrace = (): void => {
    if (holdGraceTimer) clearTimeout(holdGraceTimer);
    holdGraceTimer = null;
  };

  const stopKeepalive = (): void => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };

  const publish = (force = false): void => {
    if (!isOpen()) return;
    const snap = snapshot();
    if (snap == null) return;
    const json = JSON.stringify({ type: "state", source, ...snap });
    if (dedupe && !force && json === lastSent) {
      // Nothing changed — but this call is event-driven rather than
      if (Date.now() - lastOutboundAt >= keepaliveMs) ping();
      return;
    }
    lastSent = json;
    raw(json);
  };

  const reconnectDelay = (): number => reconnectDelayFor(attempt, reconnectBaseMs, reconnectCapMs);

  const scheduleReconnect = (): void => {
    if (disposed || !enabled || reconnectTimer) return;
    const delay = reconnectDelay();
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect(): void {
    if (disposed || !enabled || ws) return;

    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      lastSent = "";
      noteOutbound();
      // A reconnect that lands inside the grace window means the hold
      clearHoldGrace();
      publish(true);
      keepaliveTimer = setInterval(() => {
        // Skip when a state push already spoke for us inside this window.
        if (Date.now() - lastOutboundAt < keepaliveMs) return;
        ping();
      }, keepaliveMs);
    };

    sock.onmessage = (ev) => {
      let msg: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(String(ev.data));
        if (parsed && typeof parsed === "object") msg = parsed as Record<string, unknown>;
      } catch {
        // A malformed frame is the plugin's problem, and silence is right:
        // see the note on the command branch for why it stops here.
        return;
      }
      if (!msg) return;

      if (msg.type === "ping") {
        // The plugin heartbeats with protocol-level ping frames today, but
        raw(JSON.stringify({ type: "pong", source }));
        return;
      }

      // Dispatch OUTSIDE the parse guard, with its own catch.
      //
      // This used to sit inside it in tRadio, so a throw anywhere in a command
      // — `getAudioManager()` during a PTT, say — was swallowed as "malformed
      // JSON": the deck key did nothing, nothing was logged, and it was
      // indistinguishable from the plugin never having sent. A parse error stays
      // silent, because a malformed frame is the plugin's problem; a handler that
      // throws is ours and gets said out loud.
      try {
        onMessage(msg);
      } catch (err) {
        const what = String(msg.command ?? msg.cmd ?? msg.action ?? msg.type ?? "?");
        log.error(`[deck-link] handling "${what}" failed:`, err);
      }
      // Push updated state right away — some fields are not reactive.
      publish(true);
    };

    // `onerror` is always followed by `onclose`, so reconnection is handled in
    // one place rather than raced between two handlers.
    sock.onerror = () => {};

    sock.onclose = () => {
      if (ws === sock) ws = null;
      stopKeepalive();

      const held = holding();
      if (held && !disposed && enabled && !holdGraceTimer) {
        // The one line that makes this diagnosable from a console. These
        // bridges logged nothing at all, which is why the original report of
        // a PTT cut short by a dropped socket had no evidence to work from.
        // Warn, not debug: a socket dying mid-transmission is always worth
        // seeing.
        log.warn(
          `[deck-link] socket closed while a hold was active — reconnecting; ` +
            `releasing in ${holdGraceMs}ms if it does not come back`
        );
        holdGraceTimer = setTimeout(() => {
          holdGraceTimer = null;
          log.warn("[deck-link] hold grace expired — releasing (plugin did not reconnect)");
          release();
        }, holdGraceMs);
        // One immediate retry, and one only: a refused connection to a closed
        // local port fails in a millisecond, so retrying on every onclose
        // would spin hundreds of times inside the grace window. Anything
        // after this falls back to the backoff cadence — the grace timer is
        // still set, so this branch is not re-entered.
        connect();
        if (!ws) scheduleReconnect();
        return;
      }

      if (!holdGraceTimer) release();
      scheduleReconnect();
    };
  }

  const closeSocket = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopKeepalive();
    // Turning the link off, or disposing, is deliberate rather than a blip:
    // release immediately and cancel any pending grace release.
    clearHoldGrace();
    release();
    const sock = ws;
    ws = null; // cleared first, so onclose cannot schedule a reconnect
    if (!sock) return;
    sock.onclose = null;
    if (sock.readyState === WebSocket.OPEN) {
      // A clean goodbye, so the plugin's keys go offline immediately rather
      // than waiting out a 12 s watchdog on a socket that is never coming back.
      try {
        sock.send(JSON.stringify({ type: "bye", source }));
      } catch {
        /* going away regardless */
      }
    }
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    lastSent = "";
  };

  if (initiallyEnabled) connect();

  return {
    setEnabled(on) {
      if (disposed || enabled === on) return;
      enabled = on;
      if (on) {
        attempt = 0;
        connect();
      } else {
        closeSocket();
      }
    },
    isEnabled: () => enabled,
    isOpen,
    publish,
    sendRaw: raw,
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      closeSocket();
    },
  };
}
