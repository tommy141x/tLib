/**
 * The preview document cache: how many 1.7 MB round trips a preview costs.
 *
 * `previewMarketplaceHtml` was a bare request, so every open of a preview —
 * including backing out and opening the SAME item again — pulled the whole
 * document down the NUI -> Lua -> game server -> HTTP path a second time. Measured
 * over the real import corpus, those documents run 1.0-1.8 MB, 97-99% of which is
 * base64 image payload inlined into the markup.
 *
 * So what is asserted here is a COUNT OF ROUND TRIPS, not a duration. A
 * timing assertion in a unit test measures this machine; the round trip count
 * is the thing that actually changed, and it is exact.
 *
 * `shared/ts/marketplace/ui/browse.ts` only — the NUI side of the transport.
 * `fetchNui`/`onNuiEvent` are mocked, so NOTHING here proves the Lua handler
 * answers, that the server-side fetch works, or that CEF renders the result.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as Timer),
};

/** Every `fetchNui` the module made, in order. */
let calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
/** The reply handler `browse.ts` registered, per result event. */
const listeners = new Map<string, (data: unknown) => void>();
/** What the fake bridge answers with, keyed by slug. */
let bodies = new Map<string, string | { error: string }>();

mock.module("../../shared/ts/nui", () => ({
  fetchNui: async (event: string, payload: Record<string, unknown>) => {
    calls.push({ event, payload });
    queueMicrotask(() => {
      const slug = String(payload.slug);
      const body = bodies.get(slug);
      const reply =
        body === undefined
          ? { requestId: payload.requestId, ok: false, error: "no such item" }
          : typeof body === "string"
            ? { requestId: payload.requestId, ok: true, html: body }
            : { requestId: payload.requestId, ok: false, error: body.error };
      listeners.get("marketplacePreviewResult")?.(reply);
    });
    return {};
  },
  onNuiEvent: (event: string, handler: (data: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  /**
   * A PARTIAL `mock.module` IS A TRAP, AND THIS IS THE REPAIR
   *
   * `mock.module` REPLACES the whole module for the rest of the `bun test`
   * PROCESS, not just for this file. So every export any other suite imports
   * from `shared/ts/nui` has to be here, or that suite dies with
   * `SyntaxError: Export named 'x' not found in module` — in a file that never
   * mentions mocking, at a line that looks correct, with no indication which
   * suite replaced the module.
   *
   * So: adding an import from `shared/ts/nui` anywhere in this repo means
   * adding it here too. The two below are what exists today; both are the
   * coherent fiction for a mock whose `fetchNui` always answers.
   */
  isNUI: () => true,
  getResourceName: (fallback = "tLib") => fallback,
}));

const { previewMarketplaceHtml, clearPreviewCache, previewCacheStats } = await import(
  "../../shared/ts/marketplace/ui/browse"
);

// A separate MODULE, not a corner of `browse.ts`: its listener has to outlive the
// component. Imported here because both halves need the same `shared/ts/nui`
// mock, and `mock.module` replaces a module for the rest of the test process.
const { clearInstallLedger, installLedger, patchInstalledNames } = await import(
  "../../shared/ts/marketplace/ui/install-ledger"
);

// The REAL server-side ceiling, imported rather than written out again: a
// literal here is the same drift that let the budget fall below it unnoticed.
const { MAX_PREVIEW_BYTES } = await import("../../server/lib/marketplace/browse");

/** A document of a given size, shaped like the real ones: mostly base64. */
function doc(slug: string, bytes: number): string {
  const head = `<div data-radio-width="209.5" data-radio-height="426.5" id="${slug}">`;
  return head + "A".repeat(Math.max(0, bytes - head.length - 6)) + "</div>";
}

beforeEach(() => {
  calls = [];
  bodies = new Map();
  clearPreviewCache();
  clearInstallLedger();
});

describe("round trips", () => {
  test("a second open of the same item makes no request at all", async () => {
    bodies.set("qrx-760", doc("qrx-760", 1_750_191));

    const first = await previewMarketplaceHtml("qrx-760");
    expect(calls).toHaveLength(1);

    const second = await previewMarketplaceHtml("qrx-760");
    // The number that changed. Before the cache this was 2, and each one was
    // the full 1.75 MB across the NUI boundary.
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  test("open/close/open/close/open of three items is 3 requests, not 5", async () => {
    // The real browse gesture: preview a head, back out, preview another, back
    // out, come back to the first to compare them.
    for (const slug of ["a", "b", "c"]) bodies.set(slug, doc(slug, 1_500_000));
    for (const slug of ["a", "b", "a", "c", "a"]) await previewMarketplaceHtml(slug);
    expect(calls.map((c) => String(c.payload.slug))).toEqual(["a", "b", "c"]);
  });

  test("two surfaces asking at once join one request", async () => {
    // The in-flight promise is cached, not just the settled text. Without
    // that, a host with two mounts — `MarketplacePanel` and the dialog tab —
    // starts two concurrent multi-megabyte transfers for one document.
    bodies.set("qrx-720", doc("qrx-720", 1_170_482));
    const [a, b] = await Promise.all([
      previewMarketplaceHtml("qrx-720"),
      previewMarketplaceHtml("qrx-720"),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  test("each distinct slug still costs exactly one request", async () => {
    // The negative half: a cache that answered the wrong document would also
    // show "fewer requests". This is what makes the count above evidence.
    for (const slug of ["a", "b"]) bodies.set(slug, doc(slug, 50_000));
    expect(await previewMarketplaceHtml("a")).toContain('id="a"');
    expect(await previewMarketplaceHtml("b")).toContain('id="b"');
    expect(await previewMarketplaceHtml("a")).toContain('id="a"');
    expect(calls).toHaveLength(2);
  });
});

describe("failure is not cached", () => {
  test("a refused preview is retried on the next open", async () => {
    // Caching a rejection would turn one timed-out round trip into a
    // permanently dead preview for that item, recoverable only by reloading the
    // whole UI. The retry must reach the bridge again.
    bodies.set("flaky", { error: "request_timed_out" });
    await expect(previewMarketplaceHtml("flaky")).rejects.toThrow(/request_timed_out/);
    expect(previewCacheStats().entries).toBe(0);

    bodies.set("flaky", doc("flaky", 10_000));
    expect(await previewMarketplaceHtml("flaky")).toContain('id="flaky"');
    expect(calls).toHaveLength(2);
  });
});

describe("the byte budget", () => {
  test("holds four documents the size this corpus actually contains", async () => {
    // The real documents run 1.0-1.8 MB, so four at 2 MB is the ordinary load
    // the 8 MB budget has to survive. It is NOT four of the largest the server
    // will pass — `MAX_PREVIEW_BYTES` is 10 MB, which the case below covers.
    for (let i = 0; i < 4; i++) bodies.set(`big${i}`, doc(`big${i}`, 2 * 1024 * 1024));
    for (let i = 0; i < 4; i++) await previewMarketplaceHtml(`big${i}`);
    expect(previewCacheStats().entries).toBe(4);
  });

  test("a document larger than the whole budget is still cached", async () => {
    // THE REGRESSION. `MAX_PREVIEW_BYTES` was raised 2 MB -> 10 MB on 2026-10-08
    // and this budget stayed at 8 MB, so a 10 MB document was charged to the
    // budget and then evicted by the very `evict()` call that charged it — it
    // was the only entry, so it was the least recently used one too. Nothing
    // errored; the largest documents simply re-fetched on every single open.
    bodies.set("huge", doc("huge", MAX_PREVIEW_BYTES));
    await previewMarketplaceHtml("huge");
    expect(previewCacheStats().entries).toBe(1);

    const before = calls.length;
    await previewMarketplaceHtml("huge");
    expect(calls).toHaveLength(before);
  });

  test("evicts the least recently used rather than growing without bound", async () => {
    // Five at 2 MB is 10 MB against an 8 MB budget, so one must go — and it
    // must be the one nobody has looked at, not the one just opened.
    for (let i = 0; i < 5; i++) bodies.set(`big${i}`, doc(`big${i}`, 2 * 1024 * 1024));
    for (let i = 0; i < 5; i++) await previewMarketplaceHtml(`big${i}`);
    expect(previewCacheStats().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);

    // `big0` was evicted, so it costs a request again; `big4` did not.
    const before = calls.length;
    await previewMarketplaceHtml("big4");
    expect(calls).toHaveLength(before);
    await previewMarketplaceHtml("big0");
    expect(calls).toHaveLength(before + 1);
  });

  test("a hit counts as a use, so re-reading an item keeps it alive", async () => {
    // Insertion-order eviction without this is FIFO, not LRU: the document the
    // player keeps coming back to would be the first one thrown away.
    for (let i = 0; i < 4; i++) bodies.set(`big${i}`, doc(`big${i}`, 2 * 1024 * 1024));
    for (let i = 0; i < 4; i++) await previewMarketplaceHtml(`big${i}`);
    await previewMarketplaceHtml("big0"); // touch the oldest
    bodies.set("big9", doc("big9", 2 * 1024 * 1024));
    await previewMarketplaceHtml("big9"); // forces one eviction

    const before = calls.length;
    await previewMarketplaceHtml("big0");
    expect(calls).toHaveLength(before); // survived, because it was touched
    await previewMarketplaceHtml("big1");
    expect(calls).toHaveLength(before + 1); // evicted in its place
  });
});

/**
 * THE SAME FILE ON PURPOSE, despite the name.
 *
 * `shared/ts/nui` has to be mocked for both, and `mock.module` replaces a module
 * for the rest of the `bun test` PROCESS — this file's own header says so — so a
 * second suite mocking it would race this one over which fake the ledger's
 * load-time subscription was bound to. One mock, one file.
 */
describe("the install ledger", () => {
  /** Deliver a coordinator reply the way `cl_marketplace.lua` does. */
  function outcome(event: string, data: Record<string, unknown>) {
    listeners.get(event)?.(data);
  }

  test("a confirmed install is recorded even with no surface mounted", () => {
    // The defect: both mounts UNMOUNT the browser, so an install that lands
    // after the panel is closed used to be delivered to nobody at all.
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-rdx-4000", type: "ui" });
    expect(installLedger().get("tdet-rdx-4000")).toEqual({ type: "ui", installed: true });
  });

  test("a FAILED install records nothing, because nothing changed on disk", () => {
    outcome("marketplaceInstallResult", {
      ok: false,
      slug: "tdet-rdx-4000",
      type: "ui",
      error: "x",
    });
    expect(installLedger().size).toBe(0);
  });

  test("a malformed reply records nothing", () => {
    outcome("marketplaceInstallResult", { ok: true, type: "ui" });
    outcome("marketplaceInstallResult", { ok: true, slug: "", type: "ui" });
    outcome("marketplaceUninstallResult", undefined as unknown as Record<string, unknown>);
    expect(installLedger().size).toBe(0);
  });

  test("the host's stale snapshot is patched with what was installed", () => {
    // `installedLayouts` is a `readdir` from before the install, and the signal
    // holding the open payload keeps that object — so a remount re-applied it and
    // offered Install for something now on disk.
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    expect(patchInstalledNames(["RDX-4000"], "ui")).toEqual(["RDX-4000", "tdet-arc-360"]);
  });

  test("and with what was uninstalled", () => {
    outcome("marketplaceUninstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    expect(patchInstalledNames(["RDX-4000", "tdet-arc-360"], "ui")).toEqual(["RDX-4000"]);
  });

  test("a SHIPPED built-in is never filtered out by a slug that is not its name", () => {
    // `installedLayouts` holds directory names (`QRX-720`) and the ledger holds
    // catalogue slugs (`tradio-qrx-720`). They must not be confused: filtering a
    // built-in out would hide a layout the operator can see in game, and
    // `../local-name.ts` is what reconciles the two namings.
    outcome("marketplaceUninstallResult", { ok: true, slug: "tradio-qrx-720", type: "ui" });
    expect(patchInstalledNames(["QRX-720"], "ui")).toEqual(["QRX-720"]);
  });

  test("a slug is keyed by its on-disk spelling, which is lowercase", () => {
    // The coordinator's `slugName` refuses anything but lowercase and
    // `installer/core.ts` writes `slug.toLowerCase()` as the directory name, so
    // the key, the lookup and the directory are one string. Folding on the way in
    // is what keeps them one if a non-conforming reply ever arrives.
    outcome("marketplaceInstallResult", { ok: true, slug: "TDET-ARC-360", type: "ui" });
    expect([...installLedger().keys()]).toEqual(["tdet-arc-360"]);
    expect(patchInstalledNames([], "ui")).toEqual(["tdet-arc-360"]);
  });

  test("an outcome for another type leaves this type's list alone", () => {
    // One directory can back more than one item type, and a sound's name does
    // not belong in the layout list.
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-airhorn", type: "sound" });
    expect(patchInstalledNames(["RDX-4000"], "ui")).toEqual(["RDX-4000"]);
    expect(patchInstalledNames([], "sound")).toEqual(["tdet-airhorn"]);
  });

  test("a reinstall of something already listed does not duplicate it", () => {
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    expect(patchInstalledNames(["tdet-arc-360"], "ui")).toEqual(["tdet-arc-360"]);
  });

  test("the last outcome for a slug wins", () => {
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    outcome("marketplaceUninstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    outcome("marketplaceInstallResult", { ok: true, slug: "tdet-arc-360", type: "ui" });
    expect(patchInstalledNames([], "ui")).toEqual(["tdet-arc-360"]);
  });

  test("an empty ledger returns the host's list unchanged, as a copy", () => {
    const names = ["RDX-4000"];
    const patched = patchInstalledNames(names, "ui");
    expect(patched).toEqual(names);
    expect(patched).not.toBe(names);
  });
});
