/**
 * The one outbound POST. Clients report to this server; this server talks to the
 * website, and nothing else does. One sender, one request in flight, a doubling
 * breaker, and refusals that retrying cannot fix stop for the session. The
 * ingest authenticates with `TLIB_ANALYTICS_KEY` below.
 * Design notes: docs/internal/telemetry-wire-contract.md.
 */

import { INSTALL_ID_HEADER } from "../../../shared/ts/install-id";
import { ANALYTICS_PATH, type AnalyticsBatchBody } from "../../../shared/ts/telemetry/payload";
import { TELEMETRY_KEY_CONVAR } from "./consent";
import { fGetConvar, fPerformHttpRequest } from "./fivem";
import type { QueuedEvent, Store } from "./store";

/** Three in a row before the breaker opens. */
export const FAILURES_BEFORE_OPEN = 3;

/** First cooldown. Doubles per re-open, capped. */
export const BREAKER_BASE_COOLDOWN_MS = 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 3_600_000;

/**
 * Consecutive no-response failures before the sender stops for the session.
 *
 * A refusal tells us retrying is pointless; a connection that never completes
 * tells us nothing, so before this the breaker just kept doubling and logged one
 * line an hour for the life of the server. Ten, against the doubling cooldown, is
 * a little over two hours of trying — long enough to ride out an ingest outage,
 * short enough that a server firewalled outbound stops talking about it.
 */
export const UNREACHABLE_FAILURES_BEFORE_STOP = 10;

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
  /** Separate count: only failures where no HTTP response arrived at all. */
  consecutiveUnreachable: number;
  openUntil: number;
  cooldownMs: number;
  /** Set once a refusal arrives that retrying cannot fix. Never cleared. */
  permanentlyStopped: string | null;
  inFlight: boolean;
}

function newBreaker(): Breaker {
  return {
    consecutiveFailures: 0,
    consecutiveUnreachable: 0,
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
   * The bearer token. Defaults to `TLIB_ANALYTICS_KEY`, with
   * `tlib_telemetry_key` overriding it for a dev run.
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

/**
 * The ingest's bearer token, or empty when this build has none.
 *
 * IT IS NOT `TLIB_PUBLIC_KEY`, AND SENDING THAT HERE IS WHY NO TELEMETRY
 * BATCH FROM ANY INSTALL HAS EVER BEEN ACCEPTED. Measured 2026-10-30: the real
 * value posted at this endpoint answers `401 {"error":"That API key is not
 * valid…"}`, and `analytics_ingest_counters` — written AFTER the door, including
 * for refusals — has zero rows in production. The two are different doors:
 * `TLIB_PUBLIC_KEY` travels as `x-resource-secret` and tWeb compares it against
 * the `MARKETPLACE_RESOURCE_SECRET` env var, while this travels as
 * `Authorization: Bearer` and is looked up by hash in tWeb's `api_keys` table,
 * where it must carry the `analytics:ingest` scope. A marketplace secret was
 * never going to be a row in that table.
 *
 * EMPTY MEANS NOTHING IS SENT, which is the honest state of a build that has
 * not been given a key: the `no-credential` verdict below says so once on the
 * console instead of posting a batch that is certain to be refused and then
 * blaming the operator's credential for it. Filling this in is the whole of what
 * turns diagnostics on, and a release must not ship it empty.
 *
 * It is public by the same argument as `TLIB_PUBLIC_KEY` — a key inside a
 * shipped resource is readable by whoever holds the resource, and the
 * alternative is an operator-supplied credential nobody would supply, i.e. an
 * opt-in to nothing. What makes that acceptable is the scope: it can write
 * events and read nothing, and a leak costs a daily event budget, not data. So
 * it is rotatable, and rotating it stops older installs reporting.
 */
export const TLIB_ANALYTICS_KEY = "";

function credential(): string {
  let override = "";
  try {
    override = fGetConvar(TELEMETRY_KEY_CONVAR, "").trim();
  } catch {
    override = "";
  }
  return override || TLIB_ANALYTICS_KEY;
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

export function createTransport(opts: TransportOptions): Transport {
  const now = opts.now ?? (() => Date.now());
  const post = opts.post ?? performPost;
  const log = opts.log ?? (() => {});
  const readCredential = opts.credential ?? credential;
  const breaker = newBreaker();
  let timer: ReturnType<typeof setInterval> | null = null;
  // Said once, not per flush: the flusher runs every minute for the life of the
  // server, and an hourly line about the same unchanging fact is the console
  // spam this transport was already reported for.
  let saidNoCredential = false;

  function onSuccess(b: Breaker): void {
    b.consecutiveFailures = 0;
    b.consecutiveUnreachable = 0;
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
    if (!key) {
      // Not `permanentlyStopped`: the convar is re-read every flush, so a dev
      // who sets `tlib_telemetry_key` mid-session must still be able to send.
      if (!saidNoCredential) {
        saidNoCredential = true;
        log(
          "[tLib] diagnostics are on, but this build carries no ingest credential, so nothing " +
            "is being sent and nothing is reaching us. That is our omission and not a setting " +
            "on your server — there is nothing for you to supply. Leave it on and a later tLib " +
            "will start reporting, or 'set tlib_telemetry 0' to stop opting in."
        );
      }
      return "no-credential";
    }
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
        // The id travels as a header as well as a dimension so that a single
        // install can be muted at the edge without the body being read. NO
        // tWeb route reads it yet — `v1.analytics.events.ts` filters on the
        // credential alone — so today this is a header the ingest could use and
        // does not, not a control that exists.
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
        // Status 0 is performPost's own 15s timeout or a thrown
        // PerformHttpRequest: nothing answered, so this says something about the
        // network between this server and the ingest, not about the ingest's
        // verdict — which is why it needs a count of its own to give up on.
        b.consecutiveUnreachable = status <= 0 ? b.consecutiveUnreachable + 1 : 0;
        if (b.consecutiveUnreachable >= UNREACHABLE_FAILURES_BEFORE_STOP) {
          b.permanentlyStopped = `the ingest never answered (${b.consecutiveUnreachable} attempts, no HTTP response)`;
          log(
            `[tLib] diagnostics disabled for this session: ${b.permanentlyStopped}. Something ` +
              `between this server and ${opts.baseUrl()} is dropping the connection — outbound ` +
              "HTTPS, DNS, or a host firewall. Nothing was ever delivered, and queued events " +
              "are discarded from here on. Restart the resource once the network is fixed, or " +
              "'set tlib_telemetry false' to stop opting in."
          );
          // Dropped for the same reason a 401 batch is: a queue that can never
          // drain spends the session evicting newer events to hold older ones.
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
