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

  // `.then(onOk, onErr)`, NOT `try { await fetch(...) } catch`.
  //
  // Those are equivalent in Node and are NOT equivalent here. A try/catch
  // around an `await` attaches its rejection handler a turn too late for
  // FiveM's reporting, so an aborted fetch is caught correctly AND still
  // printed as an unhandled rejection:
  //
  //   [js] Unhandled promise rejection in resource tLib
  //   [js] Uncaught TypeError: Invalid state: Reader released
  //         node:internal/webstreams/readablestream(159,19): lazyReadableReleasedError
  //         ... readableStreamDefaultReaderRead / pullWithDefaultReader ...
  //
  // That is the stream being torn down mid-read when the timeout aborts it:
  // the body reader is released while a pull is still in flight. It repeated
  // six times in one evening on 305RP2 while the marketplace host was
  // unreachable, and it is pure noise — the error IS handled and the caller
  // does get `request_timed_out`.
  //
  // Settling with the two-argument form owns the rejection in the turn it is
  // created, which is what stops the runtime also claiming it. This is the
  // same fix tDB applied to its PocketBase client for an identical double
  // report; it is a property of this runtime, not of these two modules.
  const settle = fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
    signal: controller.signal,
  }).then(
    async (res) => {
      // Read the body inside the same chain. `res.text()` is the half that
      // actually races the abort — headers can arrive well before a stalled
      // body does — so it must not be awaited outside this handler.
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    },
    (e: unknown) => {
      // An abort is a timeout; say so rather than surfacing "This operation
      // was aborted", which reads like a bug to whoever sees it in game.
      if (e instanceof Error && (e.name === "AbortError" || controller.signal.aborted)) {
        throw new MarketplaceError("request_timed_out", 0);
      }
      throw e;
    }
  );

  try {
    return await settle;
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
