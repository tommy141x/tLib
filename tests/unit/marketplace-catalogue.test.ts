/**
 * The shared catalogue transport.
 *
 * This is the module tRadio's admin server and tLib's NUI bridge both compile
 * in, so a defect here is a defect in every resource at once. Three things are
 * pinned:
 *
 * 1. **Field totality.** The headline test round-trips a fully-populated v2
 *    item and asserts deep equality with what the backend actually sends. That
 *    is not a formality: `previewColors` reached tRadio and was dropped on the
 *    way into tLib's item shape, and tRadio's own store carries a comment about
 *    theme swatches having already been lost once to this exact class of drift.
 *    A field added to `toV2Item` upstream and not here fails this test rather
 *    than rendering an empty swatch row.
 *
 * 2. **Presence, not nullability.** Every consumer checks `if (item.previewUrl)`.
 *    An absent field must be ABSENT, not `undefined` and not `null`.
 *
 * 3. **The credential is sent, and the scope is real.** `resource` is what makes
 *    "in tRadio you browse only tRadio items" true rather than nominal, and the
 *    secret is what makes v2 reachable at all.
 *
 * NOT under test, and not testable here: that the request succeeds against the
 * live host, and that the browser permits it. The defect this whole track fixes
 * was a CORS refusal, which only a browser enforces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

const g = globalThis as unknown as Record<string, unknown>;
/**
 * No secret stub here, deliberately.
 *
 * The resource secret is a BAKED-IN constant, not a convar — see
 * `MARKETPLACE_RESOURCE_SECRET`'s comment for why that is intended and not an
 * oversight. So the tests assert against the real exported value: if someone
 * converts it back to operator-supplied configuration, these fail.
 */
const convarStub = (_name: string, defaultValue: string) => defaultValue;

g.GetConvar = convarStub;

