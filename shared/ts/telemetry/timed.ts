/**
 * `timed()` — how a function that is slow on somebody else's machine says so.
 *
 * OUTLIERS ONLY, and that constraint shapes everything here: a NUI render path
 * runs 60 times a second, and tWeb charges its daily budget per event. Three
 * channels — a threshold, a cooldown on it, and a p95 over a rolling window —
 * because none of them covers the others' case. The window is a fixed ring of
 * the last 64 durations, so instrumenting costs one subtraction and one array
 * write per call and the sort happens only at report time.
 * Design notes: docs/internal/telemetry-wire-contract.md.
 */

/** How many recent durations one operation keeps. See the header on the trade. */
export const SAMPLE_WINDOW = 64;

/** At most one `threshold` report per operation per minute. */
export const THRESHOLD_COOLDOWN_MS = 60_000;

/** At most one `p95` report per operation per five minutes. */
export const P95_INTERVAL_MS = 300_000;

/**
 * How close to its budget an operation has to habitually run before the p95
 * channel says so. A fraction of the budget and not the budget: comparing the
 * p95 against the threshold itself can only fire once 5% of the window has
 * already breached, which the threshold channel reports sooner, so that version
 * of the channel was dead code. 0.8 rather than 0.5, because at half the budget
 * almost every real operation on a slow machine qualifies.
 */
export const P95_BUDGET_FRACTION = 0.8;

export interface TimedOutlier {
  /** The operation's name, already slug-safe by contract — see `createTimers`. */
  operation: string;
  kind: "threshold" | "p95";
  /** The offending duration for `threshold`; the p95 for `p95`. */
  durationMs: number;
  /** Durations in the window. `p95` only — a threshold report has one sample. */
  sampleCount: number;
  /** The worst duration seen in this window. */
  maxMs: number;
  /**
   * Threshold breaches since the last report that were NOT sent. The difference
   * between "this happened once" and "4,000 times and we told you once". Zero on
   * a p95 report.
   */
  suppressed: number;
  /** The budget the operation declared, so a reader need not look it up. */
  thresholdMs: number;
}

export interface TimerOptions {
  /**
   * The clock. `performance.now()` in NUI, `GetGameTimer()` in Lua. A parameter
   * because the two have different resolutions: `GetGameTimer()` is integer
   * milliseconds, so a sub-millisecond Lua operation measures as 0 and a p95 of
   * 0 is correct there.
   */
  now: () => number;
  /** Where an outlier goes. Never called from inside the timed call itself. */
  report: (outlier: TimedOutlier) => void;
  thresholdCooldownMs?: number;
  p95IntervalMs?: number;
}

interface OperationState {
  thresholdMs: number;
  samples: number[];
  /** Write cursor into `samples` once it is full. */
  cursor: number;
  filled: boolean;
  maxMs: number;
  suppressed: number;
  lastThresholdReportAt: number;
  lastP95ReportAt: number;
}

/**
 * p95 of a window, by nearest-rank on a sorted copy -- not interpolation, which
 * would report a latency that was never observed. Exported so the suite pins the
 * rank rather than re-deriving it.
 */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index] as number;
}

export interface Timers {
  /**
   * Time a synchronous call. Returns whatever the call returned. `try/finally`,
   * so a throwing call is still timed: the slowest call on a machine in trouble
   * is frequently the one that then throws.
   */
  timed<T>(operation: string, thresholdMs: number, fn: () => T): T;
  /** The async form. Same contract; the duration spans the awaited settle. */
  timedAsync<T>(operation: string, thresholdMs: number, fn: () => Promise<T>): Promise<T>;
  /**
   * Record a duration measured somewhere else -- the seam for a call site that
   * cannot be wrapped, such as a callback whose start and end are in two
   * different functions.
   */
  record(operation: string, thresholdMs: number, durationMs: number): void;
  /** Tests only. */
  reset(): void;
}

export function createTimers(opts: TimerOptions): Timers {
  const cooldown = opts.thresholdCooldownMs ?? THRESHOLD_COOLDOWN_MS;
  const p95Interval = opts.p95IntervalMs ?? P95_INTERVAL_MS;
  const ops = new Map<string, OperationState>();

  function stateFor(operation: string, thresholdMs: number): OperationState {
    let s = ops.get(operation);
    if (!s) {
      s = {
        thresholdMs,
        samples: [],
        cursor: 0,
        filled: false,
        maxMs: 0,
        suppressed: 0,
        /**
         * `-Infinity`, not 0 and not `now()`. `now()` arms the cooldown and
         * swallows the session's first breach. `0` only looks like a fix: both
         * clocks start near zero, so `now - 0 >= 60_000` is false for the first
         * minute, which is where a slow boot path lives. `-Infinity` means
         * "never reported", which is the actual fact.
         */
        lastThresholdReportAt: Number.NEGATIVE_INFINITY,
        lastP95ReportAt: Number.NEGATIVE_INFINITY,
      };
      ops.set(operation, s);
    }
    s.thresholdMs = thresholdMs;
    return s;
  }

  function record(operation: string, thresholdMs: number, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const s = stateFor(operation, thresholdMs);
    const now = opts.now();

    if (s.samples.length < SAMPLE_WINDOW) {
      s.samples.push(durationMs);
      if (s.samples.length === SAMPLE_WINDOW) s.filled = true;
    } else {
      s.samples[s.cursor] = durationMs;
      s.cursor = (s.cursor + 1) % SAMPLE_WINDOW;
    }
    if (durationMs > s.maxMs) s.maxMs = durationMs;

    if (durationMs >= thresholdMs) {
      if (now - s.lastThresholdReportAt >= cooldown) {
        s.lastThresholdReportAt = now;
        const suppressed = s.suppressed;
        s.suppressed = 0;
        opts.report({
          operation,
          kind: "threshold",
          durationMs: Math.round(durationMs),
          sampleCount: 1,
          maxMs: Math.round(s.maxMs),
          suppressed,
          thresholdMs,
        });
      } else {
        s.suppressed += 1;
      }
      return;
    }

    if (!s.filled) return;
    if (now - s.lastP95ReportAt < p95Interval) return;
    const value = p95(s.samples);
    if (value < thresholdMs * P95_BUDGET_FRACTION) return;
    s.lastP95ReportAt = now;
    opts.report({
      operation,
      kind: "p95",
      durationMs: Math.round(value),
      sampleCount: s.samples.length,
      maxMs: Math.round(s.maxMs),
      suppressed: 0,
      thresholdMs,
    });
  }

  return {
    record,
    timed<T>(operation: string, thresholdMs: number, fn: () => T): T {
      const start = opts.now();
      try {
        return fn();
      } finally {
        record(operation, thresholdMs, opts.now() - start);
      }
    },
    async timedAsync<T>(operation: string, thresholdMs: number, fn: () => Promise<T>): Promise<T> {
      const start = opts.now();
      try {
        return await fn();
      } finally {
        record(operation, thresholdMs, opts.now() - start);
      }
    },
    reset() {
      ops.clear();
    },
  };
}
