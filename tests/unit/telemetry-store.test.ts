/**
 * The queue, and the three bounds that make the offline rule real.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. `tWeb` must be able to go totally
 * offline with nothing in this estate degrading. The failure modes a queue
 * invites are all of the "it works until it matters" kind:
 *
 *   • an array that grows while the sink is unreachable is a leak whose size is
 *     a function of how long someone else's website is down;
 *   • a drop that is silent is a gap in the data nobody knows about;
 *   • one client in a render loop evicting everybody else's faults means the
 *     feed goes blind precisely when something is wrong.
 */

import { describe, expect, test } from "bun:test";
import { createStore } from "../../server/lib/telemetry/store";
import {
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_CLIENT_PER_MINUTE,
  MAX_QUEUED_EVENTS,
} from "../../shared/ts/telemetry/payload";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const event = (n: number) => ({
  event: "tlib.error_reported",
  at: n,
  dimensions: { fingerprint: `000000${(n % 100).toString().padStart(2, "0")}` },
  measures: { causeDepth: 0 },
});

describe("the ring", () => {
  test("never exceeds its cap, however much arrives", () => {
    const store = createStore(clock().now);
    for (let i = 0; i < MAX_QUEUED_EVENTS * 3; i += 1) store.accept(0, [event(i)]);
    expect(store.size().events).toBe(MAX_QUEUED_EVENTS);
  });

  test("drops the OLDEST and counts the drop", () => {
    const store = createStore(clock().now);
    for (let i = 0; i < MAX_QUEUED_EVENTS + 10; i += 1) store.accept(0, [event(i)]);
    expect(store.readDrops()).toBe(10);
    // The newest survive: they describe whatever is wrong now.
    const taken = store.takeEvents();
    expect(taken[0]?.at).toBe(10);
  });

  test("readDrops zeroes the counter, so a count is reported once", () => {
    const store = createStore(clock().now);
    for (let i = 0; i < MAX_QUEUED_EVENTS + 5; i += 1) store.accept(0, [event(i)]);
    expect(store.readDrops()).toBe(5);
    expect(store.readDrops()).toBe(0);
  });

  test("⚠️ a `stack` survives the queue, and ONLY on the event that may carry one", () => {
    /**
     * `tlib.error_reported` is the only event with a `stack` slot, and it is a
     * SIBLING of `dimensions` rather than a member of it — the charset would
     * refuse it there and the refusal costs the whole event. A `stack` on any
     * other event is refused too, so it is stripped here rather than sent.
     */
    const store = createStore(clock().now);
    store.accept(0, [{ ...event(1), stack: "TypeError: x\n    at f (nui/a.js:1)" }] as never);
    store.accept(0, [
      { ...event(2), event: "tlib.crash_reported", stack: "should not travel" },
    ] as never);
    const taken = store.takeEvents();
    expect(taken[0]?.stack).toContain("TypeError");
    expect(taken[1]?.stack).toBeUndefined();
  });
});

