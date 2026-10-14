/**
 * The socket-level test the Stream Deck link layer never had.
 *
 * Why this file exists
 *
 * Three products each ran their own copy of this transport, and the copies had
 * quietly diverged into a set of fixes that never travelled between them: one
 * had a bounded bind budget and two did not, one held its fault state where a
 * late-mounting key could read it and two did not, one merged snapshots onto its
 * offline defaults and one assigned them wholesale. Every one of those is a
 * behaviour a test would have pinned. There was no test — not in any of the
 * three — and the deck galleries test only the RENDERING, so nothing anywhere
 * exercised a socket. That is a large part of why the fixes stayed put.
 *
 * These tests bind real loopback sockets and speak the real protocol. They cover
 * bind contention and the retry budget, stale expiry, both keepalive layers,
 * reconnect backoff, fault state read by a late subscriber, and the hold grace.
 *
 * The negative controls
 *
 * A test that cannot fail measures nothing, and this repo has shipped several of
 * those. So each of the four load-bearing properties also has a control that
 * plants the OPPOSITE configuration and requires the probe to come out the other
 * way. If the shared layer ever stops implementing bounded retries, the stale
 * watchdog, snapshot de-duplication or the liveness re-arm, the matching control
 * and its test will disagree and one of them goes red. They are in the
 * `negative control` block at the bottom and they are not optional decoration:
 * they are the reason the assertions above them are worth anything.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocket as WsClient } from "ws";
import {
  createDeckLinkServer,
  type DeckLinkLogger,
  type DeckLinkServer,
} from "../../shared/ts/deck/link-server.ts";
import { createDeckLinkClient, reconnectDelayFor } from "../../shared/ts/deck/page/link.ts";
import { DECK_PORTS, KEEPALIVE_MS, PING_MS, STALE_MS } from "../../shared/ts/deck/protocol.ts";

/* Fixtures */

type Snap = { a: number; b: string };
type Source = "radio" | "dispatch";

const offlineFor = (source: Source): Snap => ({ a: 0, b: `offline:${source}` });

/** A logger that keeps what it was told, so a test can assert on it. */
function recorder(): DeckLinkLogger & { lines: string[]; of(level: string): string[] } {
  const lines: string[] = [];
  return {
    lines,
    of: (level) => lines.filter((l) => l.startsWith(`${level}:`)),
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    debug: (m) => lines.push(`debug:${m}`),
  };
}

