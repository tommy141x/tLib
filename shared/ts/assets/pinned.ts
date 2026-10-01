/**
 * Pinned-asset bookkeeping: what a product declares, what is already on disk,
 * and which of it this boot actually needs.
 *
 * Deliberately pure and model-agnostic, the way `server/lib/inference/registry.ts`
 * is. Nothing here knows what a GGUF is, that the caller is a radio, or that a
 * "capability" means text/speech/transcription. tLib fetches pinned bytes and
 * verifies them; the product owns the lockfile and the meaning of its labels.
 *
 * No I/O lives in this file so the decisions can be tested without a network or
 * a filesystem -- and the decisions are the part that goes wrong.
 */

/** One immutable file a product needs on disk before a feature can work. */
export interface PinnedAsset {
  /** Stable label, used in logs and to resume a partial download. */
  id: string;
  /** Destination, relative to the consuming resource's root. Forward slashes. */
  dest: string;
  url: string;
  /** Lowercase hex sha256. This, not the origin allowlist, is the integrity guarantee. */
  sha256: string;
  /** Expected size. Required: without it there is no percentage and no cap to enforce mid-stream. */
  bytes: number;
  /**
   * Which product feature needs this file. Opaque to tLib -- it is matched by
   * string equality against whatever the caller asks for.
   *
   * Absent means unconditional: always needed, whatever is configured.
   */
  capability?: string;
}

/** Recorded next to a verified file so a 2.4 GB re-hash is not the price of a restart. */
export interface AssetMarker {
  sha256: string;
  bytes: number;
  /** Epoch millis. Detects an edit that happens to preserve the size. */
  mtimeMs: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A resource-relative path that cannot escape the resource.
 *
 * `dest` arrives from a lockfile that now ships to machines we do not control,
 * so it is untrusted input, not a constant. An absolute path or a `..` segment
 * would let an edited lockfile write anywhere the server process can reach.
 * Rejecting backslashes too: on Windows `..\\..\\x` escapes just as well and
 * would sail past a check that only knew about `/`.
 */
export function assertSafeDest(dest: string): string {
  if (!dest || dest !== dest.trim()) throw new Error(`invalid asset destination: ${dest}`);
  if (dest.includes("\\")) throw new Error(`asset destination must use '/': ${dest}`);
  if (dest.startsWith("/") || /^[a-zA-Z]:/.test(dest))
    throw new Error(`asset destination must be relative: ${dest}`);
  const parts = dest.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    throw new Error(`asset destination must not contain '.' or '..': ${dest}`);
  return dest;
}

/** Validate one entry, failing loudly rather than fetching something half-specified. */
export function parseAsset(raw: unknown): PinnedAsset {
  if (typeof raw !== "object" || raw === null) throw new Error("asset entry is not an object");
  const o = raw as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== "string" || !id) throw new Error("asset entry is missing 'id'");
  const dest = o.dest;
  if (typeof dest !== "string") throw new Error(`asset ${id} is missing 'dest'`);
  const url = o.url;
  if (typeof url !== "string") throw new Error(`asset ${id} is missing 'url'`);
  const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
  if (!SHA256.test(sha256)) throw new Error(`asset ${id} has no valid sha256`);
  const bytes = o.bytes;
  // A missing size is rejected rather than defaulted to 0. Zero would read as
  // "unknown" everywhere downstream and silently disable the mid-stream cap.
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(`asset ${id} has no valid 'bytes'`);
  const capability = o.capability;
  if (capability !== undefined && (typeof capability !== "string" || !capability))
    throw new Error(`asset ${id} has an invalid 'capability'`);
  return { id, dest: assertSafeDest(dest), url, sha256, bytes, capability };
}

/**
 * The assets needed when exactly `capabilities` are served locally.
 *
 * The caller passes its RESOLVED plan, never its declared configuration. A
 * capability configured for a hosted provider whose API key is absent falls
 * back to local; selecting on the raw configuration would skip that download and
 * then fall back onto weights that are not there.
 */
export function selectAssets(
  assets: readonly PinnedAsset[],
  capabilities: Iterable<string>
): PinnedAsset[] {
  const wanted = new Set(capabilities);
  return assets.filter((a) => a.capability === undefined || wanted.has(a.capability));
}

/** Total bytes, for a progress denominator and for telling an operator what they are in for. */
export function totalBytes(assets: readonly PinnedAsset[]): number {
  return assets.reduce((sum, a) => sum + a.bytes, 0);
}

/** Human-readable size. Logs go to a server console, where `2559115264` means nothing. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Whether a marker vouches for what is on disk right now.
 *
 * Size and mtime are compared, not content. Re-hashing a multi-gigabyte file at
 * every boot costs a minute of startup to learn something the last boot already
 * established -- the same argument `tRadio/server/lib/ai/local-engine.ts` makes
 * for reading `artifacts.json` instead of hashing. This is a cache-validity
 * check, not a security check: the marker only ever confirms work already done
 * against the pin, and any mismatch falls back to a real hash.
 */
export function markerVouchesFor(
  marker: AssetMarker | undefined,
  asset: PinnedAsset,
  stat: { size: number; mtimeMs: number } | undefined
): boolean {
  if (!marker || !stat) return false;
  if (marker.sha256 !== asset.sha256) return false;
  if (marker.bytes !== asset.bytes || stat.size !== asset.bytes) return false;
  // Filesystems vary in mtime precision; compare at whole milliseconds.
  return Math.floor(marker.mtimeMs) === Math.floor(stat.mtimeMs);
}

export function parseMarker(raw: string): AssetMarker | undefined {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.sha256 !== "string" || typeof o.bytes !== "number") return undefined;
    if (typeof o.mtimeMs !== "number") return undefined;
    return { sha256: o.sha256.toLowerCase(), bytes: o.bytes, mtimeMs: o.mtimeMs };
  } catch {
    return undefined;
  }
}
