/**
 * The contract for `createLatestRequest`, plus the negative controls that prove
 * each assertion is measuring the thing it names.
 *
 * This suite is the union of the two suites that previously lived in the
 * consumers (tELS `scripts/tests/hud-request.test.ts`, tDetector
 * `scripts/tests/latest-layout-request.test.ts`). They tested the same
 * primitive under different names and neither was a superset of the other:
 * tDetector had the A→B→A identity case and the "late old failure cannot clear
 * a newer success" case, tELS had the "abort is observable on the superseded
 * signal" case. All of them are here.
 *
 * Why the negative controls exist
 *
 * Every check below is written as a standalone function so it can be run
 * against a DELIBERATELY BROKEN implementation as well as the real one. A
 * passing assertion proves nothing on its own: an assertion that observes the
 * wrong layer passes against any implementation, including one with the fence
 * removed. So each break is paired with the checks it must make fail, and the
 * test asserts the failure. If a future refactor makes a check pass against a
 * broken variant, this file fails — which is the point.
 */

import { describe, expect, test } from "bun:test";
import { createLatestRequest, type LatestRequest } from "../../shared/ts/latest-request.ts";

type Factory = () => LatestRequest;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // An unhandled rejection would abort the whole bun process, and several
  // checks reject a promise nobody awaits on purpose.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Each check throws on violation; the name is what a control must break. */
const CHECKS: Record<string, (make: Factory) => Promise<void>> = {
  /** Superseding must be observable on the loser's signal, not only internally. */
  async "aborts the superseded signal"(make) {
    const request = make();
    const a = deferred<string>();
    const b = deferred<string>();
    let first!: AbortSignal;
    const old = request.run(
      (signal) => {
        first = signal;
        return a.promise;
      },
      () => {},
      () => {}
    );
    const newest = request.run(
      () => b.promise,
      () => {},
      () => {}
    );
    if (!first.aborted) throw new Error("superseded signal was not aborted");
    a.resolve("old");
    b.resolve("new");
    await Promise.all([old, newest]);
  },

  /** The fence, stated directly: a superseded request that RESOLVES must not apply. */
  async "a superseded request that resolves anyway does not apply"(make) {
    const request = make();
    const a = deferred<string>();
    const b = deferred<string>();
    const applied: string[] = [];
    const old = request.run(
      () => a.promise,
      (v) => applied.push(v),
      () => applied.push("failed")
    );
    const newest = request.run(
      () => b.promise,
      (v) => applied.push(v),
      () => applied.push("failed")
    );
    a.resolve("old");
    await old;
    if (applied.length !== 0) throw new Error(`stale value applied: ${applied.join(",")}`);
    b.resolve("new");
    await newest;
    if (applied.join(",") !== "new")
      throw new Error(`expected only "new", got ${applied.join(",")}`);
  },

  /** A superseded request REJECTING must not run the newer request's failure path. */
  async "a late old failure cannot clear a newer success"(make) {
    const request = make();
    const a = deferred<string>();
    const applied: string[] = [];
    const old = request.run(
      () => a.promise,
      (v) => applied.push(v),
      () => applied.push("cleared")
    );
    await request.run(
      async () => "new",
      (v) => applied.push(v),
      () => applied.push("cleared")
    );
    a.reject(new Error("old fetch failed"));
    await old;
    if (applied.join(",") !== "new")
      throw new Error(`expected only "new", got ${applied.join(",")}`);
  },

  /** A→B→A: the fence is on request identity, never on the payload or a name. */
  async "A to B to A resolves to the newest A"(make) {
    const request = make();
    const a1 = deferred<string>();
    const b = deferred<string>();
    const a2 = deferred<string>();
    const applied: string[] = [];
    const runs = [a1, b, a2].map((value) =>
      request.run(
        () => value.promise,
        (v) => applied.push(v),
        () => applied.push("failed")
      )
    );
    a2.resolve("A-new");
    a1.resolve("A-old");
    b.resolve("B");
    await Promise.all(runs);
    if (applied.join(",") !== "A-new")
      throw new Error(`expected only "A-new", got ${applied.join(",")}`);
  },

  /** `pending` must stay true across a supersede and be cleared by the winner only. */
  async "pending tracks the winner, not whichever request settles first"(make) {
    const request = make();
    const a = deferred<string>();
    const b = deferred<string>();
    const old = request.run(
      () => a.promise,
      () => {},
      () => {}
    );
    const newest = request.run(
      () => b.promise,
      () => {},
      () => {}
    );
    a.resolve("old");
    await old;
    if (!request.pending) throw new Error("pending went false while the winner was still loading");
    b.resolve("new");
    await newest;
    if (request.pending) throw new Error("pending stayed true after the winner settled");
  },

  /** A failure must not leave the instance permanently blocked. */
  async "a winning failure reports once and allows a retry"(make) {
    const request = make();
    let failures = 0;
    let applied = 0;
    await request.run(
      async () => {
        throw new Error("404");
      },
      () => applied++,
      () => failures++
    );
    if (request.pending) throw new Error("pending stuck true after a failure");
    await request.run(
      async () => "retry",
      () => applied++,
      () => failures++
    );
    if (failures !== 1 || applied !== 1)
      throw new Error(`expected 1 failure and 1 apply, got ${failures}/${applied}`);
  },

  /** Dispose: nothing in flight commits, and no later run commits either. */
  async "dispose retires both in-flight and future work"(make) {
    const request = make();
    const a = deferred<string>();
    let touches = 0;
    const inflight = request.run(
      () => a.promise,
      () => touches++,
      () => touches++
    );
    request.dispose();
    a.resolve("late");
    await inflight;
    await request.run(
      async () => {
        touches++;
        return "later";
      },
      () => touches++,
      () => touches++
    );
    if (touches !== 0) throw new Error(`disposed instance did ${touches} units of work`);
    if (request.pending) throw new Error("pending true after dispose");
  },

  /** Disposal is per instance, not a module-level latch. */
  async "a fresh instance has its own lifetime"(make) {
    const first = make();
    first.dispose();
    const applied: string[] = [];
    await make().run(
      async () => "fresh",
      (v) => applied.push(v),
      () => applied.push("failed")
    );
    if (applied.join(",") !== "fresh")
      throw new Error(`fresh instance applied ${applied.join(",")}`);
  },
};

