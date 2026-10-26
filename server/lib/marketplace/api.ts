// The marketplace error envelope. Requests themselves live in `./http.ts`,
// which has its own client and its own `toError`.

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
