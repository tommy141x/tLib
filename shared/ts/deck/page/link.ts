/**
 * The page's end of a Stream Deck link: it dials OUT to the plugin.
 *
 * ── Why this directory is not the vendored one ───────────────────────────────
 *
 * `shared/ts/deck/*.ts` is copied into all three Stream Deck plugins by each
 * product's `deck-render:sync`, which globs that directory non-recursively. This
 * file sits one level down precisely so it is NOT copied: it is DOM code, the
 * plugins compile against `@tsconfig/node20` with no `DOM` lib, and a vendored
 * copy of it would fail their typecheck while nothing imported it. Page bundles
 * are Vite, so they import it from `@tlib/shared` directly and need no copy.
 *
 * ── Direction ────────────────────────────────────────────────────────────────
 *
 * The plugin is the server and the page is the client, which is the opposite of
 * what it sounds like it should be. A page in FiveM's CEF — or in a dispatcher's
 * browser — cannot accept an inbound connection; the plugin is a long-lived Node
 * process and can listen. Entirely local: the game server is never involved.
 *
 * ── Keepalive, and the bug the whole design is for ───────────────────────────
 *
 * CEF throttles `setInterval` in a page that is not on screen, and once a page
 * has been hidden a few minutes it drops to about one wake-up per MINUTE. An
 * open WebSocket does not exempt it. This page is exactly that page whenever the
 * game window loses focus, and the dispatch panel can sit hidden in a tray for
 * hours. The plugin's watchdog then saw a silent peer and terminated the socket
 * under someone who was still using it, and a naive `onclose` released a key
 * they were still physically holding — a PA cut off mid-sentence.
 *
 * Three answers, and they fail independently:
 *
 *   1. The plugin sends WebSocket PING frames, which CEF answers in its network
 *      stack whatever the JS event loop is doing. That is the layer that
 *      survives throttling, and it lives on the plugin side.
 *   2. The application keepalive here is PIGGYBACKED on the event-driven
 *      `publish()` path, so a frozen interval is not the only thing keeping the
 *      socket alive. The interval is a floor for a genuinely idle page.
 *   3. A hold is not thrown away on a transport close. We reconnect at once and
 *      keep it for `holdGraceMs`; the deck key is still down, so its key-up
 *      arrives on the new socket and ends the action normally. If the plugin
 *      really is gone, the reconnect fails and the hold is released when the
 *      window expires. The mic is never left keyed.
 *
 * Layer 3 is OPT-IN, via `hasHold`/`releaseHolds`. A product with no hold-style
 * key passes neither and gets no grace machinery at all — tRadar's documented
 * choice, now expressed as configuration rather than as an absence that reads
 * like an oversight. Its reasoning holds: `xmit` latches and a struck fork
 * decays on its own timer, so there is no state a reconnect could strand, and
 * carrying the guard anyway would mean maintaining a defence against another
 * product's bug.
 */

import { KEEPALIVE_MS } from "../protocol.ts";

/**
 * The reconnect schedule: capped exponential backoff.
 *
 * Exported so the arithmetic can be checked exhaustively instead of by
 * stopwatch. Timing a real reconnect proves it came back; it does not prove the
 * delay doubled, and a backoff that silently degraded to a constant would pass
 * every behavioural test in the suite.
 *
 * The exponent is clamped before the cap so the doubling cannot overflow on a
 * link that has been retrying for days.
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
   *
   * Called only when a socket is actually open, so a player with the feature
   * off pays for a subscription and nothing else.
   */
  snapshot: () => TSnap | null;

  /**
   * Handle an inbound frame the link does not handle itself.
   *
   * Everything except `ping` and `pong` arrives here, because the plugin-to-page
   * vocabulary is product-owned: tELS and tRadio send `command`, tRadar also
   * sends `set`, and a link layer that filtered on `type === "command"` would
   * silently swallow the others. Discriminate on `type` inside.
   */
  onMessage: (message: Record<string, unknown>) => void;

  /**
   * Is something held that a dropped socket would strand?
   *
   * Supplying this (with `releaseHolds`) is what turns the hold-grace layer on.
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
   *
   * Capped exponential backoff, which is tRadar's, and it is the baseline
   * because it is strictly better than the flat 5 s tELS and tRadio used: a
   * game left running overnight next to a plugin that is not installed must not
   * hammer a closed port all night, and a plugin that has just started must not
   * wait a flat 5 s to be noticed.
   */
  reconnectCapMs?: number;

  /**
   * Skip a state push identical to the one before it. Default true.
   *
   * tRadio's, and worth having everywhere: these feeds re-publish on every
   * engine output, most of which do not change a single field the deck reads,
   * and each no-op push costs a socket write here plus a parse and a repaint
   * decision in the plugin. A skipped push still covers the keepalive.
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
   *
   * Off sends a `bye` so the plugin's keys go offline at once rather than
   * waiting out its 12 s watchdog on a socket that is never coming back.
   */
  setEnabled(on: boolean): void;
  /** True while the player has the link switched on. */
  isEnabled(): boolean;
  /** True while a socket is open. */
  isOpen(): boolean;
  /**
   * Push the current snapshot.
   *
   * Event-driven, which is also what makes it the application liveness signal:
   * a page that is drawing is a page proving it is alive. Pass `true` to send
   * even when nothing changed.
   */
  publish(force?: boolean): void;
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
   *
   * Both halves are required together: knowing something is held is no use
   * without a way to let go of it, and a `releaseHolds` that is never consulted
   * would be a release that never happens. Captured as a single pair so the two
   * cannot drift apart.
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

  const raw = (text: string): void => {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(text);
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
      // timer-driven, so use it to cover a keepalive the throttled interval
      // may have missed. This is the piggyback.
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
      // survived: the deck key is still down and its key-up will arrive here.
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
        // answer an application-level one too: a reply is inbound traffic for
        // it and costs nothing.
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
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      closeSocket();
    },
  };
}