const CHECK_NAMES = Object.keys(CHECKS);

describe("createLatestRequest", () => {
  for (const name of CHECK_NAMES) {
    test(name, async () => {
      await CHECKS[name](createLatestRequest);
    });
  }
});

// Negative controls
//
// Each variant removes exactly one property of the real implementation. The
// `breaks` list is the set of checks that MUST fail against it; every other
// check must still pass, which is what keeps a control from passing for the
// wrong reason (a variant that fails everything proves nothing about which
// assertion is load-bearing).

/** Abort only. The shape every "just use AbortController" rewrite would have. */
function unfenced(): LatestRequest {
  let controller: AbortController | undefined;
  let pending = false;
  let disposed = false;
  return {
    get pending() {
      return pending;
    },
    async run<T>(load: (s: AbortSignal) => Promise<T>, apply: (v: T) => void, fail: () => void) {
      if (disposed) return;
      controller?.abort();
      controller = new AbortController();
      pending = true;
      try {
        const value = await load(controller.signal);
        if (!disposed) apply(value);
      } catch {
        if (!disposed) fail();
      } finally {
        pending = false;
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
      pending = false;
    },
  };
}

/** The fence is kept for apply/fail but `pending` is cleared by any settle. */
function unguardedPending(): LatestRequest {
  let generation = 0;
  let controller: AbortController | undefined;
  let pending = false;
  let disposed = false;
  return {
    get pending() {
      return pending;
    },
    async run<T>(load: (s: AbortSignal) => Promise<T>, apply: (v: T) => void, fail: () => void) {
      if (disposed) return;
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      pending = true;
      try {
        const value = await load(controller.signal);
        if (!disposed && request === generation) apply(value);
      } catch {
        if (!disposed && request === generation) fail();
      } finally {
        pending = false;
      }
    },
    dispose() {
      disposed = true;
      generation++;
      controller?.abort();
      pending = false;
    },
  };
}

/** `dispose` sets the flag but never aborts or bumps, so in-flight work lands. */
function leakyDispose(): LatestRequest {
  let generation = 0;
  let controller: AbortController | undefined;
  let pending = false;
  return {
    get pending() {
      return pending;
    },
    async run<T>(load: (s: AbortSignal) => Promise<T>, apply: (v: T) => void, fail: () => void) {
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      pending = true;
      try {
        const value = await load(controller.signal);
        if (request === generation) apply(value);
      } catch {
        if (request === generation) fail();
      } finally {
        if (request === generation) pending = false;
      }
    },
    dispose() {
      pending = false;
    },
  };
}

const CONTROLS: { name: string; make: Factory; breaks: string[] }[] = [
  {
    name: "abort only, no generation fence",
    make: unfenced,
    breaks: [
      "a superseded request that resolves anyway does not apply",
      "a late old failure cannot clear a newer success",
      "A to B to A resolves to the newest A",
      "pending tracks the winner, not whichever request settles first",
    ],
  },
  {
    name: "pending cleared by any settle",
    make: unguardedPending,
    breaks: ["pending tracks the winner, not whichever request settles first"],
  },
  {
    name: "dispose does not retire in-flight work",
    make: leakyDispose,
    breaks: ["dispose retires both in-flight and future work"],
  },
];

describe("negative controls", () => {
  for (const control of CONTROLS) {
    // Every name in `breaks` must be a real check — a typo would otherwise make
    // this whole control vacuous by asserting nothing.
    test(`${control.name}: names only real checks`, () => {
      for (const name of control.breaks) expect(CHECK_NAMES).toContain(name);
      expect(control.breaks.length).toBeGreaterThan(0);
    });

    for (const name of CHECK_NAMES) {
      const mustFail = control.breaks.includes(name);
      test(`${control.name}: ${mustFail ? "FAILS" : "still passes"} "${name}"`, async () => {
        let error: unknown;
        try {
          await CHECKS[name](control.make);
        } catch (caught) {
          error = caught;
        }
        if (mustFail) {
          expect(error).toBeInstanceOf(Error);
        } else {
          expect(error).toBeUndefined();
        }
      });
    }
  }
});