/** Claim a free loopback port by binding one and letting it go. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  const addr = s.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

/** Hold a port open, so the link under test hits EADDRINUSE. */
async function occupy(port: number): Promise<() => Promise<void>> {
  const s = createServer();
  await new Promise<void>((res, rej) => {
    s.once("error", rej);
    s.listen(port, "127.0.0.1", res);
  });
  return () => new Promise<void>((res) => s.close(() => res()));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `cond` or the budget runs out. Returns whether it came true. */
async function until(cond: () => boolean, budgetMs = 2000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function makeServer(
  port: number,
  over: Partial<Parameters<typeof createDeckLinkServer<Snap, Source>>[0]> = {}
) {
  const log = recorder();
  const updates: Array<{ source: Source; snap: Snap; connected: boolean }> = [];
  const faults: string[] = [];
  const link: DeckLinkServer<Snap, Source> = createDeckLinkServer<Snap, Source>({
    port,
    sources: ["radio", "dispatch"],
    offlineFor,
    log,
    defaultSource: "radio",
    keepProcessAlive: true,
    ...over,
  });
  link.on("update", (source, snap, connected) => updates.push({ source, snap, connected }));
  link.on("fault", (t) => faults.push(t));
  cleanups.push(() => link.stop());
  return { link, log, updates, faults };
}

/** A raw page-side peer, for driving the server without the client half. */
async function peer(port: number): Promise<WsClient> {
  const ws = new WsClient(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  cleanups.push(() => {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  });
  return ws;
}

/* The protocol constants */

describe("deck protocol", () => {
  test("the three ports are distinct and frozen", () => {
    const values = Object.values(DECK_PORTS);
    expect(new Set(values).size).toBe(values.length);
    // Frozen numbers: changing one orphans every player whose plugin and
    // resource are not updated together. Asserted literally on purpose.
    expect(DECK_PORTS).toEqual({ tRadio: 21398, tRadar: 21399, tELS: 21400 });
  });

  test("the watchdog is comfortably longer than either keepalive layer", () => {
    // A healthy peer must not race its own watchdog. Both layers have to fit
    // inside STALE_MS with room for a missed beat.
    expect(STALE_MS).toBeGreaterThan(KEEPALIVE_MS * 2);
    expect(STALE_MS).toBeGreaterThan(PING_MS * 2);
  });
});

/* Bind contention and the retry budget */

describe("deck link server: binding", () => {
  test("binds loopback and reports the port", async () => {
    const port = await freePort();
    const { link, log } = makeServer(port);
    const listening: number[] = [];
    link.on("listening", (p) => listening.push(p));
    link.start();
    expect(await until(() => listening.length > 0)).toBe(true);
    expect(listening[0]).toBe(port);
    expect(link.boundPort()).toBe(port);
    expect(link.fault()).toBeNull();
    expect(log.of("info").some((l) => l.includes("listening"))).toBe(true);
  });

  test("retries a busy port a BOUNDED number of times, then faults visibly", async () => {
    const port = await freePort();
    const release = await occupy(port);
    cleanups.push(release);

    const { link, log, faults } = makeServer(port, { maxBindAttempts: 3, rebindMs: 20 });
    link.start();

    expect(await until(() => faults.length > 0)).toBe(true);

    // Exactly one fault, not one per attempt.
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain(String(port));
    // The budget: attempts 1 and 2 warn and retry, attempt 3 gives up. So two
    // retry warnings — not three, and crucially not unbounded.
    const retries = log.of("warn").filter((l) => l.includes("busy"));
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain("retry 1/3");
    expect(retries[1]).toContain("retry 2/3");
    // And it said so at error level, which is what makes a collision findable.
    expect(log.of("error").some((l) => l.includes(`port ${port}`))).toBe(true);

    // It really has stopped: no further attempts after giving up.
    await sleep(120);
    expect(log.of("warn").filter((l) => l.includes("busy"))).toHaveLength(2);
  });

  test("a LATE subscriber can still read the fault", async () => {
    const port = await freePort();
    cleanups.push(await occupy(port));
    const { link, faults } = makeServer(port, { maxBindAttempts: 2, rebindMs: 10 });
    link.start();
    expect(await until(() => faults.length > 0)).toBe(true);

    // This is the whole point of holding it as state rather than only
    // emitting it. A key that mounts now has missed the event, and without
    // this would render a perfectly normal "waiting for the game" — the most
    // misleading thing it could say, since nothing is ever going to arrive.
    expect(link.fault()).not.toBeNull();
    expect(link.fault()).toContain(String(port));
  });

  test("a fault repaints a source that has NEVER connected", async () => {
    const port = await freePort();
    cleanups.push(await occupy(port));
    const { link, updates, faults } = makeServer(port, { maxBindAttempts: 2, rebindMs: 10 });
    link.start();
    expect(await until(() => faults.length > 0)).toBe(true);

    // Both declared sources are repainted, though neither ever had a socket.
    const repainted = new Set(updates.filter((u) => !u.connected).map((u) => u.source));
    expect(repainted.has("radio")).toBe(true);
    expect(repainted.has("dispatch")).toBe(true);
  });

  test("a successful bind after failures clears the budget and the fault", async () => {
    const port = await freePort();
    const release = await occupy(port);
    const { link, faults } = makeServer(port, { maxBindAttempts: 50, rebindMs: 20 });
    link.start();
    // Let it fail a couple of times, then free the port.
    await sleep(60);
    expect(faults).toHaveLength(0);
    await release();
    expect(await until(() => link.boundPort() != null, 3000)).toBe(true);
    expect(link.fault()).toBeNull();
  });
});

/* State frames */

describe("deck link server: state", () => {
  test("offline defaults until a snapshot arrives", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    expect(link.stateOf("radio")).toEqual({ a: 0, b: "offline:radio" });
    expect(link.isConnected("radio")).toBe(false);
  });

  test("a partial snapshot is MERGED onto the offline defaults", async () => {
    const port = await freePort();
    const { link, updates } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);

    // `b` is omitted. It must come out as the offline value, not `undefined`
    // reaching a draw function — the bug tELS had by assigning wholesale.
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 7 }));
    expect(await until(() => updates.some((u) => u.connected))).toBe(true);

    // `b` is omitted. It must come out as the offline value, not `undefined`.
    expect(link.stateOf("radio")).toMatchObject({ a: 7, b: "offline:radio" });
    expect(link.isConnected("radio")).toBe(true);

    // The envelope keys ride along in the snapshot, because the default
    // `readSnapshot` is the whole frame. That is deliberate and is what the
    // shipped products rely on — tRadio's and tRadar's snapshot types declare
    // `type`, `source` and a version field as part of the snapshot. Asserted
    // so a future "tidy-up" that strips them has to come past this test.
    expect(link.stateOf("radio")).toMatchObject({ type: "state", source: "radio" });
  });

  test("readSnapshot supports a NESTED payload without losing the merge", async () => {
    const port = await freePort();
    const { link } = makeServer(port, {
      readSnapshot: (frame) => frame.payload as object,
    });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);

    // tELS's wire shape. The nesting stays a wire detail; the merge still happens.
    ws.send(JSON.stringify({ type: "state", source: "radio", payload: { a: 3 } }));
    expect(await until(() => link.stateOf("radio").a === 3)).toBe(true);
    expect(link.stateOf("radio")).toEqual({ a: 3, b: "offline:radio" });
  });

  test("two sources are tracked independently", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);
    const radio = await peer(port);
    const dispatch = await peer(port);

    radio.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    dispatch.send(JSON.stringify({ type: "state", source: "dispatch", a: 2 }));
    expect(await until(() => link.stateOf("dispatch").a === 2)).toBe(true);

    expect(link.stateOf("radio").a).toBe(1);
    expect(link.isConnected("radio")).toBe(true);
    expect(link.isConnected("dispatch")).toBe(true);
  });

  test("latest socket wins for a source", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    const first = await peer(port);
    first.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    await until(() => link.stateOf("radio").a === 1);

    let firstClosed = false;
    first.once("close", () => {
      firstClosed = true;
    });

    // A game restart can leave the previous page briefly half-open; the newer
    // feed is by definition the live one.
    const second = await peer(port);
    second.send(JSON.stringify({ type: "state", source: "radio", a: 2 }));
    expect(await until(() => link.stateOf("radio").a === 2)).toBe(true);
    expect(await until(() => firstClosed)).toBe(true);

    // And the replaced socket closing must NOT mark the source offline.
    await sleep(50);
    expect(link.isConnected("radio")).toBe(true);
    expect(link.stateOf("radio").a).toBe(2);
  });

  test("a malformed frame is dropped without killing the socket", async () => {
    const port = await freePort();
    const { link, log } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);

    ws.send("not json at all");
    expect(await until(() => log.of("warn").some((l) => l.includes("malformed")))).toBe(true);

    // Still usable afterwards.
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 9 }));
    expect(await until(() => link.stateOf("radio").a === 9)).toBe(true);
  });

  test("bye marks a source offline at once", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 5 }));
    await until(() => link.isConnected("radio"));

    ws.send(JSON.stringify({ type: "bye", source: "radio" }));
    expect(await until(() => !link.isConnected("radio"))).toBe(true);
    expect(link.stateOf("radio")).toEqual(offlineFor("radio"));
  });

  test("keepSnapshotOnDisconnect retains the last values", async () => {
    const port = await freePort();
    const { link } = makeServer(port, { keepSnapshotOnDisconnect: true });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 42 }));
    await until(() => link.stateOf("radio").a === 42);

    ws.send(JSON.stringify({ type: "bye", source: "radio" }));
    expect(await until(() => !link.isConnected("radio"))).toBe(true);
    // tELS's choice: the key switches to a "no feed" card that can still show
    // what was last true.
    expect(link.stateOf("radio").a).toBe(42);
  });

  test("send reaches an open socket and fails closed otherwise", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    // No socket yet: must fail rather than throw.
    expect(link.send("radio", { type: "command", cmd: "x" })).toBe(false);

    const ws = await peer(port);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    await until(() => link.isConnected("radio"));

    expect(link.send("radio", { type: "command", cmd: "horn" })).toBe(true);
    expect(await until(() => got.length > 0)).toBe(true);
    expect(JSON.parse(got[0])).toEqual({ type: "command", cmd: "horn" });
  });

  test("a throwing listener does not stop the others or reach the socket", async () => {
    const port = await freePort();
    const { link, log } = makeServer(port);
    const seen: number[] = [];
    link.on("update", () => {
      throw new Error("one action's repaint blew up");
    });
    link.on("update", (_s, snap) => seen.push(snap.a));
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 4 }));

    expect(await until(() => seen.includes(4))).toBe(true);
    expect(log.of("warn").some((l) => l.includes("threw"))).toBe(true);
  });
});

