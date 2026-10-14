/**
 * The in-game browse path.
 *
 * Two things are under test and they are not the same thing.
 *
 * 1. **The request.** Browse is the only marketplace call that can scope
 *    results to one product, and `resource` is the parameter that does it — it
 *    did not exist on the old v1 list call at all, which is why a tDetector
 *    panel and a tRadar panel would have shown each other's items had browse
 *    ever returned any. Asserting the URL is how "tDetector browses tDetector"
 *    stays true.
 *
 * 2. **The normalisation.** v2 answers in camelCase; every card component in
 *    the NUI reads v1's snake_case. `toItem` is the only place those two
 *    vocabularies meet, and a missed field does not throw — it renders as an
 *    empty string or a zero, which looks like an item with no author and no
 *    size rather than like a bug.
 *
 * What is NOT under test, and cannot be: that the request succeeds against the
 * real host. The defect this path fixes was a CORS refusal, which only a
 * browser enforces and which no unit test can observe. That needs one live
 * check in game.
 */
import { afterEach, describe, expect, test } from "bun:test";

/**
 * These must run BEFORE the module under test is imported.
 *
 * `server/lib/marketplace/fivem.ts` snapshots the FiveM natives off
 * `globalThis` into `const` bindings at module-evaluation time, so a stub
 * installed afterwards is never seen. Hence the dynamic import below; a static
 * one would be hoisted above these assignments.
 */
const g = globalThis as unknown as Record<string, unknown>;
// Every convar returns its default: the key is baked in, not configured,
// so an unconfigured server is still authenticated. See the comment on
// `TLIB_PUBLIC_KEY` for why that is deliberate.
g.GetConvar = (_name: string, defaultValue: string) => defaultValue;
g.GetCurrentResourceName = () => "tLib";

const { browseItems, previewHtml } = await import("../../server/lib/marketplace/browse");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function captureFetch(body: unknown, status = 200): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

const emptyPage = { items: [], pagination: { total: 0, nextCursor: 0, hasMore: false } };

