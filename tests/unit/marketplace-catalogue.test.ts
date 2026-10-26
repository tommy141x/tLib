/**
 * Shared catalogue transport, compiled into both tRadio's admin server and
 * tLib's NUI bridge — a defect here hits every resource at once.
 *
 * Pinned: field totality (round-trips a full v2 item with deep equality;
 * `previewColors` was dropped once on the way into tLib's item shape),
 * presence over nullability (an absent field is absent, never null/undefined),
 * and that `resource` scoping plus the credential are both real.
 * Not testable here: the live host accepting the request — the bug this
 * fixes was a CORS refusal, which only a browser enforces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { setInstallIdResolver } from "../../shared/ts/install-id";

const g = globalThis as unknown as Record<string, unknown>;
// Tests assert against the real exported TLIB_PUBLIC_KEY, not a stub — see
// its own comment for why it's a baked-in constant rather than a convar.
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
  TLIB_PUBLIC_KEY,
  marketplaceApiV2,
  marketplaceHeaders,
  MARKETPLACE_IDENTITY_HEADER,
  setCatalogueLike,
  studioHeaders,
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
  // The like path has no body either way — POST adds, DELETE withdraws, and
  // method is the only thing that distinguishes them.
  method: string;
}

function captureFetch(body: unknown, status = 200): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers, method: String(init.method ?? "GET") });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

const emptyPage = { items: [], pagination: { total: 0, nextCursor: 0, hasMore: false } };

describe("field totality", () => {
  // Every field toV2Item can emit, populated at once. Real items are never
  // both a sound and a theme; the point here is mapping totality, not plausibility.
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
    // Deep equality, not toMatchObject — must fail if a field is dropped,
    // not just if one is wrong.
    expect(toCatalogueItem(fullV2Item)).toEqual(fullV2Item);
  });

  test("keeps theme swatches — the field that was being lost", () => {
    // Separate from the round trip so a failure names the regression instead
    // of printing a 15-key diff.
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
    // `previewUrl: null` makes an item claim to be playable; `previewColors:
    // null` renders an empty swatch row instead of the placeholder tile.
    const item = toCatalogueItem({ slug: "x" });
    for (const key of ["previewWaveform", "previewColors", "thumbnail", "previewUrl"]) {
      expect(key in item).toBe(false);
    }
  });

  test("omits a colour array that survives filtering empty", () => {
    // `[123]` is not colours; emitting `[]` would render a theme card with an
    // empty swatch row, which reads as broken.
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

  test("sends the public key and the install label", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(calls[0]?.headers["x-resource-secret"]).toBe(TLIB_PUBLIC_KEY);
    expect(calls[0]?.headers["x-fivem-server"]).toMatch(/^[0-9a-f]{32}$/);
  });

  // The reason one shared key is acceptable at all: `x-resource-secret` only
  // says "some install of something in this estate", so `x-install-id` is
  // what lets tWeb rate-limit or mute one server. Set in `studioHeaders`, the
  // single builder every call below shares, rather than per-endpoint.
  // Must be OMITTED, never blank, when nothing resolves — an empty value fails
  // tWeb's `/^[0-9a-z]{25}$/` and a 400 on browse reads as "marketplace is down".
  test("carries the install id on every call, and omits it rather than blanking it", async () => {
    const id = "a1b2c3d4e5f6g7h8i9j0k1l2m";
    setInstallIdResolver(() => id);
    try {
      const browse = captureFetch(emptyPage);
      await browseCatalogue({});
      expect(browse[0]?.headers["x-install-id"]).toBe(id);

      // Same builder, so the unauthenticated variant carries it too — the one
      // community-configs' open reads go out on.
      expect(studioHeaders()["x-install-id"]).toBe(id);
      expect(marketplaceHeaders()["x-install-id"]).toBe(id);
    } finally {
      setInstallIdResolver(null);
    }

    const anon = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(anon[0]?.headers).not.toHaveProperty("x-install-id");
    expect(marketplaceHeaders()).not.toHaveProperty("x-install-id");
  });

  test("never sends the raw licence key", async () => {
    // The label is a hash because sv_licenseKey has other sensitive uses and
    // must not go over the wire in any form.
    g.GetConvar = (name: string, d: string) =>
      name === "sv_licenseKey" ? "SECRET-LICENCE" : convarStub(name, d);
    _resetServerId();
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(JSON.stringify(calls[0])).not.toContain("SECRET-LICENCE");
  });

  test("honours a self-hosted base URL instead of pinning production", async () => {
    // An operator pointing tlib_api_base_url at their own host must not have
    // this silently keep hitting ours.
    g.GetConvar = (name: string, d: string) =>
      name === "tlib_api_base_url" ? "https://example.test/" : convarStub(name, d);
    expect(marketplaceApiV2()).toBe("https://example.test/api/v2/marketplace");
  });

  test("omits a zero cursor rather than asserting the default", () => {
    expect(catalogueQuery({ cursor: 0 })).toBe("");
    expect(catalogueQuery({ cursor: 20 })).toBe("cursor=20");
  });

  test("lets a caller add headers without losing the credential", () => {
    const h = marketplaceHeaders({ Accept: "text/html" });
    expect(h.Accept).toBe("text/html");
    expect(h["X-Resource-Secret"]).toBe(TLIB_PUBLIC_KEY);
  });

  test("authenticates with no operator setup at all", async () => {
    // Regression guard for a change made once and reverted: the secret is
    // public on purpose, a speed bump rather than a credential, so requiring
    // a convar would break every install for nothing — the same string would
    // just move from a zip a customer can open to a config file they can read.
    // `GetConvar` here returns the default for everything; the call must
    // still authenticate.
    g.GetConvar = (_name: string, d: string) => d;
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(calls[0]?.headers["x-resource-secret"]).toBe(TLIB_PUBLIC_KEY);
    expect(TLIB_PUBLIC_KEY).toBeTruthy();
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
    // A missing cursor would pin a panel to page one forever.
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

// Bundle integrity. tLib's install agent (`installer/bundle.ts`'s
// `prepareBundle`) has verified this digest since it was written; tRadio's
// install path verified only two ZIP magic bytes, which a substituted archive
// also has. `assertBundleHash` factors the real check out for reuse.
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

  // Fails closed: stripping a response header is easier than forging a
  // digest, so "we could not check" must not be the case that installs.
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

// Cross-product install enforcement. tLib's coordinator keys registrations
// `resource:type` and writes into that resource's own `installPath`, but the
// item's own `resource` field was unenforced: `install('tRadar', 'ui',
// '<a-tLS-slug>')` passed every check. A per-slug fetch is needed because v2's
// `search` matches only `name`/`description`, and neither `/download` nor
// `/items/:slug/theme` carries a `resource` field.
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
    expect(calls[0]?.headers["x-resource-secret"]).toBe(TLIB_PUBLIC_KEY);
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
    captureFetch({ ...owned, resource: "tLS" });
    await expect(assertItemBelongsToResource("midnight", "tRadio")).rejects.toThrow(
      new RegExp(ITEM_RESOURCE_MISMATCH)
    );
  });

  test("tolerates case, which is the one difference that is not a different product", () => {
    // `expectedResource` is the same string sent as v2's `resource` filter, so
    // it already matched for browse to show anything; no two products here
    // differ only by case.
    expect(() => assertItemResource(toCatalogueItem(owned), "tradio")).not.toThrow();
    expect(() => assertItemResource(toCatalogueItem(owned), " tRadio ")).not.toThrow();
  });

  // Fails closed, same as assertBundleHash on a missing digest: stripping a
  // field is easier than forging one, so "ownership not established" must
  // not be the state that installs.
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

describe("the like count on the wire", () => {
  const base = {
    id: "itm_1",
    slug: "midnight",
    type: "theme",
    resource: "tRadio",
    name: "Midnight",
    description: "d",
    creatorName: "Ada",
    currentVersion: "1",
    sizeBytes: 4096,
    downloads: 12,
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  // `likes` must not go through `num()` the way `downloads` does: `num()`
  // maps a missing value to `0`, a real like count, so coercing would make a
  // host that predates likes indistinguishable from an item nobody liked.
  // These two tests are the pair that catches it — neither alone would.
  test("omits likes entirely when the host does not send it", () => {
    const item = toCatalogueItem(base);
    expect("likes" in item).toBe(false);
  });

  test("carries a real zero, because zero likes is a fact about the item", () => {
    const item = toCatalogueItem({ ...base, likes: 0 });
    expect("likes" in item).toBe(true);
    expect(item.likes).toBe(0);
  });

  test("carries a real count", () => {
    expect(toCatalogueItem({ ...base, likes: 9 }).likes).toBe(9);
  });

  test("drops a nonsense count rather than zeroing it", () => {
    for (const value of [NaN, Infinity, "9", null]) {
      expect("likes" in toCatalogueItem({ ...base, likes: value })).toBe(false);
    }
  });

  // `liked` is a presence check, not a truthiness one: absent means "no
  // identity was asserted" (no control), `false` means "not liked yet" (an
  // empty heart). Collapsing the two removes the control for everyone who
  // hasn't liked the item.
  test("keeps a false liked flag and omits an absent one", () => {
    expect("liked" in toCatalogueItem(base)).toBe(false);
    const no = toCatalogueItem({ ...base, liked: false });
    expect("liked" in no).toBe(true);
    expect(no.liked).toBe(false);
    expect(toCatalogueItem({ ...base, liked: true }).liked).toBe(true);
  });
});

describe("the identity a browse carries", () => {
  // A player license is a header, never a query parameter: a URL is a cache
  // key and gets logged, so putting a per-player id in the query string would
  // give every player a distinct URL and write a durable identifier into
  // every access log on the path.
  test("never serialises the identity into the query string", () => {
    const qs = catalogueQuery({ resource: "tRadio", identity: "a1b2c3d4" });
    expect(qs).not.toContain("a1b2c3d4");
    expect(qs).not.toContain("identity");
    expect(qs).toContain("resource=tRadio");
  });

  test("sends it as a header when there is one, alongside the credential", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({ identity: "a1b2c3d4" });
    const headers = calls[0]?.headers ?? {};
    expect(headers[MARKETPLACE_IDENTITY_HEADER.toLowerCase()]).toBe("a1b2c3d4");
    // The secret must still be there — identity is an addition, not a
    // replacement, and `marketplaceHeaders` merges caller extras last, so a
    // careless spread could have dropped it.
    expect(headers["x-resource-secret"]).toBe(TLIB_PUBLIC_KEY);
  });

  test("sends no identity header at all when there is no player", async () => {
    const calls = captureFetch(emptyPage);
    await browseCatalogue({});
    expect(MARKETPLACE_IDENTITY_HEADER.toLowerCase() in (calls[0]?.headers ?? {})).toBe(false);
  });
});

describe("setCatalogueLike", () => {
  const state = { likes: 4, liked: true };

  test("POSTs to the slug's like endpoint to like", async () => {
    const calls = captureFetch(state);
    await setCatalogueLike("midnight", "a1b2c3d4", true);
    expect(calls[0]?.url).toBe(`${marketplaceApiV2()}/items/midnight/like`);
    expect(calls[0]?.method).toBe("POST");
  });

  test("DELETEs the same URL to withdraw", async () => {
    const calls = captureFetch({ likes: 3, liked: false });
    await setCatalogueLike("midnight", "a1b2c3d4", false);
    expect(calls[0]?.method).toBe("DELETE");
  });

  test("escapes the slug rather than pasting it into a path", async () => {
    const calls = captureFetch(state);
    await setCatalogueLike("a/../b", "a1b2c3d4", true);
    expect(calls[0]?.url).toContain("a%2F..%2Fb");
  });

  // The identity goes in the header the backend's write path reads, and the
  // secret is still sent: the secret gets the request past the door, the
  // identity names the player once inside. Losing either fails silently
  // at the panel.
  test("carries the identity header and the resource secret", async () => {
    const calls = captureFetch(state);
    await setCatalogueLike("midnight", "a1b2c3d4", true);
    const headers = calls[0]?.headers ?? {};
    expect(headers[MARKETPLACE_IDENTITY_HEADER.toLowerCase()]).toBe("a1b2c3d4");
    expect(headers["x-resource-secret"]).toBe(TLIB_PUBLIC_KEY);
  });

  // Refused before any request is made. A caller that forgot to resolve the
  // license has a bug; letting it through would produce a 400 that reads at
  // the panel as "the marketplace is down".
  test("refuses to call at all without an identity", async () => {
    const calls = captureFetch(state);
    await expect(setCatalogueLike("midnight", "", true)).rejects.toThrow("identity_required");
    expect(calls.length).toBe(0);
  });

  test("refuses an empty slug without calling", async () => {
    const calls = captureFetch(state);
    await expect(setCatalogueLike("", "a1b2c3d4", true)).rejects.toThrow("slug_required");
    expect(calls.length).toBe(0);
  });

  // The server's numbers, read as-is — the caller must not keep its own ±1,
  // since the count may have moved for other reasons and the write is
  // idempotent (a second like answers the same count, not one more).
  test("returns the server's own state", async () => {
    captureFetch({ likes: 41, liked: true });
    expect(await setCatalogueLike("midnight", "a1b2c3d4", true)).toEqual({
      likes: 41,
      liked: true,
    });
  });

  test("reads a missing liked as false and a missing count as 0", async () => {
    captureFetch({});
    expect(await setCatalogueLike("midnight", "a1b2c3d4", true)).toEqual({
      likes: 0,
      liked: false,
    });
  });

  // The refusal the identity gate produces — liking as an account on the
  // website rather than a FiveM license. Must reach the panel as the
  // backend's own sentence, not `http_403`, since that sentence is the only
  // thing that says what went wrong.
  test("surfaces the host's refusal, not the bare status", async () => {
    captureFetch(
      {
        error: "A game server may only like as a FiveM license, never as an account on this site.",
      },
      403
    );
    await expect(setCatalogueLike("midnight", "a1b2c3d4", true)).rejects.toThrow(
      /may only like as a FiveM license/
    );
  });

  test("reports a non-JSON body as an unexpected response", async () => {
    captureFetch("<html>502</html>");
    await expect(setCatalogueLike("midnight", "a1b2c3d4", true)).rejects.toThrow(
      "unexpected_response"
    );
  });
});
