/**
 * The crash detector.
 *
 * WHY THIS SUITE EXISTS AT ALL. The mechanism is an ABSENCE: a clean shutdown
 * sets a flag and a renderer kill cannot, so the missing flag on the next boot
 * IS the crash. A detector built on an absence has a failure mode that nothing
 * else in a codebase has — it can quietly start reporting EVERY boot as a crash,
 * or quietly stop reporting any, and the page works perfectly either way. It
 * already shipped the first of those: before Lua reported orderly stops, every
 * ordinary `restart tRadio` was reported as "ENDED UNEXPECTEDLY", which is
 * indistinguishable from the bug the mechanism exists to detect.
 *
 * `localStorage` AND `window` ARE STUBBED RATHER THAN taken from happy-dom.
 * This suite runs under `bun test` from the resource root, where there is no DOM
 * — and the stubs are better than a DOM here anyway: the whole contract is what
 * happens when the page DIES, which no DOM harness can produce. Driving the
 * stubbed store directly is how a second "boot" is simulated at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CrashReport,
  formatSample,
  type ResourceSample,
  readTrend,
  sampleResources,
  startSessionLog,
} from "../../shared/ts/telemetry/session";

/* -------------------------------------------------------------------------- */
/* Host stubs                                                                 */
/* -------------------------------------------------------------------------- */

let store: Map<string, string>;
let unloadHandlers: Array<() => void>;

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  store = new Map();
  unloadHandlers = [];
  for (const key of ["localStorage", "window", "document"]) saved[key] = g[key];

  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  g.window = {
    addEventListener: (name: string, fn: () => void) => {
      if (name === "beforeunload") unloadHandlers.push(fn);
    },
    removeEventListener: () => {},
  };
  g.document = { getElementsByTagName: () => ({ length: 123 }) };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

/** A log that is both the banner and a crash sink. */
function boot(opts: { graceMs?: number } = {}) {
  const banner: string[] = [];
  const crashes: CrashReport[] = [];
  const handle = startSessionLog({
    namespace: "tradio",
    graceMs: opts.graceMs ?? 15_000,
    onBanner: (line) => banner.push(line),
    onCrash: (c) => crashes.push(c),
  });
  return { handle, banner, crashes };
}

/** Write a dead previous session straight into the store. */
function plantPrevious(record: Record<string, unknown>): void {
  store.set("tradio.session", JSON.stringify(record));
}

/* -------------------------------------------------------------------------- */

describe("the session counter", () => {
  test("a first boot is session #1 and reports no previous session", () => {
    const b = boot();
    expect(b.banner[0]).toBe("session #1");
    expect(b.banner).toHaveLength(1);
    expect(b.crashes).toHaveLength(0);
    b.handle.stop();
  });

  test("the count rises across boots, which IS the reset observed directly", () => {
    // A rising session number with no relog is the bug, observed rather than
    // inferred from other resources' init spam.
    boot().handle.stop();
    plantPrevious({ n: 1, startedAt: 0, clean: true });
    const b = boot();
    expect(b.banner[0]).toBe("session #2");
    b.handle.stop();
  });
});