function v2Item(overrides: Record<string, unknown> = {}) {
  return {
    id: "itm_1",
    slug: "midnight-hud",
    type: "ui",
    resource: "tDetector",
    name: "Midnight HUD",
    description: "A dark layout",
    creatorName: "Ada",
    currentVersion: "1",
    sizeBytes: 4096,
    downloads: 12,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the request", () => {
  test("asks v2, not the CORS-blocked v1 list", async () => {
    const calls = captureFetch(emptyPage);
    await browseItems({});
    expect(calls[0]?.url).toContain("/api/v2/marketplace/items");
    expect(calls[0]?.url).not.toContain("/api/v1/");
  });

  test("scopes to one resource when asked", async () => {
    // The parameter the v1 list never had. Without it every resource's panel
    // lists every other resource's items, each with an Install button pointing
    // at the wrong product.
    const calls = captureFetch(emptyPage);
    await browseItems({ resource: "tRadar", type: "ui" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("resource")).toBe("tRadar");
    expect(url.searchParams.get("type")).toBe("ui");
  });

  test("sends the resource secret", async () => {
    // The whole reason browse moved server-side. v1 omits this check precisely
    // because its callers ship inside a game client; running here is what makes
    // the authenticated surface reachable at all.
    const calls = captureFetch(emptyPage);
    await browseItems({});
    expect(calls[0]?.headers["x-resource-secret"]).toBeTruthy();
  });

  test("omits a zero cursor rather than sending it", async () => {
    // Harmless either way, but an absent cursor is what a first page means and
    // the server's default is the contract.
    const calls = captureFetch(emptyPage);
    await browseItems({ cursor: 0 });
    expect(new URL(calls[0]?.url ?? "").searchParams.has("cursor")).toBe(false);
  });
});

describe("the normalisation", () => {
  test("renames every camelCase field the NUI reads as snake_case", async () => {
    captureFetch({ items: [v2Item()], pagination: { total: 1, nextCursor: 1, hasMore: false } });
    const [item] = (await browseItems({})).items;
    expect(item).toMatchObject({
      slug: "midnight-hud",
      resource: "tDetector",
      creator_name: "Ada",
      current_version: "1",
      size_bytes: 4096,
      downloads: 12,
      created_at: "2026-09-01T00:00:00.000Z",
    });
  });

  test("names an item with no creator rather than leaving it blank", async () => {
    captureFetch({ items: [v2Item({ creatorName: undefined })], pagination: {} });
    expect((await browseItems({})).items[0]?.creator_name).toBe("Anonymous");
  });

  test("drops an item with no slug", async () => {
    // Slug is the install identity. An entry without one renders a card whose
    // Install button can only ever fail, which is worse than not listing it.
    captureFetch({ items: [v2Item(), v2Item({ slug: undefined })], pagination: {} });
    expect((await browseItems({})).items).toHaveLength(1);
  });

  test("survives a non-numeric size instead of rendering NaN", async () => {
    captureFetch({ items: [v2Item({ sizeBytes: null, downloads: "12" })], pagination: {} });
    const [item] = (await browseItems({})).items;
    expect(item?.size_bytes).toBe(0);
    expect(item?.downloads).toBe(0);
  });

  test("carries a sound's waveform through", async () => {
    captureFetch({
      items: [v2Item({ type: "sound", previewWaveform: [0.1, 0.9] })],
      pagination: {},
    });
    expect((await browseItems({})).items[0]?.preview_waveform).toEqual([0.1, 0.9]);
  });

  test("omits the waveform key entirely for an item that has none", async () => {
    // The card checks presence, not truthiness. Shipping `preview_waveform:
    // null` would make a UI item claim to be a renderable sound.
    captureFetch({ items: [v2Item()], pagination: {} });
    expect("preview_waveform" in ((await browseItems({})).items[0] ?? {})).toBe(false);
  });
});

describe("paging", () => {
  test("reports the server's own hasMore", async () => {
    // Previously inferred from a full page, which claimed a next page whenever
    // the catalogue was an exact multiple of the page size.
    captureFetch({ items: [v2Item()], pagination: { total: 40, nextCursor: 1, hasMore: true } });
    const page = await browseItems({});
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(1);
    expect(page.total).toBe(40);
  });

  test("advances the cursor itself when the server sends none", async () => {
    // A missing cursor would otherwise pin the panel to page one forever.
    captureFetch({ items: [v2Item(), v2Item({ slug: "b" })] });
    expect((await browseItems({ cursor: 10 })).nextCursor).toBe(12);
  });
});

describe("failure", () => {
  test("surfaces the server's error code, not the status", async () => {
    // The Worker's refusal messages are written to be read by whoever is
    // looking at the panel; `http_429` is not.
    captureFetch({ error: "rate_limited" }, 429);
    expect(browseItems({})).rejects.toThrow(/rate_limited/);
  });

  test("reports a non-JSON body as an unexpected response", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>502</html>", { status: 200 })) as typeof fetch;
    expect(browseItems({})).rejects.toThrow(/unexpected_response/);
  });
});

describe("the media fields", () => {
  // These two are URLs an ELEMENT loads — an `<audio src>` and an `<img src>` —
  // not things the panel fetches. That distinction is the whole reason the
  // sound preview needed no server broker while the UI preview did: an element
  // load is exempt from CORS, a `fetch` is not. Carrying them is what lets the
  // panel stay on elements.
  test("carries the absolute preview and thumbnail URLs through", async () => {
    captureFetch({
      items: [
        v2Item({
          type: "sound",
          previewUrl: "https://timmygstudios.com/api/storage/p/abc.ogg",
          thumbnail: "https://timmygstudios.com/api/storage/t/abc.png",
        }),
      ],
      pagination: {},
    });
    const [item] = (await browseItems({})).items;
    expect(item?.preview_url).toBe("https://timmygstudios.com/api/storage/p/abc.ogg");
    expect(item?.thumbnail).toBe("https://timmygstudios.com/api/storage/t/abc.png");
  });

  test("omits both keys when the listing has neither", async () => {
    // Presence is what the player falls back on: no `preview_url` means use the
    // v1 download URL, and a null would be handed to `<audio src>` as "null".
    captureFetch({ items: [v2Item()], pagination: {} });
    const [item] = (await browseItems({})).items;
    expect("preview_url" in (item ?? {})).toBe(false);
    expect("thumbnail" in (item ?? {})).toBe(false);
  });
});