const {
  _resetServerId,
  assertBundleHash,
  assertItemBelongsToResource,
  assertItemResource,
  browseCatalogue,
  catalogueQuery,
  fetchCatalogueItem,
  ITEM_RESOURCE_MISMATCH,
  ITEM_RESOURCE_UNKNOWN,
  MARKETPLACE_HASH_HEADER,
  MARKETPLACE_RESOURCE_SECRET,
  marketplaceApiV2,
  marketplaceHeaders,
  toCatalogueItem,
} = await import("../../shared/ts/marketplace/catalogue");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  g.GetConvar = convarStub;
  _resetServerId();
});
beforeEach(() => {
  _resetServerId();
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
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

const emptyPage = { items: [], pagination: { total: 0, nextCursor: 0, hasMore: false } };

describe("field totality", () => {
  /**
   * Every field `toV2Item` can emit, populated. Types are mutually exclusive
   * upstream — a real item is never both a sound and a theme — but populating
   * all of them at once is deliberate: this test is about the mapping being
   * total, not about any one item being plausible.
   */
  const fullV2Item = {
    id: "itm_1",
    slug: "midnight",
    type: "theme",
    resource: "tRadio",
    name: "Midnight",
    description: "A dark theme",
    creatorName: "Ada",
    currentVersion: "1",
    sizeBytes: 4096,
    downloads: 12,
    createdAt: "2026-09-01T00:00:00.000Z",
    previewWaveform: [0.1, 0.9],
    previewColors: ["#000", "#fff"],
    thumbnail: "https://timmygstudios.com/api/storage/t/abc.png",
    previewUrl: "https://timmygstudios.com/api/storage/p/abc.ogg",
  };

  test("carries every v2 field through unchanged", () => {
    // Deep equality, not toMatchObject: this must fail when a field is DROPPED,
    // and toMatchObject passes happily on a subset.
    expect(toCatalogueItem(fullV2Item)).toEqual(fullV2Item);
  });

  test("keeps theme swatches — the field that was being lost", () => {
    // Called out separately from the round trip so the failure message names
    // the regression rather than printing a 15-key diff.
    expect(toCatalogueItem(fullV2Item).previewColors).toEqual(["#000", "#fff"]);
  });

  test("survives a hostile shape instead of rendering NaN or undefined", () => {
    const item = toCatalogueItem({ slug: "x", sizeBytes: null, downloads: "12", name: 7 });
    expect(item.sizeBytes).toBe(0);
    expect(item.downloads).toBe(0);
    expect(item.name).toBe("");
    expect(item.creatorName).toBe("Anonymous");
  });
});

describe("presence, not nullability", () => {
  test("omits every optional key when the listing has none", () => {
    // `previewUrl: null` on a UI item makes it claim to be playable;
    // `previewColors: null` on a theme renders an empty swatch row rather than
    // falling through to the placeholder tile.
    const item = toCatalogueItem({ slug: "x" });
    for (const key of ["previewWaveform", "previewColors", "thumbnail", "previewUrl"]) {
      expect(key in item).toBe(false);
    }
  });

  test("omits a colour array that survives filtering empty", () => {
    // `[123]` is not colours. Emitting `[]` would render a theme card with a
    // swatch row of nothing in it, which reads as a broken item.
    expect("previewColors" in toCatalogueItem({ slug: "x", previewColors: [123] })).toBe(false);
  });
});

describe("the request", () => {
  test("asks v2, never the CORS-blocked v1 list", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(calls[0]?.url).toContain("/api/v2/marketplace/items");
    expect(calls[0]?.url).not.toContain("/api/v1/");
  });

  test("scopes to one resource, which is what makes the filter real", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({ resource: "tRadio", type: "theme" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("resource")).toBe("tRadio");
    expect(url.searchParams.get("type")).toBe("theme");
  });

  test("sends the resource secret and the install label", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(calls[0]?.headers["x-resource-secret"]).toBe(MARKETPLACE_RESOURCE_SECRET);
    expect(calls[0]?.headers["x-fivem-server"]).toMatch(/^[0-9a-f]{32}$/);
  });

  test("never sends the raw licence key", async () => {
    // The label is a hash precisely because sv_licenseKey is used for other
    // sensitive purposes; it must not go over the wire in any form.
    g.GetConvar = (name: string, d: string) =>
      name === "sv_licenseKey" ? "SECRET-LICENCE" : convarStub(name, d);
    _resetServerId();
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(JSON.stringify(calls[0])).not.toContain("SECRET-LICENCE");
  });

  test("honours a self-hosted base URL instead of pinning production", async () => {
    // An operator who points tmarketplace_base_url at their own host must not
    // have this silently keep hitting ours.
    g.GetConvar = (name: string, d: string) =>
      name === "tmarketplace_base_url" ? "https://example.test/" : convarStub(name, d);
    expect(marketplaceApiV2()).toBe("https://example.test/api/v2/marketplace");
  });

  test("omits a zero cursor rather than asserting the default", () => {
    expect(catalogueQuery({ cursor: 0 })).toBe("");
    expect(catalogueQuery({ cursor: 20 })).toBe("cursor=20");
  });

  test("lets a caller add headers without losing the credential", () => {
    const h = marketplaceHeaders({ Accept: "text/html" });
    expect(h.Accept).toBe("text/html");
    expect(h["X-Resource-Secret"]).toBe(MARKETPLACE_RESOURCE_SECRET);
  });

  test("authenticates with no operator setup at all", async () => {
    // The regression guard for a change that was made once and reverted: the
    // secret is public ON PURPOSE, a speed bump against scripting the API from
    // a browser rather than a credential. Requiring a convar would break every
    // existing install and buy nothing, since the same shared string would just
    // move from a zip a customer can open into a config file they can read.
    //
    // `GetConvar` here returns the default for everything, i.e. a server that
    // has configured nothing. The call must still be authenticated.
    g.GetConvar = (_name: string, d: string) => d;
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(calls[0]?.headers["x-resource-secret"]).toBe(MARKETPLACE_RESOURCE_SECRET);
    expect(MARKETPLACE_RESOURCE_SECRET).toBeTruthy();
  });
});

