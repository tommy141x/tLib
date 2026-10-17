// The one HTTP transport for everything this bundle asks the marketplace host.
//
// `fetch`, NOT `PerformHttpRequest`.
//
// `PerformHttpRequest` is a Lua-runtime native and is simply absent from
// globalThis in FiveM's Node server runtime — `./fivem.ts` snapshots it at
// module load and gets `undefined`, so every call through it dies with
// "fPerformHttpRequest is not a function". It fails at CALL time, not load
// time, which is why nothing catches it until a request is actually made.
// The manifest declares Node 22, so global `fetch` is here and is the better
// tool regardless: real methods, real headers, and a real abort on timeout —
// PerformHttpRequest has no cancellation at all.
//
// This file is the former `../community-configs/api.ts` request helper, moved
// up a level unchanged so the browse path can use it without a second copy.
// That module now imports from here.

import { MarketplaceError } from "./api";

export const TIMEOUT_MS = 15_000;

export interface RawResponse {
  ok: boolean;
  status: number;
  body: string;
}

export async function request(
  url: string,
  method: "GET" | "POST",
  body: string,
  headers: Record<string, string>,
  timeoutMs: number = TIMEOUT_MS
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // One try/catch over the fetch AND the body read, because both race the
  // timeout.
  //
  // This was `fetch(...).then(onOk, onErr)`, on the theory that the
  // two-argument form suppressed a recurring runtime log line:
  //
  //   [js] Unhandled promise rejection in resource tLib
  //   [js] Uncaught TypeError: Invalid state: Reader released
  //         node:internal/webstreams/readablestream(159,19): lazyReadableReleasedError
  //
  // IT DID NOT, AND NO SHAPE OF THIS FUNCTION CAN. That promise is created
  // inside Node — `readablestream.js:2316` rejects it and `:2321` hands it to
  // `setPromiseHandled` five lines later — and we never hold it, so there is
  // nothing of ours to attach a handler to. Every frame in the quoted stack is
  // one of those internals calling the next, line for line.
  //
  // It is also not the timeout, which is what the old note claimed. The trigger
  // is a REQUEST BODY, on the success path, with no abort and no error: undici
  // sends the body as `for await (const bytes of request.body.stream)` and
  // ending that loop releases the reader. Measured here with a v8 promise hook
  // (one such promise per body-carrying fetch, none without a body) and
  // independently in tDB, whose `server/utils/http-transport.js` header records
  // the same result from `tests/dev/snippets/probe-bodytypes.js`: every body
  // type does it, no body is clean, node:http with the same body is clean. So
  // the browse and preview paths, which send no body, never could have been the
  // source — only the four community-configs POSTs can be.
  //
  // tDB did NOT fix this with `.then(ok, err)`; the old note conflated two
  // separate things. tDB replaced `fetch` with a node:http transport, which is
  // the only remedy that works, and its `.then(ok, err)` at `client.js:382` is
  // about a different symptom (a handled error being reported twice). A
  // `process.on("unhandledRejection")` filter is not an option either: Node's
  // own event provably does not fire for this, so the line comes from the
  // host's reporter and a listener here would be dead code.
  //
  // What the old shape did cost is real: `onErr` hung off `fetch(...)`, so it
  // never saw `res.text()` reject. Headers arrive long before a stalled body
  // does, so an abort during the body read reached the caller as a raw
  // `AbortError: This operation was aborted` rather than `request_timed_out`.
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e: unknown) {
    // An abort is a timeout; say so rather than surfacing "This operation was
    // aborted", which reads like a bug to whoever sees it in game.
    if (e instanceof Error && (e.name === "AbortError" || controller.signal.aborted)) {
      throw new MarketplaceError("request_timed_out", 0);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a non-2xx into the error type every marketplace path throws, so a caller
 * handling one handles all of them.
 *
 * The Worker answers `{error: string}` on every refusal, and that message is
 * written to be shown to a player ("3 of 4 LEDs in this pattern have no
 * name…"), so it is carried through rather than replaced with a status code.
 */
export function toError(resp: RawResponse): MarketplaceError {
  let code = `http_${resp.status}`;
  try {
    const parsed = JSON.parse(resp.body) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error) code = parsed.error;
  } catch {
    // Non-JSON body: keep the http_<status> fallback.
  }
  return new MarketplaceError(code, resp.status);
}

export function parseJson<T>(resp: RawResponse): T {
  try {
    return JSON.parse(resp.body) as T;
  } catch {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
}