describe("the clean-exit marker", () => {
  test("a previous session with the marker is reported as clean and NOT crash-reported", () => {
    plantPrevious({ n: 7, startedAt: 0, clean: true, lastUptimeMs: 90_000 });
    const b = boot();
    expect(b.banner.join("\n")).toContain("ended cleanly");
    // The important half. A `restart tRadio` is not a crash, and reporting
    // one would make every developer reload in this estate a data point.
    expect(b.crashes).toHaveLength(0);
    b.handle.stop();
  });

  test("beforeunload sets the marker", () => {
    const b = boot();
    for (const fn of unloadHandlers) fn();
    const saved = JSON.parse(store.get("tradio.session") ?? "{}");
    expect(saved.clean).toBe(true);
    b.handle.stop();
  });

  test("a previous session with NO marker defers the verdict rather than guessing", () => {
    /**
     * `beforeunload` does NOT fire when FiveM destroys the frame, so an
     * absent marker alone cannot tell a renderer kill from a resource restart.
     * Nothing may be reported until Lua has answered or the grace window has
     * expired.
     */
    plantPrevious({ n: 7, startedAt: 0, lastUptimeMs: 4000 });
    const b = boot();
    expect(b.crashes).toHaveLength(0);
    expect(b.banner.join("\n")).not.toContain("ENDED UNEXPECTEDLY");
    b.handle.stop();
  });

  test("Lua saying it was orderly resolves it to clean, with no crash report", () => {
    plantPrevious({ n: 7, startedAt: 0, lastUptimeMs: 4000 });
    const b = boot();
    b.handle.noteOrderlyStop(true);
    expect(b.crashes).toHaveLength(0);
    expect(b.banner.join("\n")).toContain("resource stop/restart");
    expect(b.handle.info().previousEndedCleanly).toBe(true);
    b.handle.stop();
  });

  test("Lua saying it was NOT orderly is the crash", () => {
    plantPrevious({ n: 7, startedAt: 0, lastUptimeMs: 4000 });
    const b = boot();
    b.handle.noteOrderlyStop(false);
    expect(b.crashes).toHaveLength(1);
    expect(b.crashes[0]?.session).toBe(7);
    expect(b.crashes[0]?.uptimeMs).toBe(4000);
    expect(b.banner.join("\n")).toContain("ENDED UNEXPECTEDLY");
    b.handle.stop();
  });

  test("a second answer cannot produce a duplicate or a contradictory report", () => {
    plantPrevious({ n: 7, startedAt: 0 });
    const b = boot();
    b.handle.noteOrderlyStop(false);
    b.handle.noteOrderlyStop(true);
    b.handle.noteOrderlyStop(false);
    expect(b.crashes).toHaveLength(1);
    b.handle.stop();
  });

  test("the grace window expiring reports a crash — no init message arrived either", () => {
    plantPrevious({ n: 7, startedAt: 0 });
    const b = boot({ graceMs: 5 });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(b.crashes).toHaveLength(1);
        b.handle.stop();
        resolve();
      }, 30);
    });
  });

  test("stop() cancels a pending verdict, so a teardown cannot mint a crash", () => {
    plantPrevious({ n: 7, startedAt: 0 });
    const b = boot({ graceMs: 5 });
    b.handle.stop();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(b.crashes).toHaveLength(0);
        resolve();
      }, 30);
    });
  });
});

describe("info()", () => {
  test("previousEndedCleanly is the VERDICT, not the stored flag", () => {
    /**
     * Reading `read().clean` answers the wrong question: the record on disk
     * is the CURRENT session's, and its `clean` is only ever set by
     * beforeunload — so it is false for every LIVE session and a report built on
     * it always claimed the previous page had crashed. That shipped.
     */
    plantPrevious({ n: 7, startedAt: 0, clean: true });
    const b = boot();
    expect(JSON.parse(store.get("tradio.session") ?? "{}").clean).toBeUndefined();
    expect(b.handle.info().previousEndedCleanly).toBe(true);
    b.handle.stop();
  });

  test("it survives an unreadable store rather than throwing", () => {
    const b = boot();
    store.set("tradio.session", "{not json");
    expect(() => b.handle.info()).not.toThrow();
    expect(b.handle.info().n).toBe(0);
    b.handle.stop();
  });
});

describe("storage is never allowed to break boot", () => {
  test("a localStorage that refuses still boots and still prints the banner", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("Storage is disabled");
      },
      setItem: () => {
        throw new Error("Storage is disabled");
      },
    };
    const b = boot();
    expect(b.banner[0]).toBe("session #1");
    b.handle.stop();
  });

  test("the namespace is per resource, so two resources cannot share a ledger", () => {
    const a = startSessionLog({ namespace: "tradio" });
    const c = startSessionLog({ namespace: "tels" });
    expect([...store.keys()].sort()).toEqual(["tels.session", "tradio.session"]);
    a.stop();
    c.stop();
  });
});

