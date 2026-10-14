/**
 * The one outbound POST. Clients report to this server; this server talks to the
 * website, and nothing else does. One sender, one request in flight, a doubling
 * breaker, and refusals that retrying cannot fix stop for the session. The
 * ingest authenticates with `TLIB_PUBLIC_KEY`; what distinguishes senders is
 * `x-install-id`, not the key.
 * Design notes: docs/internal/telemetry-wire-contract.md.
 */

import { INSTALL_ID_HEADER } from "../../../shared/ts/install-id";
import { TLIB_PUBLIC_KEY } from "../../../shared/ts/marketplace/catalogue";
import { ANALYTICS_PATH, type AnalyticsBatchBody } from "../../../shared/ts/telemetry/payload";
import { TELEMETRY_KEY_CONVAR } from "./consent";
import { fGetConvar, fPerformHttpRequest } from "./fivem";
import type { QueuedEvent, Store } from "./store";

/** Three in a row before the breaker opens. */
export const FAILURES_BEFORE_OPEN = 3;

/** First cooldown. Doubles per re-open, capped. */
export const BREAKER_BASE_COOLDOWN_MS = 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 3_600_000;

/** How long one request may stay open before it is treated as failed. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** How often the flusher runs. */
export const FLUSH_INTERVAL_MS = 60_000;

export type TransportVerdict =
  | "sent"
  | "empty"
  | "disabled"
  | "no-credential"
  | "breaker-open"
  | "in-flight"
  | "failed"
  | "permanent";

interface Breaker {
  consecutiveFailures: number;
  openUntil: number;
  cooldownMs: number;
  /** Set once a refusal arrives that retrying cannot fix. Never cleared. */
  permanentlyStopped: string | null;
  inFlight: boolean;
}

function newBreaker(): Breaker {
  return {
    consecutiveFailures: 0,
    openUntil: 0,
    cooldownMs: BREAKER_BASE_COOLDOWN_MS,
    permanentlyStopped: null,
    inFlight: false,
  };
}

export interface TransportOptions {
  store: Store;
  /** `StudioApi.baseUrl()`'s answer. Read per flush — the convar is a dev switch. */
  baseUrl: () => string;
  /** `consent.resolve().enabled`. Asked on EVERY flush. */
  enabled: () => boolean;
  /** The per-install id, stamped onto every event's dimensions. */
  installId: () => string;
  /** Overridable for the suite. */
  now?: () => number;
  post?: PostFn;
  log?: (line: string) => void;
  /**
   * The bearer token. Defaults to `TLIB_PUBLIC_KEY`, with `tlib_telemetry_key`
   * overriding it for a dev run. A seam so a suite can reach the
   * `no-credential` branch, which the real value never produces.
   */
  credential?: () => string;
}

export type PostFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
  done: (status: number, body: string, headers: Record<string, string>) => void
) => void;

/** `PerformHttpRequest`, wrapped so a suite can substitute it. */
export const performPost: PostFn = (url, body, headers, done) => {
  let settled = false;
  const finish = (status: number, text: string, h: Record<string, string>) => {
    if (settled) return;
    settled = true;
    done(status, text, h);
  };
  // A timeout is mandatory and `PerformHttpRequest` has none: a callback that
  // never fires would leave `inFlight` true for the life of the server, with the
  // queue still filling and nothing saying why.
  const timer = setTimeout(() => finish(0, "timeout", {}), REQUEST_TIMEOUT_MS);
  try {
    fPerformHttpRequest(
      url,
      (status, text, responseHeaders) => {
        clearTimeout(timer);
        finish(status, text, responseHeaders ?? {});
      },
      "POST",
      body,
      headers
    );
  } catch (e) {
    clearTimeout(timer);
    finish(0, e instanceof Error ? e.message : String(e), {});
  }
};

function credential(): string {
  let override = "";
  try {
    override = fGetConvar(TELEMETRY_KEY_CONVAR, "").trim();
  } catch {
    override = "";
  }
  return override || TLIB_PUBLIC_KEY;
}

function retryAfterMs(headers: Record<string, string>): number {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const seconds = Number(v);
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.min(seconds * 1000, BREAKER_MAX_COOLDOWN_MS);
  }
  return 0;
}

export interface Transport {
  /** Never throws, never blocks on a response. */
  flush(): { events: TransportVerdict };
  start(): void;
  stop(): void;
  state(): { events: Breaker };
}

/**
 * `credential()` always resolves, so there is no `hasCredential()` and no
 * `provisioned` state -- both were unconditionally true. The `no-credential`
 * verdict below is a different thing and guards the injected seam.
 */

