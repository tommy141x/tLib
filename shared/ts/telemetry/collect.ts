/**
 * The NUI collector: the one thing a resource's `index.tsx` calls.
 *
 *     const diag = installDiagnostics({
 *       resource: "tRadio",
 *       resourceVersion: BUILD.version,
 *       state: () => getAudioDiagnostics(),
 *     });
 *
 * Everything else in this directory is a primitive; this is the wiring.
 *
 * CAPTURE IS LOCAL AND UNCONDITIONAL; TRANSMISSION IS GATED. The gate lives on
 * the game server and `enabled` here is only a cache of its answer, so the
 * invariant when editing this file is that **the only path that leaves the page
 * is `flush()`** — nothing else may call `fetchNui`.
 *
 * `console.warn` is deliberately NOT hooked, and neither is `tlib.logger`: a log
 * line has no stable identifier, so it cannot be grouped. A warning is reported
 * when our code says it is one, with a code.
 *
 * Both decisions in full: docs/internal/telemetry-wire-contract.md
 */

import { fetchNui, isNUI, onNuiEvent } from "../nui";
import { registerAmbientTimers } from "./ambient";
import { describeError, type ErrorContext } from "./error-report";
import { environmentRow, readHardware } from "./hardware";
import {
  compact,
  crashKindFor,
  DIMENSION_CAPS,
  type DiagContext,
  type DiagErrorKind,
  type DiagEvent,
  type DiagWarningKind,
  MAX_STACK_CHARS_SENT,
  pathSlug,
  slug,
  stackHash,
  versionSlug,
} from "./payload";
import { registerScrubValue, scrub } from "./scrub";
import {
  type CrashReport,
  type ResourceSample,
  type SessionHandle,
  startSessionLog,
} from "./session";
import { createTimers, type TimedOutlier, type Timers } from "./timed";

/**
 * The NUI callback the Lua side registers. One name for all twelve resources,
 * since each NUI posts to its own resource. A direct POST to the website is not an
 * option: a NUI fetch to a third-party origin is CORS-blocked in CEF.
 */
export const DIAG_NUI_CALLBACK = "tlib:diagnostics";

/** How often a non-empty buffer is handed to Lua. */
export const FLUSH_INTERVAL_MS = 15_000;

/**
 * Buffer ceiling in the NUI. A ring, oldest dropped, with the drop count carried
 * on the next flush — an unbounded array in a renderer that is already failing is
 * a second bug stacked on the first.
 */
export const MAX_BUFFERED_EVENTS = 64;

/**
 * One report per fingerprint per this long, and the most important number in the
 * file. A throw inside a Solid render effect re-throws on every reactive update —
 * 60 times a second in a HUD — so without dedupe the first broken install
 * saturates the buffer, the server's ring and then the daily budget inside a
 * second, evicting every other player's events.
 */
export const DEDUPE_WINDOW_MS = 120_000;

export interface InstallOptions {
  /** The resource whose NUI this is. Slugged into the `resource` dimension. */
  resource: string;
  resourceVersion: string;
  /** Which boundary this is. Defaults to `nui`. `surface`, not `senderKind`. */
  surface?: "nui" | "client" | "server";
  /** Live counters to carry across a crash. Passed straight to the ledger. */
  state?: () => Record<string, unknown> | null;
  /** Extra numeric samples folded into the crash trajectory. */
  extraSample?: () => Record<string, number>;
  /** Host-specific readings of a trajectory, appended to the generic notes. */
  extraNotes?: (samples: ResourceSample[]) => string[];
  /** Overridable for the suite. Defaults to `performance.now`. */
  now?: () => number;
}

export interface Diagnostics {
  /** Report a caught throw. Returns the `stackHash`, for a pasteable report. */
  reportError(err: unknown, ctx?: Partial<ErrorContext> & { kind?: DiagErrorKind }): string;
  /**
   * Report a fault our code noticed and handled. `code` is the grouping key and
   * `kind` one of tWeb's five categories. The contract has no message field for a
   * warning, so a message is logged locally and not sent.
   */
  reportWarning(code: string, kind?: DiagWarningKind, message?: string): void;
  /** Record an externally measured duration, or wrap a call. */
  timers: Timers;
  session: SessionHandle;
  /** Lua's answer about the previous teardown. */
  noteOrderlyStop(orderly: boolean): void;
  /** The server's consent answer, cached. Defaults to `false`. */
  setEnabled(enabled: boolean): void;
  /** Declare a value as the player's, so it is scrubbed out of every string. */
  addScrubValue(value: string): void;
  flush(): Promise<void>;
  stop(): void;
}