describe("sampleResources", () => {
  test("reports elapsed time in whole seconds, not milliseconds", () => {
    expect(sampleResources(30_400, 0).t).toBe(30);
    expect(sampleResources(90_600, 0).t).toBe(91);
  });

  test("marks the heap UNKNOWN rather than zero when performance.memory is absent", () => {
    // A missing reading must not read as "0 MB used" — that is a perfectly
    // healthy renderer as far as the verdict is concerned.
    const s = sampleResources(1000, 0);
    expect(s.heapMB).toBe(-1);
    expect(s.heapLimitMB).toBe(-1);
  });

  test("never reports negative drift — a timer that fired early is not a freeze", () => {
    expect(sampleResources(1000, -250).driftMs).toBe(0);
    expect(sampleResources(1000, 4500.6).driftMs).toBe(4501);
  });

  test("the host's extra numbers travel under `extra`", () => {
    expect(sampleResources(0, 0, { tbuf: 312 }).extra.tbuf).toBe(312);
  });

  test("formatSample is one line, and includes the host's extras", () => {
    const line = formatSample(sampleResources(30_000, 40, { tbuf: 312 }));
    expect(line).not.toInclude("\n");
    expect(line).toStartWith("t=30s");
    expect(line).toInclude("drift=40ms");
    expect(line).toInclude("tbuf=312");
  });
});

describe("readTrend — an enum a dashboard can group on, plus prose", () => {
  const sample = (over: Partial<ResourceSample> = {}): ResourceSample => ({
    t: 0,
    heapMB: 100,
    heapLimitMB: 4096,
    domNodes: 500,
    driftMs: 0,
    extra: {},
    ...over,
  });

  test("no samples is 'no-samples', not 'inconclusive'", () => {
    // The two are different facts: one means nothing was measured, the other
    // means it was measured and said nothing.
    expect(readTrend([]).verdict).toBe("no-samples");
  });

  test("fewer than three refuses to judge", () => {
    expect(readTrend([sample(), sample()]).verdict).toBe("inconclusive");
  });

  test("a flat trajectory is inconclusive rather than a confident 'healthy'", () => {
    const r = readTrend([sample({ t: 0 }), sample({ t: 30 }), sample({ t: 60 })]);
    expect(r.verdict).toBe("inconclusive");
    expect(r.notes).toHaveLength(0);
  });

  test("a heap pinned against its limit is a renderer OOM and wins the enum", () => {
    const r = readTrend([
      sample({ t: 0, heapMB: 3600 }),
      sample({ t: 30, heapMB: 3700 }),
      sample({ t: 60, heapMB: 3900, driftMs: 9000 }),
    ]);
    expect(r.verdict).toBe("heap-near-limit");
    // Every match still contributes a NOTE, so nothing is lost to the ranking.
    expect(r.notes.join(" ")).toContain("main thread blocked");
  });

  test("the worst drift ANYWHERE in the trajectory counts, not just the last", () => {
    const r = readTrend([sample({ t: 0 }), sample({ t: 30, driftMs: 15_000 }), sample({ t: 60 })]);
    expect(r.verdict).toBe("main-thread-block");
    expect(r.notes.join(" ")).toContain("15.0s");
  });

  test("growth without a limit breach is heap-growth", () => {
    const r = readTrend([
      sample({ t: 0, heapMB: 100 }),
      sample({ t: 30, heapMB: 200 }),
      sample({ t: 60, heapMB: 400 }),
    ]);
    expect(r.verdict).toBe("heap-growth");
  });

  test("it does not invent growth from unknown (-1) readings", () => {
    const r = readTrend([
      sample({ t: 0, heapMB: -1, heapLimitMB: -1, domNodes: -1 }),
      sample({ t: 30, heapMB: -1, heapLimitMB: -1, domNodes: 4000 }),
      sample({ t: 60, heapMB: -1, heapLimitMB: -1, domNodes: 9000 }),
    ]);
    expect(r.verdict).toBe("inconclusive");
  });

  test("DOM growth is attributed to the UI", () => {
    const r = readTrend([
      sample({ t: 0, domNodes: 500 }),
      sample({ t: 30, domNodes: 1500 }),
      sample({ t: 60, domNodes: 4000 }),
    ]);
    expect(r.verdict).toBe("dom-growth");
  });
});
