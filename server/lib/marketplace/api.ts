// Thin wrapper over the marketplace HTTP API. Downloads authenticate with a
// shared secret embedded in this bundle, and are rate-limited server-side by IP
// plus the X-FiveM-Server header derived from sv_licenseKey.

import {
  MARKETPLACE_RESOURCE_SECRET,
  marketplaceServerId,
} from "../../../shared/ts/marketplace/catalogue";
import { fPerformHttpRequest } from "./fivem";

interface SimpleResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function nodeRequest(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    fPerformHttpRequest(
      url,
      (statusCode, body, responseHeaders) => {
        clearTimeout(timer);
        const lowerHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(responseHeaders ?? {})) {
          lowerHeaders[k.toLowerCase()] = v;
        }
        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          headers: { get: (name: string) => lowerHeaders[name.toLowerCase()] ?? null },
          json: () => Promise.resolve(JSON.parse(body) as unknown),
          arrayBuffer: () => {
            const buf = Buffer.from(body, "binary");
            return Promise.resolve(
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
            );
          },
        });
      },
      "GET",
      "",
      headers
    );
  });
}


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

/**
 * The marketplace resource secret, re-exported under this file's older name.
 *
 * ⚠️ NOT a second copy. It used to be a literal here AND a literal in
 * `shared/ts/marketplace/catalogue.ts`, which meant one string to rotate in two
 * places — exactly the shape of hazard where a rotation half-lands and the half
 * nobody tested keeps 401ing in production. There is now one definition; read
 * the long note on `MARKETPLACE_RESOURCE_SECRET` for why it is public by design
 * and must never become a convar or reach a FiveM export.
 *
 * The alias stays because `../community-configs/api.ts` imports `_RS` and the
 * short name reads better at its call sites than the full constant would.
 */
export const _RS = MARKETPLACE_RESOURCE_SECRET;

/**
 * Exported for `server/community-configs/api.ts`; see the note on `_RS`.
 *
 * ⚠️ Deliberately carries NO `X-Resource-Secret`. Callers add it per request,
 * because community-configs authenticates only its publish call and must stay
 * anonymous on the rest. Do not "complete" these headers with the secret —
 * `marketplaceHeaders()` in the shared catalogue is the variant that includes
 * it, and the two are separate for that reason.
 */
export function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    // Same derivation this file used to do inline, now shared so the rate-limit
    // key is memoised once rather than once per transport. One behavioural
    // nuance came with it: a `sv_projectName` set to whitespace now falls back
    // to `unknown-server` instead of the empty string.
    "X-FiveM-Server": marketplaceServerId(),
    ...(extra ?? {}),
  };
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SimpleResponse> {
  return nodeRequest(url, headers, timeoutMs);
}

async function toMarketplaceError(resp: Response): Promise<MarketplaceError> {
  let code = `http_${resp.status}`;
  let retryAfter: number | undefined;
  try {
    const body = (await resp.json()) as { error?: string; retry_after?: number };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.retry_after === "number") retryAfter = body.retry_after;
  } catch {
    // Non-JSON body: keep the http_<status> fallback.
  }
  return new MarketplaceError(code, resp.status, retryAfter);
}