/* Liveness */

describe("deck link server: liveness", () => {
  test("a silent peer is dropped after staleMs", async () => {
    const port = await freePort();
    // pingMs far beyond the window, so no ping/pong can re-arm the watchdog
    // and the test is measuring silence rather than the ping layer.
    const { link, log } = makeServer(port, { staleMs: 150, pingMs: 60_000 });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    // Now say nothing at all.
    expect(await until(() => !link.isConnected("radio"), 2000)).toBe(true);
    expect(log.of("info").some((l) => l.includes("went silent"))).toBe(true);
  });

  test("an application keepalive keeps a quiet peer online", async () => {
    const port = await freePort();
    const { link } = makeServer(port, { staleMs: 200, pingMs: 60_000 });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    await until(() => link.isConnected("radio"));

    // Nothing but pings for well over the window.
    const beat = setInterval(() => ws.send(JSON.stringify({ type: "ping", source: "radio" })), 50);
    cleanups.push(() => clearInterval(beat));
    await sleep(600);

    expect(link.isConnected("radio")).toBe(true);
  });

  test("protocol-level pongs alone keep a peer online", async () => {
    const port = await freePort();
    // This is the layer that survives CEF freezing a page's timers: the `ws`
    // client answers ping frames in its own network stack, sending nothing at
    // the application level at all. It is the fix the throttling bug needed,
    // so it gets its own test.
    const { link } = makeServer(port, { staleMs: 200, pingMs: 50 });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    await until(() => link.isConnected("radio"));

    await sleep(600);
    expect(link.isConnected("radio")).toBe(true);
  });

  test("a dropped socket marks its source offline", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    await until(() => link.isConnected("radio"));

    ws.terminate();
    expect(await until(() => !link.isConnected("radio"))).toBe(true);
  });
});

