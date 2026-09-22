import { describe, expect, test } from "bun:test";
import {
  createToastLifetime,
  MAX_TOASTS,
  TOAST_DURATIONS,
  type ToastData,
  type ToastType,
} from "../../client/web/src/lib/toast-lifetime";

function harness() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const rendered = new Map<string, ToastData>();
  const stale: (() => void)[] = [];
  const lifetime = createToastLifetime(
    {
      upsert: (data) => {
        rendered.set(data.id, { ...data });
      },
      remove: (id) => {
        rendered.delete(id);
      },
      clear: () => rendered.clear(),
    },
    {
      set: (callback, delay) => {
        timers.set(++next, { at: now + delay, callback });
        return next;
      },
      clear: (handle) => {
        const timer = timers.get(handle as number);
        if (timer) stale.push(timer.callback);
        timers.delete(handle as number);
      },
    }
  );
  function tick(ms: number) {
    const end = now + ms;
    while (true) {
      const item = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      now = item[1].at;
      timers.delete(item[0]);
      item[1].callback();
    }
    now = end;
  }
  const show = (type: ToastType = "info", duration?: number, id = "5:radio:status") =>
    lifetime.show({ id, type, duration, title: "First" });
  return { lifetime, rendered, timers, stale, tick, show };
}

describe("NUI toast lifetime (Ark expiry disabled)", () => {
  for (const type of Object.keys(TOAST_DURATIONS) as ToastType[])
    test(`${type} default lifetime`, () => {
      const h = harness();
      h.show(type);
      if (type === "loading") {
        h.tick(100000);
        expect(h.rendered.size).toBe(1);
        expect(h.timers.size).toBe(0);
      } else {
        h.tick(TOAST_DURATIONS[type] - 1);
        expect(h.rendered.size).toBe(1);
        h.tick(1);
        expect(h.rendered.size).toBe(0);
      }
    });
  test("text, description and theme preserve the deadline and wire ID", () => {
    const h = harness();
    h.show("info", 1000);
    h.tick(800);
    h.lifetime.update("5:radio:status", {
      id: "bad",
      title: "New",
      description: "More",
      theme: "night",
    });
    expect(h.rendered.get("5:radio:status")?.title).toBe("New");
    expect(h.rendered.has("bad")).toBe(false);
    h.tick(199);
    expect(h.rendered.size).toBe(1);
    h.tick(1);
    expect(h.rendered.size).toBe(0);
  });
  test("same-value duration and type patches restart; type-only drops old custom duration", () => {
    const h = harness();
    h.show("info", 1000);
    h.tick(800);
    h.lifetime.update("5:radio:status", { duration: 1000 });
    h.tick(900);
    expect(h.rendered.size).toBe(1);
    h.lifetime.update("5:radio:status", { type: "info" });
    h.tick(3999);
    expect(h.rendered.size).toBe(1);
    h.tick(1);
    expect(h.rendered.size).toBe(0);
  });
  test("duration zero restores default; loading zero persists; loading can have finite explicit lifetime", () => {
    const h = harness();
    h.show("success", 500);
    h.tick(100);
    h.lifetime.update("5:radio:status", { duration: 0 });
    h.tick(3999);
    expect(h.rendered.size).toBe(1);
    h.tick(1);
    h.show("loading", 0);
    h.tick(100000);
    expect(h.rendered.size).toBe(1);
    h.lifetime.update("5:radio:status", { duration: 100 });
    h.tick(100);
    expect(h.rendered.size).toBe(0);
    h.show("loading", 100);
    h.tick(100);
    expect(h.rendered.size).toBe(0);
  });
  test("loading -> success starts default success deadline; success -> loading cancels timer", () => {
    const h = harness();
    h.show("loading");
    h.lifetime.update("5:radio:status", { type: "success" });
    h.tick(3999);
    expect(h.rendered.size).toBe(1);
    h.tick(1);
    expect(h.rendered.size).toBe(0);
    h.show("success");
    h.tick(1000);
    h.lifetime.update("5:radio:status", { type: "loading" });
    h.tick(100000);
    expect(h.rendered.size).toBe(1);
    expect(h.timers.size).toBe(0);
  });
  test("dedup/replacement restarts and stale cancelled timers cannot dismiss replacement", () => {
    const h = harness();
    h.show("info", 1000);
    h.tick(500);
    h.show("info", 1000);
    expect(h.lifetime.size).toBe(1);
    for (const callback of h.stale) callback();
    expect(h.rendered.size).toBe(1);
    h.tick(999);
    expect(h.rendered.size).toBe(1);
    h.tick(1);
    expect(h.rendered.size).toBe(0);
  });
  test("stale same-entry timer is fenced after duration update", () => {
    const h = harness();
    h.show("info", 100);
    h.lifetime.update("5:radio:status", { duration: 1000 });
    for (const callback of h.stale) callback();
    expect(h.rendered.size).toBe(1);
    h.tick(1000);
    expect(h.rendered.size).toBe(0);
  });
  test("dismiss, clear, stop clean timers; unknown update never creates; stop refuses new events", () => {
    const h = harness();
    h.lifetime.update("missing", { title: "No" });
    expect(h.rendered.size).toBe(0);
    h.show();
    h.lifetime.remove("5:radio:status");
    expect(h.timers.size).toBe(0);
    h.show();
    h.show("loading", undefined, "other");
    h.lifetime.clear();
    expect(h.rendered.size).toBe(0);
    expect(h.timers.size).toBe(0);
    h.show();
    h.lifetime.stop();
    h.show();
    h.tick(100000);
    expect(h.rendered.size).toBe(0);
    expect(h.timers.size).toBe(0);
  });
  test("bounded total, duplicate accepted at limit, dismissed slot reused without a deferred queue", () => {
    const h = harness();
    for (let i = 0; i <= MAX_TOASTS; i++) h.show("loading", undefined, String(i));
    expect(h.rendered.size).toBe(MAX_TOASTS);
    expect(h.rendered.has(String(MAX_TOASTS))).toBe(false);
    h.show("info", 100, "0");
    h.tick(100);
    expect(h.rendered.size).toBe(MAX_TOASTS - 1);
    h.show("loading", undefined, "new");
    expect(h.rendered.size).toBe(MAX_TOASTS);
  });
  test("invalid duration patches do not restart and invalid show duration uses type default", () => {
    const h = harness();
    h.show("info", Infinity);
    h.tick(3900);
    h.lifetime.update("5:radio:status", { duration: -1 });
    h.tick(100);
    expect(h.rendered.size).toBe(0);
  });
});