describe("the UI preview document", () => {
  function captureHtml(body: string, status = 200): Captured[] {
    const calls: Captured[] = [];
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      calls.push({ url: String(input), headers });
      return new Response(body, { status, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    return calls;
  }

  test("asks v2 by slug, with the secret", async () => {
    // By SLUG. The v1 route this replaces was addressed by item id, so a
    // caller that kept passing `item.id` would 404 on every preview.
    const calls = captureHtml("<html><body>hi</body></html>");
    await previewHtml("midnight-hud");
    expect(calls[0]?.url).toBe(
      "https://timmygstudios.com/api/v2/marketplace/items/midnight-hud/ui-html"
    );
    expect(calls[0]?.headers["x-resource-secret"]).toBeTruthy();
    expect(calls[0]?.headers.accept).toBe("text/html");
  });

  test("returns the document verbatim", async () => {
    // Text, not JSON: the panel parses this markup itself — it injects the
    // preview script and reads the canvas size out of a comment — which is
    // exactly what a cross-origin `<iframe src>` could not have given it.
    const doc = "<html><!-- studio-design:eyJ3IjoxfQ== --><body>hi</body></html>";
    captureHtml(doc);
    expect(await previewHtml("midnight-hud")).toBe(doc);
  });

  test("refuses an empty slug without making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await expect(previewHtml("")).rejects.toThrow(/slug_required/);
    expect(called).toBe(false);
  });

  test("refuses a document too large to cross into Lua", async () => {
    // Not a hostile-host guard: this string is marshalled into the Lua VM and
    // then into a NUI message, and an unbounded one stalls both.
    //
    // Tracks `MAX_PREVIEW_BYTES`, raised 2 MB → 10 MB on 2026-10-08. The old
    // number was refusing real catalogue items — two shipped tELS documents
    // (12.9 MB and 8.6 MB) could never preview — so it had stopped being a
    // stall backstop and become a size gate.
    captureHtml("x".repeat(10 * 1024 * 1024 + 1));
    await expect(previewHtml("midnight-hud")).rejects.toThrow(/preview_too_large/);
  });

  test("accepts a document that the OLD 2 MB cap would have refused", async () => {
    // The point of the change, asserted directly rather than left implicit in
    // the boundary test above: a 4 MB document is real content, not an attack,
    // and it now reaches the player.
    captureHtml(
      `<div data-radio-width="200" data-radio-height="400">${"x".repeat(4 * 1024 * 1024)}</div>`
    );
    await expect(previewHtml("midnight-hud")).resolves.toContain("data-radio-width");
  });

  test("surfaces a missing preview as an error rather than empty markup", async () => {
    captureHtml("not found", 404);
    await expect(previewHtml("nope")).rejects.toThrow();
  });
});

describe("the tLib-panel adapter", () => {
  // `browseItems` is now only the snake_case adapter over the shared
  // `browseCatalogue`. What is worth pinning here is that the adapter is TOTAL:
  // a field the shared transport carries and this mapping forgets does not
  // throw, it silently stops reaching the panel. That is precisely how
  // `previewColors` came to be delivered to tRadio's admin panel and dropped on
  // the way into this one.
  test("renames every wire field the panel reads", async () => {
    captureFetch({
      items: [
        v2Item({
          type: "theme",
          previewColors: ["#0a0a0a", "#fafafa"],
          thumbnail: "https://timmygstudios.com/t.png",
          previewUrl: "https://timmygstudios.com/p.ogg",
          previewWaveform: [0.2, 0.8],
        }),
      ],
      pagination: { total: 1, nextCursor: 1, hasMore: false },
    });
    const [item] = (await browseItems({})).items;
    expect(item).toEqual({
      id: "itm_1",
      slug: "midnight-hud",
      type: "theme",
      resource: "tDetector",
      name: "Midnight HUD",
      description: "A dark layout",
      creator_name: "Ada",
      current_version: "1",
      size_bytes: 4096,
      downloads: 12,
      created_at: "2026-09-01T00:00:00.000Z",
      preview_waveform: [0.2, 0.8],
      preview_colors: ["#0a0a0a", "#fafafa"],
      preview_url: "https://timmygstudios.com/p.ogg",
      thumbnail: "https://timmygstudios.com/t.png",
    });
  });

  test("carries theme swatches — the field that was being lost", async () => {
    captureFetch({ items: [v2Item({ type: "theme", previewColors: ["#111"] })], pagination: {} });
    expect((await browseItems({})).items[0]?.preview_colors).toEqual(["#111"]);
  });
});
