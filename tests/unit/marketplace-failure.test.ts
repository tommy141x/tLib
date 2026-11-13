/**
 * A failed marketplace read reaches the panel with a kind, not just a string.
 *
 * The case that made this necessary: a customer's Sounds tab said "Failed to load
 * marketplace / HTTP 404" during a website deploy, and a refused connection said
 * "fetch failed". Neither told an admin whether to wait, check their internet or
 * update tLib. What is pinned: each failure lands on the kind that says so, the
 * kind survives the Lua bridge's callback, and every kind has wording.
 *
 * Not provable offline: which of these the live host produces mid-deploy. The v2
 * list route answers an empty catalogue with 200, so a 404 there means the route
 * was not served.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CatalogueError } from "../../shared/ts/marketplace/catalogue";
import {
  asFailureKind,
  classifyMarketplaceFailure,
  FAILURE_COPY,
  MARKETPLACE_FAILURE_KINDS,
} from "../../shared/ts/marketplace/failure";

const g = globalThis as unknown as Record<string, unknown>;
g.GetConvar = (_name: string, defaultValue: string) => defaultValue;
g.GetCurrentResourceName = () => "tLib";
const registered = new Map<string, (...args: unknown[]) => unknown>();
g.exports = (name: string, fn: (...args: unknown[]) => unknown) => registered.set(name, fn);

const { MarketplaceError } = await import("../../server/lib/marketplace/api");
const { registerBridge } = await import("../../server/lib/marketplace/bridge");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("classification", () => {
  const cases: [string, unknown, string][] = [
    ["a 404 with the website's JSON envelope", new CatalogueError("Not found", 404), "not_found"],
    ["a 404 from a proxy with no JSON body", new MarketplaceError("http_404", 404), "not_found"],
    ["a 401", new CatalogueError("Unauthorized", 401), "unauthorized"],
    ["a 403", new MarketplaceError("forbidden", 403), "unauthorized"],
    ["a 429", new MarketplaceError("rate_limited", 429, 30), "rate_limited"],
    [
      "a 503 'not configured'",
      new CatalogueError("Marketplace API is not configured", 503),
      "unavailable",
    ],
    ["a 502", new MarketplaceError("http_502", 502), "unavailable"],
    ["an abort", new CatalogueError("request_timed_out", 0), "timeout"],
    ["a body that is not JSON", new CatalogueError("unexpected_response", 200), "bad_response"],
    ["a 400", new MarketplaceError("slug_required", 400), "error"],
    ["a plain bug", new Error("x is not a function"), "error"],
    ["a thrown string", "boom", "error"],
  ];
  for (const [why, error, kind] of cases) {
    test(`${why} is ${kind}`, () => {
      expect(classifyMarketplaceFailure(error).kind).toBe(kind);
    });
  }

  test("undici's `fetch failed` is unreachable and names the cause code", () => {
    const e = new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }),
    });
    const f = classifyMarketplaceFailure(e);
    expect(f.kind).toBe("unreachable");
    expect(f.message).toContain("ENOTFOUND");
  });

  test("a bare `fetch failed` with no cause is still unreachable", () => {
    expect(classifyMarketplaceFailure(new TypeError("fetch failed")).kind).toBe("unreachable");
  });

  test("an HTTP failure keeps the technical line the server log used to carry", () => {
    expect(classifyMarketplaceFailure(new CatalogueError("http_404", 404)).message).toBe(
      "http_404 (HTTP 404)"
    );
  });

  test("a kind from a newer tLib, or none, reads as a generic error", () => {
    expect(asFailureKind("not_found")).toBe("not_found");
    expect(asFailureKind("brand_new")).toBe("error");
    expect(asFailureKind(undefined)).toBe("error");
  });

  test("every kind has a title and advice, and a 404 says it is not an empty catalogue", () => {
    for (const kind of MARKETPLACE_FAILURE_KINDS) {
      expect(FAILURE_COPY[kind].title.length).toBeGreaterThan(0);
      expect(FAILURE_COPY[kind].advice.length).toBeGreaterThan(0);
    }
    expect(FAILURE_COPY.not_found.advice).toContain("empty catalogue");
    expect(FAILURE_COPY.not_found.advice).toContain("Nothing you have installed is affected");
  });
});

describe("through the Lua bridge", () => {
  registerBridge();
  const mpBrowse = registered.get("mpBrowse") as (json: string, cb: unknown) => void;

  function browse(): Promise<unknown[]> {
    return new Promise((resolve) =>
      mpBrowse(JSON.stringify({ type: "sound" }), (...args: unknown[]) => resolve(args))
    );
  }

  test("a 404 reaches Lua as (false, line, nil, 'not_found')", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>Not Found</html>", { status: 404 })) as typeof fetch;
    const [ok, err, value, kind] = await browse();
    expect(ok).toBe(false);
    expect(err).toBe("http_404 (HTTP 404)");
    expect(value).toBeUndefined();
    expect(kind).toBe("not_found");
  });

  test("a refused connection reaches Lua as 'unreachable'", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      });
    }) as typeof fetch;
    const [ok, err, , kind] = await browse();
    expect(ok).toBe(false);
    expect(String(err)).toContain("ECONNREFUSED");
    expect(kind).toBe("unreachable");
  });

  test("an empty catalogue is a success with no items, not a failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [], pagination: { total: 0, nextCursor: 0, hasMore: false } }),
        {
          status: 200,
        }
      )) as typeof fetch;
    const [ok, , json] = await browse();
    expect(ok).toBe(true);
    expect(JSON.parse(json as string).items).toEqual([]);
  });
});
