/**
 * The queue. Bounded in every direction, and the bounds are the feature.
 *
 * THE OFFLINE RULE IS ABSOLUTE
 *
 * `tWeb` must be able to go totally offline with nothing in this estate
 * degrading. For a queue that means three properties, and each one is a thing
 * the obvious implementation gets wrong:
 *
 *   1. **It never grows.** A ring, oldest dropped. An array that grows while the
 *      sink is unreachable is a memory leak whose size is a function of how long
 *      the website is down — which is the one variable we do not control.
 *   2. **A drop is counted, not silent.** `drops` rides out on the next
 *      successful flush as a measure, so "we lost 4,000 events" is a number
 *      somebody can read rather than a gap nobody notices.
 *   3. **One client cannot evict everybody else.** A client in a render loop can
 *      throw thousands of times a second. Without a per-client floor, the first
 *      broken install fills the ring and every other player's faults are what
 *      the ring drops. `MAX_EVENTS_PER_CLIENT_PER_MINUTE` is that floor.
 *
 * The per-client budget is swept on `playerDropped`, for the reason
 * `tlib.ratelimit` exists: without it every bucket keeps one entry per player
 * who has ever connected, for the life of the server.
 */

import {
  type DiagEvent,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_CLIENT_PER_MINUTE,
  MAX_QUEUED_EVENTS,
  unsafeDimensions,
} from "../../../shared/ts/telemetry/payload";

export interface QueuedEvent {
  event: string;
  at: number;
  dimensions: Record<string, string>;
  measures: Record<string, number>;
  /**
   * `tlib.error_reported` only, and a SIBLING of `dimensions`. It is carried
   * through the queue verbatim because it has already been scrubbed at the point
   * of capture — a non-zero `redactions` count on a stored stack is a bug in
   * this emitter and nothing else will report it.
   */
  stack?: string;
}

export interface Store {
  /**
   * Accept one batch from one source.
   *
   * `src` is the player id, or `0` for the server's own events. Answers what was
   * taken and what was refused, because a caller that cannot tell "accepted" from
   * "rate limited" cannot report either.
   */
  accept(
    src: number,
    events: DiagEvent[]
  ): { accepted: number; rateLimited: number; unsafe: number };
  /** Up to `MAX_EVENTS_PER_BATCH` events, removed from the queue. */
  takeEvents(): QueuedEvent[];
  /** Put a failed batch back at the FRONT. See `transport.ts` on why. */
  returnEvents(events: QueuedEvent[]): void;
  /** Drops since the last read, and zeroes the counter. */
  readDrops(): number;
  forget(src: number | null): void;
  size(): { events: number };
  clear(): void;
}

interface Bucket {
  windowStartedAt: number;
  count: number;
}

export function createStore(now: () => number = () => Date.now()): Store {
  const events: QueuedEvent[] = [];
  const buckets = new Map<number, Bucket>();
  let drops = 0;

  /** `true` when this source has already spent its minute. */
  function overBudget(src: number): boolean {
    // The server's own events (`src === 0`) are NOT rate limited. They are
    // produced by our code at our own call sites, the volume is bounded by the
    // ring regardless, and limiting them would mean a server-side fault storm
    // is the one thing that cannot be reported.
    if (src === 0) return false;
    const t = now();
    let b = buckets.get(src);
    if (!b || t - b.windowStartedAt >= 60_000) {
      b = { windowStartedAt: t, count: 0 };
      buckets.set(src, b);
    }
    if (b.count >= MAX_EVENTS_PER_CLIENT_PER_MINUTE) return true;
    b.count += 1;
    return false;
  }

  function push(queue: unknown[], item: unknown, cap: number, countDrop: boolean): void {
    queue.push(item);
    while (queue.length > cap) {
      queue.shift();
      if (countDrop) drops += 1;
    }
  }

  return {
    accept(src, incoming) {
      let accepted = 0;
      let rateLimited = 0;
      let unsafe = 0;

      for (const event of Array.isArray(incoming) ? incoming : []) {
        if (!event || typeof event.event !== "string" || typeof event.at !== "number") continue;
        const dimensions = event.dimensions ?? {};
        const measures = event.measures ?? {};
        // REFUSED HERE RATHER THAN SENT AND REFUSED THERE. tWeb's ingest
        // answers a bad dimension with a counted `unsafe_dimension` and a
        // dropped event — visible on its Overview and invisible to us. Checking
        // locally turns a silent remote refusal into a number this side can
        // report and a unit test can pin.
        if (unsafeDimensions(dimensions).length > 0) {
          unsafe += 1;
          continue;
        }
        if (overBudget(src)) {
          rateLimited += 1;
          continue;
        }
        push(
          events,
          {
            event: event.event,
            at: event.at,
            dimensions,
            measures,
            // Only where the contract allows one. A `stack` on any other
            // event is refused, and the refusal costs the whole event.
            ...(event.event === "tlib.error_reported" && typeof event.stack === "string"
              ? { stack: event.stack }
              : {}),
          },
          MAX_QUEUED_EVENTS,
          true
        );
        accepted += 1;
      }

      return { accepted, rateLimited, unsafe };
    },

    takeEvents() {
      return events.splice(0, MAX_EVENTS_PER_BATCH);
    },

    /**
     * FRONT, not back, and bounded by the same ring.
     *
     * A failed batch is the OLDEST data we have. Returning it to the back would
     * make a flapping sink reorder the queue so that the events most likely to
     * be dropped are the ones that have already survived longest — i.e. a
     * permanent starvation of the oldest events, which are the ones a crash
     * report's context lives in. Re-capping afterwards is what keeps the return
     * from being the one unbounded path.
     */
    returnEvents(returned) {
      events.unshift(...returned);
      while (events.length > MAX_QUEUED_EVENTS) {
        events.pop();
        drops += 1;
      }
    },

    readDrops() {
      const d = drops;
      drops = 0;
      return d;
    },

    forget(src) {
      if (src === null) {
        buckets.clear();
        return;
      }
      buckets.delete(src);
    },

    size() {
      return { events: events.length };
    },

    clear() {
      events.length = 0;
      buckets.clear();
      drops = 0;
    },
  };
}
