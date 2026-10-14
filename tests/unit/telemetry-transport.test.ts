/**
 * The transport, and the offline rule.
 *
 * `tWeb` MUST BE ABLE TO GO TOTALLY OFFLINE. That is not a nice-to-have in
 * this estate — it is the standing rule, and the cost of breaking it lands on
 * customers' game servers rather than on us. What it means for an outbound
 * sender is four properties, and each of the four has an obvious implementation
 * that gets it wrong:
 *
 *   1. one request in flight, ever — otherwise a slow sink turns a fixed
 *      interval into unbounded concurrency;
 *   2. a bounded number of attempts while the sink is down — otherwise "the
 *      website is down for a day" is 1,440 requests per customer server;
 *   3. a refusal that retrying cannot fix stops permanently — 401/403/404 —
 *      otherwise a missing credential IS the retry storm;
 *   4. a refusal that cannot be fixed by retrying drops its batch rather than
 *      requeueing it, otherwise the queue can never drain and the ring spends
 *      the session evicting newer events to hold events nothing will accept.
 *
 * AND NOTHING HERE MAY BLOCK. Every assertion below drives the real
 * callback-based shape rather than an `await`ed one, because that is the shape
 * `PerformHttpRequest` has and the reason this module cannot be written with
 * `fetch`.
 */

import { describe, expect, test } from "bun:test";
import { createStore } from "../../server/lib/telemetry/store";
import {
  BREAKER_BASE_COOLDOWN_MS,
  createTransport,
  FAILURES_BEFORE_OPEN,
  type PostFn,
} from "../../server/lib/telemetry/transport";

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function harness(opts: { enabled?: boolean; credential?: string; install?: string } = {}) {
  let now = 1_000_000;
  const sent: Sent[] = [];
  const pending: Array<(status: number, body: string, headers: Record<string, string>) => void> =
    [];
  const logs: string[] = [];
  const store = createStore(() => now);

  const post: PostFn = (url, body, headers, done) => {
    sent.push({ url, body, headers });
    pending.push(done);
  };

  const transport = createTransport({
    store,
    baseUrl: () => "https://example.invalid",
    enabled: () => opts.enabled !== false,
    installId: () => opts.install ?? "abcdefghijklmnopqrstuvwxy",
    credential: () => opts.credential ?? "test-key",
    now: () => now,
    post,
    log: (line) => logs.push(line),
  });

  return {
    store,
    transport,
    sent,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    /** Answer the oldest open request. */
    answer(status: number, headers: Record<string, string> = {}) {
      const done = pending.shift();
      if (!done) throw new Error("no request was open");
      done(status, "", headers);
    },
    open: () => pending.length,
  };
}

const event = (n: number) => ({
  event: "tlib.error_reported",
  at: n,
  dimensions: { fingerprint: "00000001" },
  measures: { causeDepth: 0 },
});

describe("the happy path", () => {
  test("one POST carries the whole batch to the analytics ingest", () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) h.store.accept(0, [event(i)]);
    expect(h.transport.flush().events).toBe("sent");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe("https://example.invalid/api/v1/analytics/events");
    const body = JSON.parse(h.sent[0]?.body ?? "{}");
    // `server`, because the game server is what posts. The consequence is
    // that tWeb drops `sessionKey` for a server sender, which is why the
    // per-install id travels as a DIMENSION and no session key is sent at all.
    expect(body.senderKind).toBe("server");
    expect(body.events).toHaveLength(40);
    expect(body.sessionKey).toBeUndefined();
    expect(body.subjectKey).toBeUndefined();
  });

  test("the install id is stamped onto every event, under tWeb's name", () => {
    const h = harness({ install: "zzzzzzzzzzzzzzzzzzzzzzzzz" });
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    const body = JSON.parse(h.sent[0]?.body ?? "{}");
    // `installId`, not `install`. A dimension name the taxonomy does not
    // declare is not a renamed column, it is no column.
    expect(body.events[0].dimensions.installId).toBe("zzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  test("an absent install id leaves the dimension OUT rather than empty", () => {
    const h = harness({ install: "" });
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    const body = JSON.parse(h.sent[0]?.body ?? "{}");
    expect("installId" in body.events[0].dimensions).toBe(false);
  });

  test("⚠️ a `stack` travels as a SIBLING of dimensions, never inside it", () => {
    const h = harness();
    h.store.accept(0, [{ ...event(1), stack: "TypeError: x" }] as never);
    h.transport.flush();
    const body = JSON.parse(h.sent[0]?.body ?? "{}");
    expect(body.events[0].stack).toBe("TypeError: x");
    expect(body.events[0].dimensions.stack).toBeUndefined();
  });

  test("the credential travels as a bearer token", () => {
    const h = harness({ credential: "k1" });
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    expect(h.sent[0]?.headers.Authorization).toBe("Bearer k1");
  });

  test("⚠️ the ring's losses are SAID OUT LOUD, because there is no slot to send them in", () => {
    /**
     * An earlier draft added a `queueDropped` measure to the first event of a
     * batch. The taxonomy declares no such measure, and an undeclared measure is
     * dropped — so the number would have looked sent and arrived nowhere, which
     * is the worst of the three options. It goes to the server console instead,
     * where an operator investigating a gap would look, and the counter is still
     * READ so it cannot grow for the life of the server.
     */
    const h = harness();
    for (let i = 0; i < 520; i += 1) h.store.accept(0, [event(i)]);
    h.transport.flush();
    const body = JSON.parse(h.sent[0]?.body ?? "{}");
    expect(body.events[0].measures.queueDropped).toBeUndefined();
    expect(h.logs.join(" ")).toContain("dropped");
  });

  test("an empty queue sends nothing at all", () => {
    const h = harness();
    expect(h.transport.flush().events).toBe("empty");
    expect(h.sent).toHaveLength(0);
  });
});