describe("takeEvents / returnEvents", () => {
  test("a take is capped at one batch", () => {
    const store = createStore(clock().now);
    for (let i = 0; i < MAX_QUEUED_EVENTS; i += 1) store.accept(0, [event(i)]);
    expect(store.takeEvents()).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  test("a failed batch goes back to the FRONT", () => {
    /**
     * Front and not back. A failed batch is the OLDEST data we have;
     * returning it to the back would make a flapping sink permanently starve the
     * events that have already survived longest — which is where a crash
     * report's leading context lives.
     */
    const store = createStore(clock().now);
    for (let i = 0; i < 5; i += 1) store.accept(0, [event(i)]);
    const batch = store.takeEvents();
    store.accept(0, [event(99)]);
    store.returnEvents(batch);
    expect(store.takeEvents().map((e) => e.at)).toEqual([0, 1, 2, 3, 4, 99]);
  });

  test("a return is bounded by the same ring, so it cannot be the unbounded path", () => {
    const store = createStore(clock().now);
    for (let i = 0; i < MAX_QUEUED_EVENTS; i += 1) store.accept(0, [event(i)]);
    const batch = store.takeEvents();
    store.readDrops();
    // Refill to the cap while the batch is in flight, then fail it.
    for (let i = 0; i < MAX_EVENTS_PER_BATCH; i += 1) store.accept(0, [event(1000 + i)], []);
    store.returnEvents(batch);
    expect(store.size().events).toBe(MAX_QUEUED_EVENTS);
    expect(store.readDrops()).toBeGreaterThan(0);
  });
});

describe("the per-client floor", () => {
  test("one client cannot spend more than its minute", () => {
    const store = createStore(clock().now);
    const burst = Array.from({ length: 500 }, (_, i) => event(i));
    const r = store.accept(7, burst);
    expect(r.accepted).toBe(MAX_EVENTS_PER_CLIENT_PER_MINUTE);
    expect(r.rateLimited).toBe(500 - MAX_EVENTS_PER_CLIENT_PER_MINUTE);
  });

  test("one client's flood does not spend another client's budget", () => {
    const store = createStore(clock().now);
    store.accept(
      7,
      Array.from({ length: 500 }, (_, i) => event(i))
    );
    expect(store.accept(8, [event(1)]).accepted).toBe(1);
  });

  test("the budget refills after a minute", () => {
    const c = clock();
    const store = createStore(c.now);
    store.accept(
      7,
      Array.from({ length: 500 }, (_, i) => event(i))
    );
    c.advance(60_000);
    expect(store.accept(7, [event(1)]).accepted).toBe(1);
  });

  test("the SERVER's own events are not rate limited", () => {
    // They come from our code at our own call sites, the ring bounds them
    // regardless, and limiting them would make a server-side fault storm the one
    // thing that cannot be reported.
    const store = createStore(clock().now);
    const r = store.accept(
      0,
      Array.from({ length: 300 }, (_, i) => event(i))
    );
    expect(r.rateLimited).toBe(0);
  });

  test("forget(src) drops one player's bucket and forget(null) drops all", () => {
    // The sweep is the half a hand-written limiter forgets. Without it every
    // bucket keeps one entry per player who has EVER connected, for the life of
    // the server.
    const store = createStore(clock().now);
    store.accept(
      7,
      Array.from({ length: 500 }, (_, i) => event(i))
    );
    store.forget(7);
    expect(store.accept(7, [event(1)]).accepted).toBe(1);
    store.accept(
      9,
      Array.from({ length: 500 }, (_, i) => event(i))
    );
    store.forget(null);
    expect(store.accept(9, [event(1)]).accepted).toBe(1);
  });
});

describe("validation at the door", () => {
  test("an event whose dimension the ingest would refuse is refused HERE", () => {
    /**
     * Refused locally rather than sent and refused remotely. On the other
     * side a bad dimension is a counted `unsafe_dimension` and a dropped event —
     * visible on tWeb's Overview and invisible to us. Locally it is a number
     * this side can report and a test can pin.
     */
    const store = createStore(clock().now);
    const r = store.accept(0, [{ ...event(1), dimensions: { message: "has a space" } }]);
    expect(r.unsafe).toBe(1);
    expect(r.accepted).toBe(0);
    expect(store.size().events).toBe(0);
  });

  test("an empty dimension value is accepted — it is omitted, not illegal", () => {
    const store = createStore(clock().now);
    expect(store.accept(0, [{ ...event(1), dimensions: { gpuModel: "" } }]).accepted).toBe(1);
  });

  test("a malformed event is skipped rather than throwing", () => {
    const store = createStore(clock().now);
    const r = store.accept(0, [null, undefined, {}, { event: "x" }, event(1)] as never);
    expect(r.accepted).toBe(1);
  });

  test("a non-array payload is survivable", () => {
    const store = createStore(clock().now);
    expect(() => store.accept(0, "nope" as never)).not.toThrow();
    expect(store.size()).toEqual({ events: 0 });
  });
});
