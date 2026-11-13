/**
 * One retry loop for NUI code that polls until something answers.
 *
 * Four hand-written ladders (a connection-info poll, a `nui:ready` resend, a
 * re-assert after a refusal, a batch resend) each had a different subset of the
 * same five properties, and the ones that lacked one failed in the field: a poll
 * with no cap and no single-flight issued a request every tick while the last was
 * still pending; one with no ceiling asked forever. This is the lot, once.
 *
 *  - Single-flight. The next delay starts when the attempt SETTLES, so attempts
 *    never overlap and a slow one cannot be stacked on.
 *  - A fast stretch, then exponential slow delays up to `capMs`, with jitter so
 *    clients that lost the same server do not retry in step.
 *  - A bound: `maxAttempts` and/or `maxElapsedMs`, then `onGiveUp`.
 *  - Revivable. A loop that gave up restarts from the top on `resume()`, which is
 *    how "stop asking, but ask again when the player powers on" is expressed.
 *  - `stop()` is final. A hidden page pauses the timer and a visible one resumes
 *    it, and neither ever restarts a loop that was stopped, succeeded or gave up.
 */

export interface RetrySchedule {
  /** The first `fastCount` delays. */
  fastMs: number;
  /** How many delays are `fastMs`. */
  fastCount: number;
  /** The first slow delay; each later one doubles. */
  slowMs: number;
  /** Ceiling on every delay, jitter included. At least `fastMs` and `slowMs`. */
  capMs: number;
  /** Fraction of each delay that is randomised either way, 0 to 1. Default 0. */
  jitter?: number;
}

export type RetryGiveUpReason = "attempts" | "elapsed";

export type RetryState = "idle" | "running" | "succeeded" | "stopped" | "gaveUp";

export interface RetryAttemptInfo {
  /** 1 for the first attempt. */
  attempt: number;
  /** Aborted by `stop()`, so an in-flight fetch does not outlive the loop. */
  signal: AbortSignal;
}

export interface RetryGiveUpInfo {
  reason: RetryGiveUpReason;
  attempts: number;
  elapsedMs: number;
}

/** What the loop needs from its host. Every field defaults to the real one. */
export interface RetryEnvironment {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  random: () => number;
  /** `null` for a host with no page visibility, which never pauses. */
  visibility: {
    isHidden: () => boolean;
    onChange: (listener: () => void) => () => void;
  } | null;
}

export interface RetryOptions {
  /**
   * One try, sync or async. Return or resolve exactly `true` when done, which
   * stops the loop. Anything else, or a throw, schedules the next try. When success arrives some other way (a reply
   * event), call `succeed()`.
   */
  attempt: (info: RetryAttemptInfo) => unknown;
  schedule: RetrySchedule;
  /** Give up after this many attempts. Unbounded when omitted. */
  maxAttempts?: number;
  /** Give up after this much time spent running; time hidden does not count. */
  maxElapsedMs?: number;
  onGiveUp?: (info: RetryGiveUpInfo) => void;
  /** A throw or rejection from `attempt`. Defaults to one `console.warn` per run. */
  onError?: (error: unknown, attempt: number) => void;
  /** Run the first attempt at once instead of after the first delay. Default false. */
  immediate?: boolean;
  /** Pause while the page is hidden. Default true. */
  pauseWhenHidden?: boolean;
  environment?: Partial<RetryEnvironment>;
}

export interface RetryLoop {
  readonly state: RetryState;
  /** Attempts started this run. */
  readonly attempts: number;
  /** True while an attempt is unsettled. */
  readonly inFlight: boolean;
  /**
   * Begin. Does nothing, and returns false, while already running: a second
   * caller must not reset the backoff the first one earned.
   */
  start(): boolean;
  /**
   * Ask again now, from the top of the schedule. For a loop that gave up this is
   * a fresh run; for a running one it resets the backoff and, if no attempt is
   * in flight, tries immediately. Does nothing, and returns false, for a loop
   * that was never started, was stopped, or has succeeded.
   */
  resume(): boolean;
  /** The work is done. Final until the next `start()`. */
  succeed(): void;
  /** Cancel. Final until the next `start()`. Aborts an attempt in flight. */
  stop(): void;
}

/**
 * The `delayIndex`th delay of a run, 0 being the first. Pure, so a caller can
 * show "retrying in 30s" or a test can pin the ladder.
 */
export function retryDelay(
  schedule: RetrySchedule,
  delayIndex: number,
  random: () => number = Math.random
): number {
  const base =
    delayIndex < schedule.fastCount
      ? schedule.fastMs
      : schedule.slowMs * 2 ** (delayIndex - schedule.fastCount);
  const jitter = schedule.jitter ?? 0;
  const jittered = jitter > 0 ? base * (1 + jitter * (2 * random() - 1)) : base;
  return Math.max(0, Math.min(schedule.capMs, jittered));
}

function defaultEnvironment(): RetryEnvironment {
  const hasDocument =
    typeof document !== "undefined" && typeof document.addEventListener === "function";
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: Math.random,
    visibility: hasDocument
      ? {
          isHidden: () => document.hidden,
          onChange: (listener) => {
            document.addEventListener("visibilitychange", listener);
            return () => document.removeEventListener("visibilitychange", listener);
          },
        }
      : null,
  };
}

