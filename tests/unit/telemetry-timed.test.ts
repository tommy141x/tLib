/**
 * `timed()` — and the thing it exists to NOT do.
 *
 * THE ASSERTION THAT MATTERS MOST IS A COUNT OF ZERO. Per-call reporting is
 * what would make this feature unusable: one instrumented 60 Hz path is 3,600
 * events a minute from one player, the ingest charges its daily budget per
 * event, and the server's ring would be dropping crash reports to make room for
 * timings of calls that were fine. So most of these tests assert that nothing
 * was reported.
 */

import { describe, expect, test } from "bun:test";
import {
  createTimers,
  P95_INTERVAL_MS,
  p95,
  SAMPLE_WINDOW,
  THRESHOLD_COOLDOWN_MS,
  type TimedOutlier,
} from "../../shared/ts/telemetry/timed";

function harness(startAt = 0) {
  let now = startAt;
  const reported: TimedOutlier[] = [];
  const timers = createTimers({ now: () => now, report: (o) => reported.push(o) });
  return {
    timers,
    reported,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("p95 — nearest rank, not interpolation", () => {
  test("an empty window is 0 rather than NaN", () => {
    expect(p95([])).toBe(0);
  });

  test("the rank for a full window is index 60 of 64", () => {
    // Pinned by VALUE rather than re-derived, because the formula is the
    // contract the Lua side reproduces: ceil(0.95 * 64) - 1 = 60.
    const samples = Array.from({ length: SAMPLE_WINDOW }, (_, i) => i);
    expect(p95(samples)).toBe(60);
  });

  test("it answers a value that was actually observed", () => {
    // Interpolation would answer 15, which nothing ever measured. A latency a
    // human compares against a budget must be a real reading.
    expect(p95([10, 20])).toBe(20);
  });

  test("the input is not mutated", () => {
    const samples = [5, 1, 3];
    p95(samples);
    expect(samples).toEqual([5, 1, 3]);
  });
});

describe("threshold", () => {
  test("a call inside its budget reports NOTHING", () => {
    const h = harness();
    for (let i = 0; i < 1000; i += 1) h.timers.record("load", 50, 10);
    expect(h.reported).toHaveLength(0);
  });

  test("the FIRST breach of a session is reported immediately", () => {
    // The cooldown starts at 0 rather than at `now()` precisely so this
    // works: an armed cooldown would swallow the breach a player is in the
    // middle of reporting.
    const h = harness(10_000_000);
    h.timers.record("load", 50, 4000);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.kind).toBe("threshold");
    expect(h.reported[0]?.durationMs).toBe(4000);
    expect(h.reported[0]?.suppressed).toBe(0);
  });

  test("a storm inside the cooldown produces ONE report, and the volume survives", () => {
    const h = harness();
    h.timers.record("tick", 16, 900);
    for (let i = 0; i < 4000; i += 1) h.timers.record("tick", 16, 900);
    expect(h.reported).toHaveLength(1);

    h.advance(THRESHOLD_COOLDOWN_MS);
    h.timers.record("tick", 16, 900);
    expect(h.reported).toHaveLength(2);
    // The rows were dropped; the COUNT was not. This is the difference between
    // "this happened once" and "this happened 4,000 times and we said once".
    expect(h.reported[1]?.suppressed).toBe(4000);
  });

  test("the suppressed counter resets after it has been reported", () => {
    const h = harness();
    h.timers.record("tick", 16, 900);
    h.timers.record("tick", 16, 900);
    h.advance(THRESHOLD_COOLDOWN_MS);
    h.timers.record("tick", 16, 900);
    expect(h.reported[1]?.suppressed).toBe(1);
    h.advance(THRESHOLD_COOLDOWN_MS);
    h.timers.record("tick", 16, 900);
    expect(h.reported[2]?.suppressed).toBe(0);
  });

  test("two operations have independent cooldowns", () => {
    const h = harness();
    h.timers.record("a", 10, 100);
    h.timers.record("b", 10, 100);
    expect(h.reported.map((r) => r.operation)).toEqual(["a", "b"]);
  });
});

describe("p95 reporting — the habitually slow path a threshold cannot see", () => {
  /**
   * THE CASE THE WHOLE CHANNEL EXISTS FOR, and the one that proved the first
   * implementation of it could never fire. 40 ms EVERY time against a 50 ms
   * budget: nothing breaches, the threshold channel is silent, and the machine
   * is plainly too slow. 40 is 80% of 50, which is `P95_BUDGET_FRACTION`.
   */
  test("a call that habitually runs at its budget's edge is reported", () => {
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW - 1; i += 1) h.timers.record("load", 50, 40);
    // Nothing yet: the window is not full.
    expect(h.reported).toHaveLength(0);
    h.timers.record("load", 50, 40);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.kind).toBe("p95");
    expect(h.reported[0]?.durationMs).toBe(40);
    expect(h.reported[0]?.sampleCount).toBe(SAMPLE_WINDOW);
    // `suppressed` is 0 on a p95 report: nothing was withheld, this is a
    // reading rather than one of many occurrences.
    expect(h.reported[0]?.suppressed).toBe(0);
  });

  test("a partially filled window never reports a p95", () => {
    // A p95 over nine samples is the maximum wearing a different name.
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW - 1; i += 1) h.timers.record("load", 50, 40);
    h.advance(P95_INTERVAL_MS * 10);
    expect(h.reported.filter((r) => r.kind === "p95")).toHaveLength(0);
  });

  test("a comfortably fast operation is never reported, however many calls", () => {
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW * 20; i += 1) {
      h.timers.record("load", 500, 10);
      h.advance(1);
    }
    expect(h.reported).toHaveLength(0);
  });

  test("the interval bounds it: one p95 report per five minutes, not per call", () => {
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW; i += 1) h.timers.record("load", 50, 40);
    expect(h.reported).toHaveLength(1);
    for (let i = 0; i < 5000; i += 1) h.timers.record("load", 50, 40);
    expect(h.reported).toHaveLength(1);
    h.advance(P95_INTERVAL_MS);
    h.timers.record("load", 50, 40);
    expect(h.reported).toHaveLength(2);
  });

  test("the window is a RING, so a machine that recovers stops reporting", () => {
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW; i += 1) h.timers.record("load", 50, 40);
    expect(h.reported).toHaveLength(1);
    // A whole window of fast calls displaces the slow ones.
    for (let i = 0; i < SAMPLE_WINDOW; i += 1) h.timers.record("load", 50, 1);
    h.advance(P95_INTERVAL_MS);
    h.timers.record("load", 50, 1);
    expect(h.reported).toHaveLength(1);
  });

  test("a p95 report cannot be produced by a threshold breach", () => {
    // The redundancy that killed the first implementation, pinned so it
    // cannot come back: a sample at or above the budget is a THRESHOLD event,
    // and it must not also arrive as a p95.
    const h = harness();
    for (let i = 0; i < SAMPLE_WINDOW * 2; i += 1) h.timers.record("load", 50, 900);
    expect(h.reported.filter((r) => r.kind === "p95")).toHaveLength(0);
  });
});

