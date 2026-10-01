/**
 * Make sure a resource's pinned assets are on disk, fetching only what is
 * actually needed this boot.
 *
 * Shipped as build-time source, not a tLib runtime export. Consumers compile it
 * into their own server bundle through the `@tlib/shared` alias. Streaming
 * byte-level progress across FiveM's export boundary is exactly the kind of
 * thing that does not survive the trip; in-process there is no trip, and tLib's
 * runtime export surface does not grow to accommodate one product's download.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type FetchOptions, type FetchProgress, fetchAsset, hashFile } from "./fetch.ts";
import {
  type AssetMarker,
  type PinnedAsset,
  assertSafeDest,
  markerVouchesFor,
  parseMarker,
} from "./pinned.ts";

export * from "./fetch.ts";
export * from "./pinned.ts";

/** What happened to one asset, for logging and for deciding whether a feature may start. */
export interface AssetOutcome {
  id: string;
  dest: string;
  /**
   * `present`  - a marker vouched for it; nothing was read or fetched.
   * `verified` - it was on disk unvouched, hashed, and matched.
   * `fetched`  - downloaded this boot.
   * `failed`   - not usable; `error` says why.
   */
  status: "present" | "verified" | "fetched" | "failed";
  error?: Error;
}

export interface EnsureReport {
  outcomes: AssetOutcome[];
  /** True when every requested asset is usable. The only thing most callers need. */
  ok: boolean;
  /** Bytes actually transferred, which is 0 on a warm restart. */
  bytesFetched: number;
}

export interface EnsureOptions extends FetchOptions {
  /**
   * Called as each asset changes phase, in addition to byte-level `onProgress`.
   * Separate because a console wants one line per asset, not one per chunk.
   */
  onAsset?: (outcome: AssetOutcome, index: number, total: number) => void;
}

const markerPath = (absoluteDest: string): string => `${absoluteDest}.pin.json`;

/**
 * Read the marker beside a file, if there is a readable one.
 *
 * `node:fs/promises`, not `Bun.file`: this module is compiled into a consumer's
 * SERVER bundle and runs inside FiveM's Node-based JS runtime, where `Bun` does
 * not exist. A `Bun.*` call there is a synchronous `ReferenceError` thrown from
 * an async function -- a rejection, not a caught read failure -- which escaped
 * `ensureAssets` entirely and broke its "never throws for a fetch failure"
 * contract. The rest of this subsystem is deliberately node-only for the same
 * reason; keep it that way.
 */
async function readMarker(absoluteDest: string): Promise<AssetMarker | undefined> {
  const raw = await readFile(markerPath(absoluteDest), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : parseMarker(raw);
}

/**
 * Record that this exact file has already been checked against this exact pin.
 *
 * Written after the fact, from the file's real mtime, so the marker describes
 * what is on disk rather than what was intended to be.
 */
async function writeMarker(absoluteDest: string, asset: PinnedAsset): Promise<void> {
  const s = await stat(absoluteDest);
  const marker: AssetMarker = { sha256: asset.sha256, bytes: s.size, mtimeMs: s.mtimeMs };
  await writeFile(markerPath(absoluteDest), JSON.stringify(marker));
}

/**
 * Bring `assets` into existence under `root`, verified.
 *
 * Sequential on purpose. These are large files on a machine that is also running
 * a game server: three concurrent multi-gigabyte downloads would compete for the
 * same uplink to finish no sooner, while making the progress output unreadable
 * and tripling peak disk churn.
 *
 * Never throws for a fetch failure -- a failed asset becomes a `failed` outcome
 * and the caller decides what that means. One product here treats a missing
 * model as a feature being unavailable; another treats it as not being ready at
 * all. That policy is not tLib's to make.
 */
export async function ensureAssets(
  root: string,
  assets: readonly PinnedAsset[],
  options: EnsureOptions = {}
): Promise<EnsureReport> {
  if (!isAbsolute(root)) throw new Error("ensureAssets requires an absolute resource root");
  const outcomes: AssetOutcome[] = [];
  let bytesFetched = 0;

  for (const [index, asset] of assets.entries()) {
    const absoluteDest = join(root, assertSafeDest(asset.dest));
    const record = (status: AssetOutcome["status"], error?: Error): void => {
      const outcome: AssetOutcome = { id: asset.id, dest: asset.dest, status, error };
      outcomes.push(outcome);
      options.onAsset?.(outcome, index, assets.length);
    };

    options.onProgress?.({ id: asset.id, received: 0, size: asset.bytes, phase: "checking" });

    const existing = await stat(absoluteDest).catch(() => undefined);
    if (existing?.isFile()) {
      if (markerVouchesFor(await readMarker(absoluteDest), asset, existing)) {
        record("present");
        continue;
      }
      // On disk but unvouched: it may be a release that shipped the file, or a
      // marker lost to a copy. Hashing costs a minute once; re-fetching costs
      // gigabytes. Hash first, and only fall through to a download if it is
      // genuinely the wrong file.
      if (existing.size === asset.bytes) {
        options.onProgress?.({
          id: asset.id,
          received: existing.size,
          size: asset.bytes,
          phase: "verifying",
        });
        const digest = await hashFile(absoluteDest).catch(() => "");
        if (digest === asset.sha256) {
          await writeMarker(absoluteDest, asset).catch(() => {});
          record("verified");
          continue;
        }
      }
    }

    try {
      await fetchAsset(asset, absoluteDest, options);
      bytesFetched += asset.bytes;
      await writeMarker(absoluteDest, asset).catch(() => {});
      record("fetched");
    } catch (error) {
      record("failed", error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { outcomes, ok: outcomes.every((o) => o.status !== "failed"), bytesFetched };
}

export type { FetchProgress };