/* The page half */

describe("deck link client: backoff arithmetic", () => {
  test("doubles from the base and stops at the cap", () => {
    expect(reconnectDelayFor(0, 1000, 30_000)).toBe(1000);
    expect(reconnectDelayFor(1, 1000, 30_000)).toBe(2000);
    expect(reconnectDelayFor(2, 1000, 30_000)).toBe(4000);
    expect(reconnectDelayFor(3, 1000, 30_000)).toBe(8000);
    expect(reconnectDelayFor(4, 1000, 30_000)).toBe(16_000);
    expect(reconnectDelayFor(5, 1000, 30_000)).toBe(30_000); // 32_000 capped
  });

  test("the exponent is clamped, so a long outage cannot overflow it", () => {
    for (const attempt of [6, 50, 5000, Number.MAX_SAFE_INTEGER]) {
      expect(reconnectDelayFor(attempt, 1000, 30_000)).toBe(30_000);
    }
    // Monotonic and never beyond the cap, across the whole range.
    let prev = 0;
    for (let i = 0; i < 40; i++) {
      const d = reconnectDelayFor(i, 1000, 30_000);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(30_000);
      prev = d;
    }
  });

  test("it is a backoff, not a constant", () => {
    // The property the flat 5000 ms versions did not have.
    expect(reconnectDelayFor(3, 1000, 30_000)).toBeGreaterThan(reconnectDelayFor(0, 1000, 30_000));
  });
});

