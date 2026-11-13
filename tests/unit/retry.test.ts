import { describe, expect, test } from "bun:test";
import {
  createRetryLoop,
  type RetryGiveUpInfo,
  type RetryLoop,
  type RetryOptions,
  retryDelay,
} from "../../shared/ts/retry.ts";

/**
 * A clock the test advances by hand. Timers fire in order inside `advance`, and
 * a timer armed by a firing timer is honoured if it lands inside the window, so
 * a whole ladder can be walked in one call.
 */
function manualHost() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let hidden = false;
  const listeners = new Set<() => void>();

  const host = {
    now: () => now,
    timers,
    armed: () => timers.size,
    environment: {
      now: () => now,
      random: () => 0.5,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown) => void timers.delete(handle as number),
      visibility: {
        isHidden: () => hidden,
        onChange: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let soonest: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= target && (!soonest || entry[1].at < soonest[1].at)) soonest = entry;
        if (!soonest) break;
        timers.delete(soonest[0]);
        now = Math.max(now, soonest[1].at);
        soonest[1].fn();
        await settle();
      }
      now = target;
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return host;
}

/** Let every pending promise continuation run. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const SCHEDULE = { fastMs: 1000, fastCount: 3, slowMs: 4000, capMs: 20000 };

function make(host: ReturnType<typeof manualHost>, overrides: Partial<RetryOptions> = {}) {
  const calls: number[] = [];
  const options: RetryOptions = {
    attempt: ({ attempt }) => {
      calls.push(attempt);
    },
    schedule: SCHEDULE,
    environment: host.environment,
    ...overrides,
  };
  return { loop: createRetryLoop(options), calls };
}

describe("retryDelay", () => {
  test("the fast delays, then slow ones that double up to the cap", () => {
    const delays = Array.from({ length: 9 }, (_, i) => retryDelay(SCHEDULE, i, () => 0.5));
    expect(delays).toEqual([1000, 1000, 1000, 4000, 8000, 16000, 20000, 20000, 20000]);
  });

  test("jitter spreads a delay by the fraction either way and never past the cap", () => {
    const low = retryDelay({ ...SCHEDULE, jitter: 0.25 }, 0, () => 0);
    const high = retryDelay({ ...SCHEDULE, jitter: 0.25 }, 0, () => 1);
    expect(low).toBe(750);
    expect(high).toBe(1250);
    expect(retryDelay({ ...SCHEDULE, jitter: 0.5 }, 6, () => 1)).toBe(20000);
  });

  test("no jitter is exactly the ladder, whatever random says", () => {
    expect(retryDelay(SCHEDULE, 3, () => 0.99)).toBe(4000);
  });
});

describe("single-flight", () => {
  test("the next delay starts when an attempt settles, so attempts never overlap", async () => {
    const host = manualHost();
    let release!: () => void;
    let concurrent = 0;
    let peak = 0;
    const { loop, calls } = make(host, {
      attempt: ({ attempt }) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        calls.push(attempt);
        return new Promise<void>((resolve) => {
          release = () => {
            concurrent--;
            resolve();
          };
        });
      },
    });
    loop.start();
    await host.advance(1000);
    expect(calls).toEqual([1]);
    expect(loop.inFlight).toBe(true);

    await host.advance(60_000);
    expect(calls).toEqual([1]);
    expect(host.armed()).toBe(0);

    release();
    await settle();
    expect(loop.inFlight).toBe(false);
    await host.advance(1000);
    expect(calls).toEqual([1, 2]);
    expect(peak).toBe(1);
    loop.stop();
  });

  test("start while running does nothing and keeps the backoff it earned", async () => {
    const host = manualHost();
    const { loop, calls } = make(host);
    expect(loop.start()).toBe(true);
    await host.advance(1000 + 1000 + 1000 + 4000);
    expect(calls.length).toBe(4);
    expect(loop.start()).toBe(false);
    expect(loop.attempts).toBe(4);
    await host.advance(8000);
    expect(calls.length).toBe(5);
    loop.stop();
  });
});

describe("schedule", () => {
  test("attempts land on the ladder", async () => {
    const host = manualHost();
    const at: number[] = [];
    const { loop } = make(host, {
      attempt: () => {
        at.push(host.now());
      },
    });
    loop.start();
    await host.advance(90_000);
    loop.stop();
    expect(at.slice(0, 6)).toEqual([1000, 2000, 3000, 7000, 15000, 31000]);
    expect(at[6] - at[5]).toBe(20000);
  });

  test("immediate runs the first attempt at once", async () => {
    const host = manualHost();
    const { loop, calls } = make(host, { immediate: true });
    loop.start();
    await settle();
    expect(calls).toEqual([1]);
    loop.stop();
  });
});

describe("success", () => {
  test("an attempt that resolves true ends the loop", async () => {
    const host = manualHost();
    const calls: number[] = [];
    const { loop } = make(host, {
      attempt: ({ attempt }) => {
        calls.push(attempt);
        return attempt === 2;
      },
    });
    loop.start();
    await host.advance(10_000);
    expect(calls).toEqual([1, 2]);
    expect(loop.state).toBe("succeeded");
    expect(host.armed()).toBe(0);
  });

  test("succeed() from outside ends it, with an attempt still in flight", async () => {
    const host = manualHost();
    let resolve!: (value: boolean) => void;
    const { loop, calls } = make(host, {
      attempt: ({ attempt }) => {
        calls.push(attempt);
        return new Promise<boolean>((r) => {
          resolve = r;
        });
      },
    });
    loop.start();
    await host.advance(1000);
    loop.succeed();
    resolve(false);
    await settle();
    await host.advance(60_000);
    expect(calls).toEqual([1]);
    expect(loop.state).toBe("succeeded");
  });

  test("a later start() is a fresh run: the attempt count and ladder reset", async () => {
    const host = manualHost();
    const { loop, calls } = make(host);
    loop.start();
    await host.advance(1000 + 1000 + 1000 + 4000);
    expect(loop.attempts).toBe(4);
    loop.succeed();
    expect(loop.start()).toBe(true);
    expect(loop.attempts).toBe(0);
    await host.advance(1000);
    expect(calls.at(-1)).toBe(1);
    loop.stop();
  });
});

describe("failure", () => {
  test("a throw is a failed attempt: reported, and the loop carries on", async () => {
    const host = manualHost();
    const errors: [unknown, number][] = [];
    const { loop, calls } = make(host, {
      attempt: ({ attempt }) => {
        calls.push(attempt);
        throw new Error("down");
      },
      onError: (error, attempt) => errors.push([error, attempt]),
    });
    loop.start();
    await host.advance(2000);
    expect(calls).toEqual([1, 2]);
    expect(errors.map(([, n]) => n)).toEqual([1, 2]);
    expect((errors[0][0] as Error).message).toBe("down");
    loop.stop();
  });

  test("a rejection is the same, and without onError it warns once per run", async () => {
    const host = manualHost();
    const warnings: unknown[][] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const { loop } = make(host, { attempt: () => Promise.reject(new Error("nope")) });
      loop.start();
      await host.advance(5000);
      expect(loop.attempts).toBeGreaterThanOrEqual(3);
      expect(warnings.length).toBe(1);
      loop.stop();
    } finally {
      console.warn = real;
    }
  });
});

describe("bounds", () => {
  test("maxAttempts gives up straight after the last attempt, with the reason", async () => {
    const host = manualHost();
    const gaveUp: RetryGiveUpInfo[] = [];
    const { loop, calls } = make(host, { maxAttempts: 3, onGiveUp: (info) => gaveUp.push(info) });
    loop.start();
    await host.advance(60_000);
    expect(calls).toEqual([1, 2, 3]);
    expect(gaveUp).toEqual([{ reason: "attempts", attempts: 3, elapsedMs: 3000 }]);
    expect(loop.state).toBe("gaveUp");
    expect(host.armed()).toBe(0);
  });

  test("maxElapsedMs gives up once the time is spent", async () => {
    const host = manualHost();
    const gaveUp: RetryGiveUpInfo[] = [];
    const { loop } = make(host, { maxElapsedMs: 10_000, onGiveUp: (info) => gaveUp.push(info) });
    loop.start();
    await host.advance(120_000);
    expect(gaveUp.length).toBe(1);
    expect(gaveUp[0].reason).toBe("elapsed");
    expect(gaveUp[0].elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(loop.state).toBe("gaveUp");
  });

  test("a loop with no bound does not give up", async () => {
    const host = manualHost();
    const { loop } = make(host);
    loop.start();
    await host.advance(3_600_000);
    expect(loop.state).toBe("running");
    expect(loop.attempts).toBeGreaterThan(100);
    loop.stop();
  });
});

describe("resume on an event", () => {
  test("a loop that gave up is revived from the top of the schedule", async () => {
    const host = manualHost();
    const { loop, calls } = make(host, { maxAttempts: 2 });
    loop.start();
    await host.advance(10_000);
    expect(loop.state).toBe("gaveUp");

    expect(loop.resume()).toBe(true);
    expect(loop.state).toBe("running");
    expect(loop.attempts).toBe(0);
    await host.advance(1000);
    expect(calls.length).toBe(3);
    await host.advance(1000);
    expect(calls.length).toBe(4);
    expect(loop.state).toBe("gaveUp");
  });

  test("a running loop is reset to the fast schedule and asks at once", async () => {
    const host = manualHost();
    const { loop, calls } = make(host);
    loop.start();
    await host.advance(1000 + 1000 + 1000 + 4000 + 8000);
    const before = calls.length;
    expect(loop.resume()).toBe(true);
    await settle();
    expect(calls.length).toBe(before + 1);
    expect(loop.attempts).toBe(1);
    await host.advance(1000);
    expect(calls.length).toBe(before + 2);
    loop.stop();
  });

  test("an attempt in flight is not doubled by a resume", async () => {
    const host = manualHost();
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const { loop } = make(host, {
      attempt: () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        return new Promise<void>((resolve) => {
          release = () => {
            concurrent--;
            resolve();
          };
        });
      },
    });
    loop.start();
    await host.advance(1000);
    loop.resume();
    await settle();
    expect(peak).toBe(1);
    release();
    loop.stop();
  });

  test("a loop that was stopped, succeeded or never started cannot be resumed", () => {
    const host = manualHost();
    const idle = make(host).loop;
    expect(idle.resume()).toBe(false);
    const stopped = make(host).loop;
    stopped.start();
    stopped.stop();
    expect(stopped.resume()).toBe(false);
    expect(stopped.state).toBe("stopped");
    const done = make(host).loop;
    done.start();
    done.succeed();
    expect(done.resume()).toBe(false);
  });
});

describe("stop", () => {
  test("clears the timer and aborts the attempt in flight", async () => {
    const host = manualHost();
    let signal!: AbortSignal;
    const { loop } = make(host, {
      attempt: (info) => {
        signal = info.signal;
        return new Promise<void>(() => {});
      },
    });
    loop.start();
    await host.advance(1000);
    expect(signal.aborted).toBe(false);
    loop.stop();
    expect(signal.aborted).toBe(true);
    expect(host.armed()).toBe(0);
    expect(loop.inFlight).toBe(false);
  });

  test("a late settle from before the stop does not touch a later run", async () => {
    const host = manualHost();
    const releases: (() => void)[] = [];
    const { loop, calls } = make(host, {
      attempt: ({ attempt }) => {
        calls.push(attempt);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    });
    loop.start();
    await host.advance(1000);
    loop.stop();
    loop.start();
    await host.advance(1000);
    expect(calls).toEqual([1, 1]);
    releases[0]();
    await settle();
    expect(loop.inFlight).toBe(true);
    releases[1]();
    await settle();
    expect(loop.inFlight).toBe(false);
    loop.stop();
  });
});

describe("page visibility", () => {
  test("hidden pauses the timer and visible resumes it", async () => {
    const host = manualHost();
    const { loop, calls } = make(host);
    loop.start();
    host.setHidden(true);
    expect(host.armed()).toBe(0);
    await host.advance(60_000);
    expect(calls).toEqual([]);

    host.setHidden(false);
    expect(host.armed()).toBe(1);
    await host.advance(1000);
    expect(calls).toEqual([1]);
    loop.stop();
  });

  test("stop() while hidden is not undone when the page becomes visible", async () => {
    const host = manualHost();
    const { loop, calls } = make(host);
    loop.start();
    host.setHidden(true);
    loop.stop();
    host.setHidden(false);
    await host.advance(60_000);
    expect(calls).toEqual([]);
    expect(loop.state).toBe("stopped");
    expect(host.armed()).toBe(0);
  });

  test("succeed() and a give-up while hidden are final too", async () => {
    const host = manualHost();
    const succeeded = make(host);
    succeeded.loop.start();
    host.setHidden(true);
    succeeded.loop.succeed();
    host.setHidden(false);
    await host.advance(10_000);
    expect(succeeded.calls).toEqual([]);

    const gaveUp = make(host, { maxAttempts: 1 });
    gaveUp.loop.start();
    await host.advance(1000);
    expect(gaveUp.loop.state).toBe("gaveUp");
    host.setHidden(true);
    host.setHidden(false);
    await host.advance(10_000);
    expect(gaveUp.calls).toEqual([1]);
  });

  test("an attempt that settles while hidden waits for the page before arming", async () => {
    const host = manualHost();
    let release!: () => void;
    const { loop, calls } = make(host, {
      attempt: ({ attempt }) => {
        calls.push(attempt);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    loop.start();
    await host.advance(1000);
    host.setHidden(true);
    release();
    await settle();
    expect(host.armed()).toBe(0);
    host.setHidden(false);
    expect(host.armed()).toBe(1);
    await host.advance(1000);
    expect(calls).toEqual([1, 2]);
    loop.stop();
  });

  test("time spent hidden does not count against maxElapsedMs", async () => {
    const host = manualHost();
    const { loop } = make(host, { maxElapsedMs: 5000 });
    loop.start();
    await host.advance(2000);
    host.setHidden(true);
    await host.advance(600_000);
    expect(loop.state).toBe("running");
    host.setHidden(false);
    await host.advance(10_000);
    expect(loop.state).toBe("gaveUp");
  });

  test("starting while hidden waits for the page", async () => {
    const host = manualHost();
    host.setHidden(true);
    const { loop, calls } = make(host);
    loop.start();
    await host.advance(60_000);
    expect(calls).toEqual([]);
    host.setHidden(false);
    await host.advance(1000);
    expect(calls).toEqual([1]);
    loop.stop();
  });

  test("pauseWhenHidden false ignores visibility, and a finished loop stops listening", async () => {
    const host = manualHost();
    const ignoring = make(host, { pauseWhenHidden: false });
    ignoring.loop.start();
    expect(host.listenerCount()).toBe(0);
    host.setHidden(true);
    await host.advance(1000);
    expect(ignoring.calls).toEqual([1]);
    ignoring.loop.stop();

    host.setHidden(false);
    const watching = make(host);
    watching.loop.start();
    expect(host.listenerCount()).toBe(1);
    watching.loop.stop();
    expect(host.listenerCount()).toBe(0);
  });
});

describe("arguments", () => {
  test("a schedule that cannot work is a programming error", () => {
    const base = { attempt: () => {}, schedule: SCHEDULE };
    const bad = (schedule: object, extra: object = {}) =>
      expect(() =>
        createRetryLoop({
          ...base,
          schedule: { ...SCHEDULE, ...schedule },
          ...extra,
        } as RetryOptions)
      ).toThrow(RangeError);
    bad({ slowMs: 0 });
    bad({ capMs: 500 });
    bad({ jitter: 2 });
    bad({}, { maxAttempts: 0 });
    bad({}, { maxElapsedMs: -1 });
  });
});

describe("one loop type serves the real callers", () => {
  test("the connection-info policy: 2s x8, then 15s doubling to a 60s ceiling, give up at 10 minutes, revive on an event", async () => {
    const host = manualHost();
    const at: number[] = [];
    const gaveUp: RetryGiveUpInfo[] = [];
    const loop: RetryLoop = createRetryLoop({
      attempt: () => {
        at.push(host.now());
      },
      schedule: { fastMs: 2000, fastCount: 8, slowMs: 15_000, capMs: 60_000 },
      maxElapsedMs: 10 * 60_000,
      onGiveUp: (info) => gaveUp.push(info),
      environment: host.environment,
    });
    loop.start();
    await host.advance(30 * 60_000);

    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps.slice(0, 7).every((gap) => gap === 2000)).toBe(true);
    expect(gaps.slice(7, 11)).toEqual([15_000, 30_000, 60_000, 60_000]);
    expect(Math.max(...gaps)).toBe(60_000);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0].reason).toBe("elapsed");
    expect(Math.max(...at)).toBeLessThanOrEqual(10 * 60_000);

    const attemptsBefore = at.length;
    expect(loop.resume()).toBe(true);
    await host.advance(2000);
    expect(at.length).toBeGreaterThan(attemptsBefore);
    loop.stop();
  });
});

describe("the real environment", () => {
  test("setTimeout and Date.now drive a loop with no overrides, and a host with no page never pauses", async () => {
    let calls = 0;
    const loop = createRetryLoop({
      attempt: () => ++calls === 3,
      schedule: { fastMs: 5, fastCount: 5, slowMs: 5, capMs: 5 },
    });
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(3);
    expect(loop.state).toBe("succeeded");
  });
});