describe("paging and failure", () => {
  test("reports the server's own hasMore", async () => {
    captureFetch({
      items: [{ slug: "a" }],
      pagination: { total: 40, nextCursor: 1, hasMore: true },
    });
    const page = await browseCatalogue({});
    expect(page).toMatchObject({ total: 40, nextCursor: 1, hasMore: true });
  });

  test("advances the cursor itself when the server sends none", async () => {
    // A missing cursor would otherwise pin a panel to page one forever.
    captureFetch({ items: [{ slug: "a" }, { slug: "b" }] });
    expect((await browseCatalogue({ cursor: 10 })).nextCursor).toBe(12);
  });

  test("drops an item with no slug", async () => {
    // Slug is the install identity; a card without one has an Install button
    // that can only ever fail.
    captureFetch({ items: [{ slug: "a" }, { name: "no slug" }] });
    expect((await browseCatalogue({})).items).toHaveLength(1);
  });

  test("surfaces the server's error code, not the bare status", async () => {
    // The Worker's refusals are written to be read by whoever is looking at the
    // panel; `http_429` is not.
    captureFetch({ error: "rate_limited" }, 429);
    expect(browseCatalogue({})).rejects.toThrow(/rate_limited/);
  });

  test("reports a non-JSON body as an unexpected response", async () => {
    captureFetch("<html>502</html>", 200);
    expect(browseCatalogue({})).rejects.toThrow(/unexpected_response/);
  });

  test("calls a timeout a timeout", async () => {
    // Not "This operation was aborted", which reads as a bug in the panel.
    globalThis.fetch = (async (_u: unknown, init: RequestInit = {}) => {
      await new Promise((r) => setTimeout(r, 50));
      (init.signal as AbortSignal).throwIfAborted();
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(browseCatalogue({}, 5)).rejects.toThrow(/request_timed_out/);
  });
});

/**
 * Bundle integrity.
 *
 * tLib's own install agent has verified this digest since it was written
 * (`installer/bundle.ts`'s `prepareBundle`). tRadio's install path verified
 * nothing but two ZIP magic bytes, which a substituted archive also has —
 * `assertBundleHash` is that check factored out so a caller doing its own
 * extraction can reuse it rather than re-derive it.
 */
describe("assertBundleHash", () => {
  const bytes = Buffer.from("a bundle's worth of bytes", "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");

  test("accepts the matching digest, bare or sha256:-prefixed, in either case", () => {
    for (const header of [digest, `sha256:${digest}`, digest.toUpperCase(), ` ${digest} `]) {
      expect(() => assertBundleHash(bytes, header)).not.toThrow();
    }
  });

  test("rejects a digest that does not match the bytes", () => {
    expect(() => assertBundleHash(bytes, "0".repeat(64))).toThrow(/bundle_hash_mismatch/);
  });

  /**
   * FAILS CLOSED. Stripping a response header is strictly easier than forging a
   * digest, so "we could not check" is the case an attacker controls and must
   * not be the case that installs.
   */
  test("rejects a missing digest rather than waving the bundle through", () => {
    for (const header of [null, undefined, "", "   "]) {
      expect(() => assertBundleHash(bytes, header)).toThrow(/missing_or_invalid_bundle_hash/);
    }
  });

  test("rejects a digest that is not sha256-shaped", () => {
    for (const header of ["not-a-hash", "abc123", "g".repeat(64), digest.slice(0, 63)]) {
      expect(() => assertBundleHash(bytes, header)).toThrow(/missing_or_invalid_bundle_hash/);
    }
  });

  test("names the header the live backend actually sets", () => {
    // tg-new/src/lib/marketplace/shared.ts sets `X-Marketplace-File-Hash`;
    // Headers.get() is case-insensitive, the literal here is not.
    expect(MARKETPLACE_HASH_HEADER).toBe("x-marketplace-file-hash");
  });
});

/**
 * Cross-product install enforcement.
 *
 * The gap this closes: tLib's coordinator keys registrations `resource:type`
 * and writes into that resource's own registered `installPath`, so a tELS item
 * could never land in tRadio's DIRECTORY. The item's own `resource` field was
 * the unenforced half — `install('tRadar', 'ui', '<a-tELS-slug>')` passed every
 * check and tLib fetched and installed it.
 *
 * It could not be answered client-side before this, and that is the reason the
 * per-slug fetch is here rather than the install paths each deriving it: v2's
 * `search` matches `name` and `description` and never `slug`, and neither
 * `/download` nor `/items/:slug/theme` carries a `resource` field at all.
 */
describe("item ownership", () => {
  const owned = {
    id: "itm_1",
    slug: "midnight",
    type: "theme",
    resource: "tRadio",
    name: "Midnight",
    description: "",
    creatorName: "Ada",
    currentVersion: "1",
    sizeBytes: 1,
    downloads: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  test("asks v2's per-slug endpoint — the only one that answers who owns a slug", async () => {
    const calls = captureFetch(owned);
    await fetchCatalogueItem("midnight");
    expect(calls[0]?.url).toBe(`${marketplaceApiV2()}/items/midnight`);
    expect(calls[0]?.headers["x-resource-secret"]).toBe(MARKETPLACE_RESOURCE_SECRET);
  });

  test("escapes the slug rather than pasting it into a path", async () => {
    const calls = captureFetch(owned);
    await fetchCatalogueItem("a/../b");
    expect(calls[0]?.url).toBe(`${marketplaceApiV2()}/items/a%2F..%2Fb`);
  });

  test("accepts the product that owns the item", async () => {
    captureFetch(owned);
    await expect(assertItemBelongsToResource("midnight", "tRadio")).resolves.toMatchObject({
      slug: "midnight",
      resource: "tRadio",
    });
  });

  test("refuses an item another product owns — the whole point", async () => {
    captureFetch({ ...owned, resource: "tELS" });
    await expect(assertItemBelongsToResource("midnight", "tRadio")).rejects.toThrow(
      new RegExp(ITEM_RESOURCE_MISMATCH)
    );
  });

  test("tolerates case, which is the one difference that is not a different product", () => {
    // `expectedResource` is the same string the panel sends as v2's `resource`
    // filter, so it already has to match for browse to have shown anything.
    // No two products here differ only by case.
    expect(() => assertItemResource(toCatalogueItem(owned), "tradio")).not.toThrow();
    expect(() => assertItemResource(toCatalogueItem(owned), " tRadio ")).not.toThrow();
  });

  /**
   * FAILS CLOSED, the same way `assertBundleHash` does on a missing digest.
   * Stripping a field is easier than forging one, so "we could not establish
   * ownership" is the state an attacker controls and must not be the state that
   * installs.
   */
  test("refuses an item whose owner the marketplace did not state", () => {
    for (const resource of [undefined, null, "", "   "]) {
      expect(() => assertItemResource(toCatalogueItem({ ...owned, resource }), "tRadio")).toThrow(
        new RegExp(ITEM_RESOURCE_UNKNOWN)
      );
    }
  });

  test("refuses when the caller names no product either", () => {
    expect(() => assertItemResource(toCatalogueItem(owned), "")).toThrow(
      new RegExp(ITEM_RESOURCE_UNKNOWN)
    );
  });

  test("refuses rather than resolves when the marketplace is unreachable", async () => {
    captureFetch({ error: "rate_limited" }, 429);
    await expect(assertItemBelongsToResource("midnight", "tRadio")).rejects.toThrow(/rate_limited/);
  });

  test("surfaces a 404 as the backend's own refusal, not as a mismatch", async () => {
    // A caller that wants to tell "no such item" from "wrong product" needs the
    // status, so this is deliberately NOT translated into ITEM_RESOURCE_*.
    captureFetch({ error: "Not found" }, 404);
    await expect(assertItemBelongsToResource("nope", "tRadio")).rejects.toThrow(/Not found/);
  });

  test("refuses a body that is JSON but is not an item", async () => {
    // `toCatalogueItem` is total and never throws, so this would otherwise
    // arrive as an item with an empty `resource` — i.e. as an ownership answer.
    for (const body of [null, [], { pagination: {} }]) {
      captureFetch(body);
      await expect(fetchCatalogueItem("midnight")).rejects.toThrow(/unexpected_response/);
    }
  });

  test("calls a timeout a timeout here too", async () => {
    globalThis.fetch = (async (_u: unknown, init: RequestInit = {}) => {
      await new Promise((r) => setTimeout(r, 50));
      (init.signal as AbortSignal).throwIfAborted();
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(fetchCatalogueItem("midnight", 5)).rejects.toThrow(/request_timed_out/);
  });
});