function validate(options: RetryOptions): void {
  const { schedule, maxAttempts, maxElapsedMs } = options;
  const positive = (value: number | undefined) =>
    value === undefined || (Number.isFinite(value) && value > 0);
  if (!(schedule.fastMs >= 0) || !(schedule.slowMs > 0) || !(schedule.fastCount >= 0)) {
    throw new RangeError(
      "createRetryLoop: schedule needs fastMs >= 0, fastCount >= 0 and slowMs > 0"
    );
  }
  if (!(schedule.capMs >= schedule.fastMs) || !(schedule.capMs >= schedule.slowMs)) {
    throw new RangeError("createRetryLoop: schedule.capMs must be at least fastMs and slowMs");
  }
  if (schedule.jitter !== undefined && !(schedule.jitter >= 0 && schedule.jitter <= 1)) {
    throw new RangeError("createRetryLoop: schedule.jitter must be between 0 and 1");
  }
  if (!positive(maxAttempts) || !positive(maxElapsedMs)) {
    throw new RangeError("createRetryLoop: maxAttempts and maxElapsedMs must be positive");
  }
}

export function createRetryLoop(options: RetryOptions): RetryLoop {
  validate(options);
  const env: RetryEnvironment = { ...defaultEnvironment(), ...options.environment };
  const pauseWhenHidden = options.pauseWhenHidden !== false;

  let state: RetryState = "idle";
  let attempts = 0;
  /** Delays armed this run, which is what places the next one on the ladder. */
  let delays = 0;
  let inFlight = false;
  let timer: unknown;
  let timerArmed = false;
  let controller: AbortController | undefined;
  /** Bumped on every start/stop so a settling attempt can tell it is stale. */
  let run = 0;
  let activeSince = 0;
  let activeBefore = 0;
  let paused = false;
  let warned = false;
  let unwatch: (() => void) | undefined;

  const elapsed = () => activeBefore + (paused ? 0 : env.now() - activeSince);

  function clearTimer() {
    if (timerArmed) env.clearTimeout(timer);
    timerArmed = false;
  }

  function finish(next: RetryState) {
    state = next;
    clearTimer();
    unwatch?.();
    unwatch = undefined;
    controller?.abort();
    controller = undefined;
    paused = false;
  }

  function giveUp(reason: RetryGiveUpReason) {
    const info = { reason, attempts, elapsedMs: elapsed() };
    finish("gaveUp");
    options.onGiveUp?.(info);
  }

  function exhausted(): RetryGiveUpReason | null {
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) return "attempts";
    if (options.maxElapsedMs !== undefined && elapsed() >= options.maxElapsedMs) return "elapsed";
    return null;
  }

  function armTimer() {
    clearTimer();
    if (state !== "running" || paused) return;
    const delay = retryDelay(options.schedule, delays++, env.random);
    timerArmed = true;
    timer = env.setTimeout(() => {
      timerArmed = false;
      void tick();
    }, delay);
  }

  async function tick() {
    if (state !== "running" || paused || inFlight) return;
    const reason = exhausted();
    if (reason) return giveUp(reason);

    const mine = run;
    const attempt = ++attempts;
    inFlight = true;
    controller = new AbortController();
    let done = false;
    try {
      done = (await options.attempt({ attempt, signal: controller.signal })) === true;
    } catch (error) {
      if (options.onError) options.onError(error, attempt);
      else if (!warned) {
        warned = true;
        console.warn(`[retry] attempt ${attempt} threw; retrying on schedule:`, error);
      }
    }
    if (mine !== run) return;
    inFlight = false;
    if (state !== "running") return;
    if (done) return void finish("succeeded");
    const spent = exhausted();
    if (spent) return giveUp(spent);
    armTimer();
  }

  function onVisibility() {
    if (state !== "running") return;
    const hidden = env.visibility?.isHidden() ?? false;
    if (hidden && !paused) {
      activeBefore += env.now() - activeSince;
      paused = true;
      clearTimer();
    } else if (!hidden && paused) {
      paused = false;
      activeSince = env.now();
      if (!inFlight) armTimer();
    }
  }

  function begin() {
    run++;
    attempts = 0;
    delays = 0;
    inFlight = false;
    warned = false;
    activeBefore = 0;
    activeSince = env.now();
    paused = pauseWhenHidden && (env.visibility?.isHidden() ?? false);
    state = "running";
    if (pauseWhenHidden && env.visibility) unwatch = env.visibility.onChange(onVisibility);
    if (paused) return;
    if (options.immediate) void tick();
    else armTimer();
  }

  return {
    get state() {
      return state;
    },
    get attempts() {
      return attempts;
    },
    get inFlight() {
      return inFlight;
    },

    start() {
      if (state === "running") return false;
      begin();
      return true;
    },

    resume() {
      if (state === "gaveUp") {
        begin();
        return true;
      }
      if (state !== "running") return false;
      attempts = 0;
      delays = 0;
      activeBefore = 0;
      activeSince = env.now();
      if (!paused && !inFlight) {
        clearTimer();
        void tick();
      }
      return true;
    },

    succeed() {
      if (state !== "running") return;
      run++;
      inFlight = false;
      finish("succeeded");
    },

    stop() {
      if (state === "idle" || state === "stopped") return;
      run++;
      inFlight = false;
      finish("stopped");
    },
  };
}
