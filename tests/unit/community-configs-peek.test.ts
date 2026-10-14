/**
 * `peekConfig` is `importConfig` minus the counting, and the counting is the
 * only difference. These tests exist to make that sentence enforceable.
 *
 * The property under test is not local to this repo: the counter lives in the
 * Worker, and what decides whether a read is counted is WHICH ENDPOINT this
 * file asks for. So the assertions are about the request — path, method,
 * headers — rather than about a return value, because the return values of the
 * two calls are identical by design and a test on them would pass even if peek
 * were silently re-pointed at `/import`.
 *
 * That re-pointing is the exact regression this guards: someone tidying two
 * near-identical functions into one, or "fixing" a 404 during a deploy by
 * reusing the endpoint that is known to work. Either would make tELS's
 * marketplace tab inflate every listing's import count on hover.
 */
import { afterEach, describe, expect, test } from "bun:test";

/**
 * These two lines must run BEFORE the module under test is imported.
 *
 * `server/lib/marketplace/fivem.ts` snapshots the FiveM natives off
 * `globalThis` at module-evaluation time into `const` bindings, so a stub
 * installed afterwards is never seen — the call fails with "fGetConvar is not a
 * function". Hence the dynamic import below rather than a static one at the top
 * of the file; a static import is hoisted above these assignments.
 */
const g = globalThis as unknown as Record<string, unknown>;
// Every convar returns its default: the key is baked in, not configured,
// so an unconfigured server is still authenticated. See the comment on
// `TLIB_PUBLIC_KEY` for why that is deliberate.
g.GetConvar = (_name: string, defaultValue: string) => defaultValue;
g.GetCurrentResourceName = () => "tLib";

const { importConfig, peekConfig } = await import("../../server/lib/community-configs/api");

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Swap in a fetch that records the request and answers a valid payload. */
function captureFetch(): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ ok: true, configJson: '{"leds":[]}' }), {
      status: 200,
    });
  }) as typeof fetch;
  return calls;
}

describe("peekConfig does not count an import", () => {
  test("it asks for /peek, never /import", async () => {
    const calls = captureFetch();
    await peekConfig("cfg_abc");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith("/community-configs/cfg_abc/peek");
    // Spelled out separately so the failure message names the actual hazard.
    expect(calls[0].url).not.toContain("/import");
  });

  test("importConfig still asks for /import, so the two are genuinely distinct", async () => {
    const calls = captureFetch();
    await importConfig("cfg_abc");

    expect(calls[0].url).toEndWith("/community-configs/cfg_abc/import");
    expect(calls[0].method).toBe("POST");
  });

  test("peek is a GET with no body", async () => {
    const calls = captureFetch();
    await peekConfig("cfg_abc");

    expect(calls[0].method).toBe("GET");
    expect(calls[0].body).toBeNull();
  });

  test("peek does not send the resource secret", async () => {
    const calls = captureFetch();
    await peekConfig("cfg_abc");

    // `publishConfig` is the only call in that file allowed to send this, and
    // the file header says why: handing the shared secret to a path any
    // anonymous caller can hit is a strictly worse exposure than keeping it in
    // the bundle. Peek is a public read of a row that is public by definition.
    expect(calls[0].headers["x-resource-secret"]).toBeUndefined();
  });

  test("the id is encoded into the path", async () => {
    const calls = captureFetch();
    await peekConfig("a/b?c");

    expect(calls[0].url).toEndWith("/community-configs/a%2Fb%3Fc/peek");
  });

  test("it returns configJson as the raw string", async () => {
    captureFetch();
    expect(await peekConfig("cfg_abc")).toBe('{"leds":[]}');
  });
});
