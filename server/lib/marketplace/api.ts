// The marketplace error envelope. Requests themselves live in `./http.ts`.
//
// This file used to carry a second HTTP client as well — a `PerformHttpRequest`
// promise wrapper (`nodeRequest`), a `SimpleResponse` shape to describe its
// result, a `fetchWithTimeout` that forwarded to it unchanged, and a
// `toMarketplaceError` typed against a DOM `Response` this module never
// produced. Sixty of its ninety-nine lines, and nothing called any of it:
// `http.ts` is the client, and it has its own `toError`.

/** The envelope the website returns on 4xx/5xx. */
export class MarketplaceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfter?: number
  ) {
    super(`${code} (HTTP ${status}${retryAfter ? `, retry after ${retryAfter}s` : ""})`);
  }
}