describe("deck link client: transport", () => {
  test("nothing is dialed until it is enabled", async () => {
    const port = await freePort();
    const { link, updates } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
    });
    cleanups.push(() => client.dispose());

    await sleep(150);
    expect(client.isOpen()).toBe(false);
    expect(updates).toHaveLength(0);

    client.setEnabled(true);
    expect(await until(() => link.isConnected("radio"))).toBe(true);
    expect(link.stateOf("radio")).toMatchObject({ a: 1, b: "x" });
  });

  test("publish de-duplicates an unchanged snapshot", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    const frames: unknown[] = [];
    link.on("update", (_s, _snap, connected) => {
      if (connected) frames.push(_snap);
    });
    link.start();
    await until(() => link.boundPort() != null);

    let a = 1;
    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => frames.length === 1)).toBe(true);

    // Four more publishes with nothing changed: no further state frames.
    for (let i = 0; i < 4; i++) client.publish();
    await sleep(120);
    expect(frames).toHaveLength(1);

    // A real change goes through.
    a = 2;
    client.publish();
    expect(await until(() => frames.length === 2)).toBe(true);

    // And `force` goes through even unchanged.
    client.publish(true);
    expect(await until(() => frames.length === 3)).toBe(true);
  });

  test("it answers an application-level ping with a pong", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    // Drive a raw ping at the page and watch the socket stay alive on the
    // strength of its reply: staleMs is short and the server's own ping layer
    // is switched off, so only the pong can re-arm the watchdog.
    link.send("radio", { type: "ping" });
    await sleep(100);
    expect(link.isConnected("radio")).toBe(true);
  });

  test("a command that throws is logged, and the link keeps working", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    const errors: string[] = [];
    const handled: string[] = [];
    let failNext = true;
    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: (m) => {
        if (failNext) {
          failNext = false;
          throw new Error("getAudioManager() blew up");
        }
        handled.push(String(m.cmd));
      },
      initiallyEnabled: true,
      log: { warn: () => {}, error: (m) => errors.push(m) },
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    // This used to be swallowed as "malformed JSON": the key did nothing,
    // nothing was logged, and it was indistinguishable from the plugin never
    // having sent anything at all.
    link.send("radio", { type: "command", cmd: "ptt" });
    expect(await until(() => errors.length > 0)).toBe(true);
    expect(errors[0]).toContain("ptt");

    // Still alive, and the next command still lands.
    link.send("radio", { type: "command", cmd: "horn" });
    expect(await until(() => handled.includes("horn"))).toBe(true);
  });

  test("disabling sends bye, so the keys go offline without waiting out the watchdog", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    client.setEnabled(false);
    // Promptly — well inside STALE_MS, which is the whole point of `bye`.
    expect(await until(() => !link.isConnected("radio"), 1000)).toBe(true);
  });

  test("it reconnects after the plugin goes away and comes back", async () => {
    const port = await freePort();
    const first = makeServer(port);
    first.link.start();
    await until(() => first.link.boundPort() != null);

    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
      reconnectBaseMs: 20,
      reconnectCapMs: 60,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => first.link.isConnected("radio"))).toBe(true);

    // The plugin is reloaded: old process exits, new one takes the port.
    first.link.stop();
    expect(await until(() => !client.isOpen(), 2000)).toBe(true);

    const second = makeServer(port);
    second.link.start();
    expect(await until(() => second.link.isConnected("radio"), 4000)).toBe(true);
    expect(second.link.stateOf("radio")).toMatchObject({ a: 1, b: "x" });
  });
});

describe("deck link client: hold grace", () => {
  test("a hold survives a transport blip when the plugin comes straight back", async () => {
    const port = await freePort();
    const first = makeServer(port);
    first.link.start();
    await until(() => first.link.boundPort() != null);

    let released = 0;
    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      hasHold: () => true,
      releaseHolds: () => {
        released += 1;
      },
      holdGraceMs: 1500,
      initiallyEnabled: true,
      reconnectBaseMs: 10,
      reconnectCapMs: 30,
      log: { warn: () => {}, error: () => {} },
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => first.link.isConnected("radio"))).toBe(true);

    // The plugin restarts fast — a blip, not a disappearance. This is the
    // actual defect: cutting a PTT the operator is still physically holding.
    first.link.stop();
    const second = makeServer(port);
    second.link.start();
    expect(await until(() => second.link.isConnected("radio"), 3000)).toBe(true);

    // The reconnect landed inside the grace window, so the hold was kept.
    expect(released).toBe(0);
  });

  test("a hold IS released when the plugin really is gone", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    let released = 0;
    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      hasHold: () => true,
      releaseHolds: () => {
        released += 1;
      },
      holdGraceMs: 120,
      initiallyEnabled: true,
      reconnectBaseMs: 500,
      reconnectCapMs: 500,
      log: { warn: () => {}, error: () => {} },
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    // Nothing is listening any more, so the grace window expires. The mic is
    // never left keyed.
    link.stop();
    expect(await until(() => released > 0, 3000)).toBe(true);
  });

  test("with no hold tracking there is no grace machinery at all", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    link.start();
    await until(() => link.boundPort() != null);

    // tRadar's documented choice, now a configuration rather than an absence.
    // It must simply reconnect, with nothing to strand and nothing to release.
    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
      reconnectBaseMs: 10,
      reconnectCapMs: 30,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    link.stop();
    expect(await until(() => !client.isOpen(), 2000)).toBe(true);

    const again = makeServer(port);
    again.link.start();
    expect(await until(() => again.link.isConnected("radio"), 4000)).toBe(true);
  });
});