/** What one flush hands to Lua. Mirrored by `shared/imports/telemetry/shared.lua`. */
export interface DiagFlush {
  context: DiagContext;
  events: DiagEvent[];
  /** Events the NUI ring dropped since the last flush. */
  dropped: number;
}

export function installDiagnostics(opts: InstallOptions): Diagnostics {
  const now = opts.now ?? (() => performance.now());
  const surface = opts.surface ?? "nui";

  const context: DiagContext = {
    resource: slug(opts.resource, DIMENSION_CAPS.resource) || "unknown",
    // `versionSlug`, not `slug`: `+` is outside the charset and gets the version
    // refused, which looks nothing like the length cap it would be blamed on.
    resourceVersion: versionSlug(opts.resourceVersion),
    // Empty here, stamped by the game server. A per-browser id would make every
    // player their own "install" and turn an install count into a player count.
    installId: "",
    // Where the FAULT happened, not who posts — that is `senderKind`.
    surface: "nui",
  };

  let enabled = false;
  let stopped = false;
  let dropped = 0;
  const events: DiagEvent[] = [];
  /** fingerprint -> epoch ms of the last report. Bounded by eviction below. */
  const lastSeen = new Map<string, number>();

  const hardware = readHardware();

  function pushEvent(event: DiagEvent): void {
    events.push(event);
    while (events.length > MAX_BUFFERED_EVENTS) {
      events.shift();
      dropped += 1;
    }
  }

  /**
   * True when this fingerprint may be reported now. The map is swept in the same
   * pass: a throw whose message carries a counter mints a new fingerprint every
   * call, so without the sweep it leaks for the life of the session.
   */
  function admit(fp: string): boolean {
    const at = Date.now();
    for (const [key, seen] of lastSeen) {
      if (at - seen > DEDUPE_WINDOW_MS) lastSeen.delete(key);
    }
    const seen = lastSeen.get(fp);
    if (seen !== undefined && at - seen < DEDUPE_WINDOW_MS) return false;
    lastSeen.set(fp, at);
    return true;
  }

  function reportError(
    err: unknown,
    ctx: Partial<ErrorContext> & { kind?: DiagErrorKind } = {}
  ): string {
    // `describeError` scrubs, and that is where the obligation is met: a non-zero
    // `redactions` count at tWeb is a bug here that nothing else will report.
    const report = describeError(err);
    const hash = stackHash(report.name, report.stack);
    if (!admit(hash)) return hash;

    pushEvent({
      event: "tlib.error_reported",
      at: Date.now(),
      dimensions: compact({
        errorKind: ctx.kind ?? "nui_error",
        surface: ctx.surface === "client" || ctx.surface === "server" ? ctx.surface : surface,
        // The error NAME is the code. Through `slug`, which strips player
        // identifiers first — a gate's "no permission for steam:…" is the
        // likeliest thing in the taxonomy to arrive here.
        errorCode: slug(report.name, DIMENSION_CAPS.errorCode),
        // `pathSlug`: `/` and `\` are outside the charset, so a path is refused
        // unless mapped to dots, which keeps the `:line` suffix.
        location: pathSlug(ctx.location ?? "", DIMENSION_CAPS.location),
        stackHash: hash,
      }),
      measures: {},
      /**
       * TOP-LEVEL, never inside `dimensions` — the charset would refuse it there
       * and lose the whole event. With no stack, the message IS the payload:
       * "TypeError with no stack" on its own is not actionable.
       */
      stack: (report.stack ?? `${report.name}: ${report.message}`).slice(0, MAX_STACK_CHARS_SENT),
    });
    return hash;
  }

  function reportWarning(code: string, kind?: DiagWarningKind, message?: string): void {
    const id = slug(code, DIMENSION_CAPS.warningCode);
    if (!id) return;
    // Grouped on the CODE: a warning's message routinely interpolates a count or
    // a name, and grouping on that gives every occurrence its own group.
    if (!admit(`warning:${id}`)) return;
    // Logged and not sent — the event declares no text field, so there is nowhere
    // for it to go. Said out loud rather than silently dropped.
    if (message) console.warn(`[${opts.resource}] ${id}: ${scrub(message)}`);
    pushEvent({
      event: "tlib.warning_reported",
      at: Date.now(),
      dimensions: compact({
        warningKind: kind ?? "unknown",
        surface,
        warningCode: id,
      }),
      measures: {},
    });
  }

  function reportOutlier(outlier: TimedOutlier): void {
    pushEvent({
      event: "tlib.slow_operation",
      at: Date.now(),
      dimensions: compact({
        operation: slug(outlier.operation, DIMENSION_CAPS.operation),
        surface,
      }),
      /**
       * Two measures is all the contract has, so the VOLUME behind a throttled
       * report does not travel — a path that breached 4,000 times and one that
       * breached once arrive identically. The count stays in `timed.ts`. No
       * percentile is sent: these rows are outliers, so a p95 of them is not one.
       */
      measures: {
        durationMs: outlier.durationMs,
        thresholdMs: outlier.thresholdMs,
      },
    });
  }

  function reportCrash(crash: CrashReport): void {
    // The trajectory cannot travel — the contract declares only `crashKind` and
    // `uptimeSeconds` — so the heap curve and DOM growth that actually diagnose a
    // renderer death stay in the F8 banner. Emitted on the NEXT start, so tWeb's
    // `late` clock verdict is normal here rather than a fault.
    pushEvent({
      event: "tlib.crash_reported",
      at: Date.now(),
      dimensions: compact({ crashKind: crashKindFor(crash.verdict), surface }),
      // Seconds, not milliseconds: the range is 0–604800, so ms would clamp to the
      // ceiling past ten minutes — a wrong number that looks like a reading.
      measures: { uptimeSeconds: Math.max(0, Math.round(crash.uptimeMs / 1000)) },
    });
  }

  const timers = createTimers({ now, report: reportOutlier });
  // So code inside `shared/ts/` — above all `nui.ts`, which cannot import this
  // file without a cycle — can be instrumented without being handed a handle.
  registerAmbientTimers(timers);

  const session = startSessionLog({
    namespace: context.resource,
    state: opts.state,
    extraSample: opts.extraSample,
    extraNotes: opts.extraNotes,
    onCrash: reportCrash,
    onBanner: (line) => console.log(`[${opts.resource}] ${line}`),
  });

  // The machine context, once per boot. Queued rather than sent: the install id is
  // still empty here, and that dimension is what makes an install count possible.
  const environment = environmentRow(hardware);
  pushEvent({
    event: "tlib.environment_reported",
    at: Date.now(),
    dimensions: compact({ ...environment.dimensions, surface }),
    measures: environment.measures,
  });

  /** `addEventListener('error')` and NOT `window.onerror = ...`. */
  const onError = (e: ErrorEvent) => {
    // `e.error` carries the stack; `e.message` alone, which is all a bare
    // `window.onerror` gets, has no fingerprint. Still better than dropping it.
    reportError(e.error ?? `${e.message} (${e.filename}:${e.lineno})`, {
      surface,
      location: "window.onerror",
      kind: "nui_error",
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    reportError(e.reason, { surface, location: "unhandledrejection", kind: "nui_error" });
  };

  try {
    // Assigning `window.onerror` would replace a consumer's own handler, and there
    // is no way to tell from here whether one exists. A listener composes.
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
  } catch {
    /* no window: a unit test, or a non-DOM host. Capture degrades, boot does not. */
  }

  async function flush(): Promise<void> {
    if (stopped) return;
    // THE GATE. Nothing above this line touches the network or Lua.
    if (!enabled) return;
    if (events.length === 0) return;
    if (!isNUI()) return;

    const batch: DiagFlush = {
      context,
      events: events.splice(0, events.length),
      dropped,
    };
    dropped = 0;
    // `fetchNui` never rejects: a flush that could throw would turn one bug into
    // an unhandled rejection, which this module would capture and try to flush.
    // `await`ed so two flushes cannot interleave.
    await fetchNui(DIAG_NUI_CALLBACK, batch);
  }

  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  /**
   * The server's consent answer, relayed by `shared/imports/telemetry`. Subscribed
   * here rather than in each consumer, so adopting diagnostics is one call and no
   * message plumbing; `setEnabled` stays public for a consumer that wants to
   * decide for itself, last writer wins.
   */
  const unsubscribeConsent = onNuiEvent<{ enabled?: unknown }>("tlib:diag:consent", (data) => {
    const next = (data as { enabled?: unknown } | undefined)?.enabled === true;
    // Not via the returned handle — it does not exist yet on this line, and going
    // through a closure would make the subscription depend on construction order.
    enabled = next;
    if (!next) {
      events.length = 0;
      dropped = 0;
    }
  });

  return {
    reportError,
    reportWarning,
    timers,
    session,
    noteOrderlyStop: (orderly: boolean) => session.noteOrderlyStop(orderly),
    setEnabled(next: boolean) {
      enabled = next;
      // Opting out discards what was captured. Keeping it would mean a buffer
      // collected while the operator said no is sent the moment they say yes.
      if (!next) {
        events.length = 0;
        dropped = 0;
      }
    },
    addScrubValue(value: string) {
      registerScrubValue(value);
    },
    flush,
    stop() {
      stopped = true;
      clearInterval(timer);
      registerAmbientTimers(null);
      unsubscribeConsent();
      session.stop();
      try {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      } catch {
        /* nothing to remove */
      }
    },
  };
}