describe("timed / timedAsync", () => {
  test("the call's value is returned unchanged", () => {
    const h = harness();
    expect(h.timers.timed("x", 10, () => 42)).toBe(42);
  });

  test("a THROWING call is still timed, and still throws", () => {
    // The slowest call on a machine in trouble is frequently the one that then
    // throws; a timer that only recorded successes would miss exactly that.
    const h = harness();
    let threw = false;
    try {
      h.timers.timed("boom", 0, () => {
        throw new Error("x");
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(h.reported).toHaveLength(1);
  });

  test("a rejecting async call is still timed, and still rejects", async () => {
    const h = harness();
    await expect(
      h.timers.timedAsync("boom", 0, async () => {
        throw new Error("x");
      })
    ).rejects.toThrow("x");
    expect(h.reported).toHaveLength(1);
  });
});

describe("input hygiene", () => {
  test("a negative or non-finite duration is ignored rather than recorded", () => {
    // `performance.now()` differences cannot be negative, but `GetGameTimer()`
    // across a resource restart can be, and a -2^31 sample would poison a p95
    // for a whole window.
    const h = harness();
    h.timers.record("x", 0, -5);
    h.timers.record("x", 0, Number.NaN);
    h.timers.record("x", 0, Number.POSITIVE_INFINITY);
    expect(h.reported).toHaveLength(0);
  });

  test("a zero duration is legal — GetGameTimer has millisecond resolution", () => {
    const h = harness();
    h.timers.record("x", 0, 0);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.durationMs).toBe(0);
  });
});