/* Negative controls *
 *
 * Each one plants the OPPOSITE of a property asserted above and requires the
 * same probe to come out the other way. Without these, a layer that quietly
 * stopped bounding its retries, stopped arming its watchdog or stopped
 * de-duplicating would leave every test above green — the probes would simply
 * stop discriminating, which is indistinguishable from passing.
 */

describe("negative control: the probes above can fail", () => {
  test("CONTROL unbounded budget — the retry probe does NOT see a fault", async () => {
    const port = await freePort();
    cleanups.push(await occupy(port));

    // tRadio's old behaviour, reproduced exactly: retry forever, and the only
    // trace is a `warn`. If `maxBindAttempts` stopped being honoured, the
    // bounded test above would look identical to this.
    const { link, log, faults } = makeServer(port, {
      maxBindAttempts: Number.POSITIVE_INFINITY,
      rebindMs: 20,
    });
    link.start();
    await sleep(250);

    expect(faults).toHaveLength(0);
    expect(link.fault()).toBeNull();
    // It is still going, silently — which is the failure mode being fixed.
    expect(log.of("warn").filter((l) => l.includes("busy")).length).toBeGreaterThan(2);
    expect(log.of("error")).toHaveLength(0);
  });

  test("CONTROL long watchdog — the stale probe does NOT see a drop", async () => {
    const port = await freePort();
    const { link, log } = makeServer(port, { staleMs: 60_000, pingMs: 60_000 });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    expect(await until(() => link.isConnected("radio"))).toBe(true);

    // Same silence as the stale test, but the watchdog cannot fire. If arming
    // were broken, the stale test would be measuring nothing and would look
    // exactly like this.
    await sleep(400);
    expect(link.isConnected("radio")).toBe(true);
    expect(log.of("info").some((l) => l.includes("went silent"))).toBe(false);
  });

  test("CONTROL keepalive withheld — a quiet peer IS dropped", async () => {
    const port = await freePort();
    const { link } = makeServer(port, { staleMs: 150, pingMs: 60_000 });
    link.start();
    await until(() => link.boundPort() != null);

    // A peer that answers ping frames but is never pinged, and sends no
    // application keepalive either. Proves the two liveness tests above pass
    // because of the keepalive and the pongs, not because the watchdog is inert.
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 1 }));
    expect(await until(() => link.isConnected("radio"))).toBe(true);
    expect(await until(() => !link.isConnected("radio"), 2000)).toBe(true);
  });

  test("CONTROL dedupe off — five publishes send five frames", async () => {
    const port = await freePort();
    const { link } = makeServer(port);
    const frames: unknown[] = [];
    link.on("update", (_s, snap, connected) => {
      if (connected) frames.push(snap);
    });
    link.start();
    await until(() => link.boundPort() != null);

    const client = createDeckLinkClient<Snap>({
      port,
      source: "radio",
      snapshot: () => ({ a: 1, b: "x" }),
      onMessage: () => {},
      initiallyEnabled: true,
      dedupe: false,
    });
    cleanups.push(() => client.dispose());
    expect(await until(() => frames.length === 1)).toBe(true);

    for (let i = 0; i < 4; i++) client.publish();
    expect(await until(() => frames.length === 5)).toBe(true);
    // The de-dupe test asserts exactly 1 here. If de-duplication silently
    // stopped working, that test would see 5 — and this one would see 5 too,
    // so the pair cannot both be satisfied by a broken implementation.
    expect(frames).toHaveLength(5);
  });

  test("CONTROL no merge — a partial snapshot would leave a field undefined", async () => {
    const port = await freePort();
    // `readSnapshot` returning the frame while `offlineFor` contributes nothing
    // reproduces tELS's wholesale assignment. The merge test asserts `b` is the
    // offline value; this shows what it looks like when there is nothing to
    // merge, which is the `undefined` that used to reach a draw function.
    const { link } = makeServer(port, { offlineFor: () => ({}) as Snap });
    link.start();
    await until(() => link.boundPort() != null);
    const ws = await peer(port);
    ws.send(JSON.stringify({ type: "state", source: "radio", a: 7 }));
    expect(await until(() => link.stateOf("radio").a === 7)).toBe(true);

    expect(link.stateOf("radio").b).toBeUndefined();
  });
});
