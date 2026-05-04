// Thin wrapper over the marketplace HTTP API.
// All endpoints are public, no auth. Rate-limited server-side by IP +
// X-FiveM-Server header which we derive from sv_licenseKey.

import { createHash } from "node:crypto";
import { resolveConfig } from "./config";
import { fGetConvar, fPerformHttpRequest } from "./fivem";

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

/**
 * Item shapes must match the contract in `marketplace/API.md` on the website
 * side (v0.6). Timestamps are ISO 8601 strings.
 */
export interface MarketplaceItem {
  id: string;
  slug: string;
  type: string;
  name: string;
  description: string;
  creator_name: string;
  current_version: string;
  size_bytes: number;
  downloads: number;
  created_at: string;
}

export interface MarketplaceItemDetail extends MarketplaceItem {
  creator: { id: string; name: string; avatar: string | null };
  versions: Array<{
    version: string;
    changelog: string;
    size_bytes: number;
    file_hash: string;
    created_at: string;
  }>;
  /** Set by the server when moderation has flagged an item — installer refuses. */
  flagged?: boolean;
}

/** Typed error envelope returned by the website on 4xx/5xx responses. */
export class MarketplaceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfter?: number
  ) {
    super(`${code} (HTTP ${status}${retryAfter ? `, retry after ${retryAfter}s` : ""})`);
  }
}

let cachedServerId: string | null = null;

/** Derive a stable server identifier for rate-limit keying. */
function getServerIdHeader(): string {
  if (cachedServerId) return cachedServerId;
  const license = (fGetConvar("sv_licenseKey", "") || "").trim();
  const hostname = (fGetConvar("sv_hostname", "") || "").trim();
  const fallback = (fGetConvar("sv_projectName", "") || "unknown-server").trim();
  const source = license || `${hostname}|${fallback}`;
  cachedServerId = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return cachedServerId;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-FiveM-Server": getServerIdHeader(),
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

/** Parse a marketplace error response body into a typed error. */
async function toMarketplaceError(resp: Response): Promise<MarketplaceError> {
  let code = `http_${resp.status}`;
  let retryAfter: number | undefined;
  try {
    const body = (await resp.json()) as { error?: string; retry_after?: number };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.retry_after === "number") retryAfter = body.retry_after;
  } catch {
    // non-JSON body — keep the fallback code
  }
  return new MarketplaceError(code, resp.status, retryAfter);
}

export interface ListParams {
  type?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export async function listItems(
  params: ListParams
): Promise<{ items: MarketplaceItem[]; nextCursor: string | null }> {
  const cfg = resolveConfig();
  const qs = new URLSearchParams();
  if (params.type) qs.set("type", params.type);
  if (params.search) qs.set("search", params.search);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const url = `${cfg.apiBase}/items${qs.toString() ? `?${qs}` : ""}`;
  const resp = await fetchWithTimeout(url, buildHeaders(), cfg.installTimeoutMs);
  if (!resp.ok) throw await toMarketplaceError(resp);
  return (await resp.json()) as { items: MarketplaceItem[]; nextCursor: string | null };
}

export async function getItem(slug: string): Promise<MarketplaceItemDetail> {
  const cfg = resolveConfig();
  const url = `${cfg.apiBase}/items/${encodeURIComponent(slug)}`;
  const resp = await fetchWithTimeout(url, buildHeaders(), cfg.installTimeoutMs);
  if (!resp.ok) throw await toMarketplaceError(resp);
  return (await resp.json()) as MarketplaceItemDetail;
}

export interface BundleDownload {
  bytes: Uint8Array;
  /** Lowercase hex sha256 parsed from the `X-Marketplace-File-Hash` header. */
  expectedHash: string;
  /** Size reported by `X-Marketplace-Size-Bytes`, used to sanity-check the body length. */
  expectedSize: number;
  /** Version echoed back by the server — not necessarily the one we asked for. */
  version: string | null;
}

/**
 * Downloads the bundle artifact for a specific version of an item and returns
 * its bytes plus integrity metadata. Caller MUST verify `sha256(bytes)` against
 * `expectedHash` before extracting (installer.ts does this).
 *
 * Hash and size headers are required per the v0.6 contract — their absence
 * indicates either a non-conforming server or a tampered response, so both
 * are hard failures.
 */
export async function downloadBundle(slug: string, version: string): Promise<BundleDownload> {
  const cfg = resolveConfig();
  const qs = new URLSearchParams();
  if (version) qs.set("version", version);
  const url = `${cfg.apiBase}/items/${encodeURIComponent(slug)}/download${qs.toString() ? `?${qs}` : ""}`;
  const resp = await fetchWithTimeout(
    url,
    buildHeaders({ Accept: "application/octet-stream,application/zip" }),
    cfg.installTimeoutMs
  );
  if (!resp.ok) throw await toMarketplaceError(resp);

  // Header lookups are case-insensitive per fetch spec.
  const rawHash = resp.headers.get("x-marketplace-file-hash");
  const rawSize =
    resp.headers.get("x-marketplace-size-bytes") ?? resp.headers.get("content-length");
  if (!rawHash) {
    throw new MarketplaceError("missing_hash_header", resp.status);
  }
  if (!rawSize) {
    throw new MarketplaceError("missing_size_header", resp.status);
  }

  // Contract format: `sha256:<64 lowercase hex>`. Tolerate a bare hex value too
  // in case an older server is in play.
  const expectedHash = rawHash.toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new MarketplaceError("invalid_hash_format", resp.status);
  }
  const expectedSize = Number(rawSize);
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
    throw new MarketplaceError("invalid_size_header", resp.status);
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > cfg.maxBundleBytes) {
    throw new MarketplaceError("bundle_too_large", resp.status);
  }
  return {
    bytes: buf,
    expectedHash,
    expectedSize,
    version: resp.headers.get("x-marketplace-version"),
  };
}
