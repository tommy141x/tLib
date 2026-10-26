// The one HTTP transport this bundle uses to call the marketplace host.
//
// fetch, not PerformHttpRequest: that native is absent from globalThis in
// FiveM's Node server runtime, so a call through it dies with "fPerformHttpRequest
// is not a function" — at call time, not load time. Node 22's global fetch is
// also the better tool: real headers and a real abort on timeout, which
// PerformHttpRequest has none of.

import { MarketplaceError } from "./api";

export const TIMEOUT_MS = 15_000;

export interface RawResponse {
  ok: boolean;
  status: number;
  body: string;
}

export async function request(
  url: string,
  method: "GET" | "POST" | "PATCH",
  body: string,
  headers: Record<string, string>,
  timeoutMs: number = TIMEOUT_MS
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // try/catch wraps the fetch AND the body read, since both race the timeout.
  //
  // Any body-carrying fetch (not a timeout, not an abort) logs "Unhandled
  // promise rejection ... Reader released" from undici's own internal body
  // stream reader on the success path — the rejection is created and settled
  // inside Node before this code ever holds the promise, so nothing here can
  // catch it; only swapping fetch for a node:http transport avoids it (see tDB).
  // Requests with no body (browse, preview) never trigger it.
  //
  // The earlier `.then(onOk, onErr)` shape missed `res.text()` rejecting, so an
  // abort during a stalled body read reached the caller as a raw `AbortError`
  // instead of `request_timed_out`.
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