describe("the gates", () => {
  test("consent off sends nothing, and is asked on EVERY flush", () => {
    const h = harness({ enabled: false });
    h.store.accept(0, [event(1)]);
    expect(h.transport.flush().events).toBe("disabled");
    expect(h.sent).toHaveLength(0);
  });

  test("no credential sends nothing — and that is the shipped default today", () => {
    const h = harness({ credential: "" });
    h.store.accept(0, [event(1)]);
    expect(h.transport.flush().events).toBe("no-credential");
  });

  test("a second flush while one is in flight is SKIPPED, not queued", () => {
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.store.accept(0, [event(2)]);
    expect(h.transport.flush().events).toBe("in-flight");
    expect(h.sent).toHaveLength(1);
  });
});

describe("the breaker", () => {
  test("two failures do not open it; the third does", () => {
    const h = harness();
    for (let i = 0; i < FAILURES_BEFORE_OPEN; i += 1) {
      h.store.accept(0, [event(i)]);
      expect(h.transport.flush().events).toBe("sent");
      h.answer(500);
    }
    expect(h.sent).toHaveLength(FAILURES_BEFORE_OPEN);
    // Now it is open.
    expect(h.transport.flush().events).toBe("breaker-open");
  });

  test("a failed batch is requeued, so nothing is lost to one 500", () => {
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.answer(500);
    expect(h.store.size().events).toBe(1);
  });

  test("the cooldown DOUBLES each re-open, so a day of downtime is ~30 requests", () => {
    const h = harness();
    const open = () => {
      for (let i = 0; i < FAILURES_BEFORE_OPEN; i += 1) {
        h.store.accept(0, [event(i)]);
        h.transport.flush();
        if (h.open() > 0) h.answer(500);
      }
    };
    open();
    expect(h.transport.state().events.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS * 2);
    h.advance(BREAKER_BASE_COOLDOWN_MS);
    open();
    expect(h.transport.state().events.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS * 4);
  });

  test("a success resets the failure count and the cooldown", () => {
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.answer(500);
    expect(h.transport.state().events.consecutiveFailures).toBe(1);
    h.transport.flush();
    h.answer(202);
    expect(h.transport.state().events.consecutiveFailures).toBe(0);
    expect(h.transport.state().events.cooldownMs).toBe(BREAKER_BASE_COOLDOWN_MS);
  });

  test("Retry-After opens the breaker on the FIRST 429 and is obeyed", () => {
    // The ingest answers 429 with Retry-After: 60. Ignoring it and retrying
    // twice more before opening is how a rate limit becomes a ban.
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.answer(429, { "Retry-After": "120" });
    expect(h.transport.flush().events).toBe("breaker-open");
    h.advance(119_000);
    expect(h.transport.flush().events).toBe("breaker-open");
    h.advance(2_000);
    expect(h.transport.flush().events).toBe("sent");
  });

  test("a timeout — status 0 — is a failure like any other", () => {
    // `PerformHttpRequest` has NO timeout, so the wrapper supplies one. A
    // callback that never fires would otherwise leave `inFlight` true for the
    // life of the server and the transport silently dead.
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.answer(0);
    expect(h.transport.state().events.consecutiveFailures).toBe(1);
    expect(h.store.size().events).toBe(1);
  });
});

describe("permanent refusals", () => {
  for (const status of [401, 403, 404]) {
    test(`HTTP ${status} stops for the session rather than retrying`, () => {
      const h = harness();
      h.store.accept(0, [event(1)]);
      h.transport.flush();
      h.answer(status);
      expect(h.transport.state().events.permanentlyStopped).toBeTruthy();
      expect(h.transport.flush().events).toBe("permanent");
      // And the batch is DROPPED rather than requeued. A permanently refused
      // batch in the queue is a queue that can never drain and a ring that
      // spends the session evicting newer events to hold events nothing will
      // ever accept.
      expect(h.store.size().events).toBe(0);
    });
  }

  test("it says why, once, on the server console", () => {
    const h = harness();
    h.store.accept(0, [event(1)]);
    h.transport.flush();
    h.answer(401);
    expect(h.logs.join("\n")).toContain("401");
  });
});

describe("one endpoint, and an earlier draft had two", () => {
  test("⚠️ nothing is posted anywhere but the analytics ingest", () => {
    /**
     * The text half of a report was going to a `/api/v1/diagnostics/reports`
     * that would have had to be built, with its own breaker so an unbuilt
     * endpoint could not take down the one that works. It is gone: the ingest
     * takes a top-level `stack` on `tlib.error_reported` and keeps one readable
     * copy per `(day, stackHash)`. Asserted rather than assumed, because a
     * second POST to a route that does not exist is a 404 per batch forever and
     * the breaker would hide it.
     */
    const h = harness();
    h.store.accept(0, [{ ...event(1), stack: "TypeError: x" }] as never);
    h.transport.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe("https://example.invalid/api/v1/analytics/events");
  });
});