export function createTransport(opts: TransportOptions): Transport {
  const now = opts.now ?? (() => Date.now());
  const post = opts.post ?? performPost;
  const log = opts.log ?? (() => {});
  const readCredential = opts.credential ?? credential;
  const breaker = newBreaker();
  let timer: ReturnType<typeof setInterval> | null = null;

  function onSuccess(b: Breaker): void {
    b.consecutiveFailures = 0;
    b.openUntil = 0;
    b.cooldownMs = BREAKER_BASE_COOLDOWN_MS;
  }

  function onFailure(
    b: Breaker,
    label: string,
    status: number,
    headers: Record<string, string>
  ): void {
    b.consecutiveFailures += 1;
    const explicit = retryAfterMs(headers);
    if (b.consecutiveFailures >= FAILURES_BEFORE_OPEN || explicit > 0) {
      const wait = explicit > 0 ? explicit : b.cooldownMs;
      b.openUntil = now() + wait;
      // Doubled AFTER the wait is chosen, so the first open uses the base
      // cooldown rather than twice it.
      b.cooldownMs = Math.min(b.cooldownMs * 2, BREAKER_MAX_COOLDOWN_MS);
      log(
        `[tLib] diagnostics ${label} sink unreachable (HTTP ${status}); pausing for ${Math.round(wait / 1000)}s`
      );
    }
  }

  /** Refusals no amount of retrying fixes. */
  function permanentReason(status: number): string | null {
    if (status === 401) return "the ingest credential was refused (401)";
    if (status === 403) return "the ingest credential lacks the analytics:ingest scope (403)";
    if (status === 404) return "the endpoint does not exist (404)";
    return null;
  }

  function flushEvents(): TransportVerdict {
    const b = breaker;
    if (b.permanentlyStopped) return "permanent";
    if (!opts.enabled()) return "disabled";
    const key = readCredential();
    if (!key) return "no-credential";
    if (b.inFlight) return "in-flight";
    if (now() < b.openUntil) return "breaker-open";

    const batch = opts.store.takeEvents();
    if (batch.length === 0) return "empty";

    const install = opts.installId();
    /**
     * The ring's losses are read but not sent: the contract declares no
     * measure slot, and an unread counter grows for the life of the server.
     * They are said out loud on the server console instead.
     */
    const drops = opts.store.readDrops();
    if (drops > 0) {
      log(
        `[tLib] diagnostics queue dropped ${drops} event(s) to stay bounded — the sink was ` +
          "unreachable or one client flooded. The feed has a gap of that size."
      );
    }
    const body: AnalyticsBatchBody = {
      senderKind: "server",
      events: batch.map((e: QueuedEvent) => ({
        event: e.event,
        at: e.at,
        // `installId` is tWeb's dimension name. Stamped here so the twelve
        // senders cannot each get it wrong independently.
        dimensions: install ? { ...e.dimensions, installId: install } : e.dimensions,
        measures: e.measures,
        // A SIBLING of `dimensions`, never inside it: the charset would refuse
        // it there and the refusal would cost the whole event.
        ...(e.stack !== undefined ? { stack: e.stack } : {}),
      })),
    };

    b.inFlight = true;
    post(
      `${opts.baseUrl()}${ANALYTICS_PATH}`,
      JSON.stringify(body),
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        // The id travels as a header as well as a dimension, deliberately: the
        // header is what tWeb filters and mutes on before reading a body.
        ...(install ? { [INSTALL_ID_HEADER]: install } : {}),
      },
      (status, _text, headers) => {
        b.inFlight = false;
        if (status >= 200 && status < 300) {
          onSuccess(b);
          return;
        }
        const permanent = permanentReason(status);
        if (permanent) {
          b.permanentlyStopped = permanent;
          log(`[tLib] diagnostics disabled for this session: ${permanent}`);
          // Dropped rather than returned: a batch nothing will ever accept is a
          // queue that can never drain.
          return;
        }
        opts.store.returnEvents(batch);
        onFailure(b, "analytics", status, headers);
      }
    );
    return "sent";
  }

  const flush = (): { events: TransportVerdict } => ({ events: flushEvents() });

  return {
    flush,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          flush();
        } catch (e) {
          // An interval callback that throws in FiveM's Node runtime is an
          // unhandled error on the console every minute.
          log(`[tLib] diagnostics flush threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, FLUSH_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    state() {
      return { events: breaker };
    },
  };
}
