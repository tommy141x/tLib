/**
 * One pinned file, streamed to disk and verified against its sha256.
 *
 * Why this is not `shared/ts/marketplace/download.ts`, which already does
 * pinned HTTP with a hash check -- three differences, each load-bearing:
 *
 *   1. That module collects the body into memory (`Buffer.concat` at its end)
 *      and returns a Buffer. The files here reach 2.4 GB. This one never holds
 *      more than one chunk, hashing as it writes.
 *   2. That module reports no progress. A multi-gigabyte download with no
 *      output is indistinguishable, to the operator watching, from a hang --
 *      which is the entire problem this subsystem exists to solve.
 *   3. That module cannot resume. A 2.4 GB transfer that restarts from zero on
 *      a dropped connection never finishes on a domestic uplink.
 *
 * It is also not `tRadio/scripts/vendor-local-engine.ts`, whose `fetchPinned`
 * does `await response.arrayBuffer()`. That runs on a developer box with the RAM
 * to spare; a customer's game server is not that.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { dirname } from "node:path";
import type { PinnedAsset } from "./pinned.ts";

/**
 * Origins a pinned URL may START at.
 *
 * Checked on the starting URL only, and redirects are then followed wherever
 * they lead. That is not an oversight -- it is required. Every weight pinned
 * today is a `huggingface.co/.../resolve/main/...` URL, and HuggingFace answers
 * those with a 302 to `cdn-lfs*.hf.co`; GitHub releases redirect to
 * `objects.githubusercontent.com`. Re-checking each hop against this set would
 * reject every download the product actually makes.
 *
 * So this list is not the integrity boundary and must not be mistaken for it.
 * It catches a lockfile edited to point somewhere else, early and by name.
 * **The sha256 pin is what makes the bytes trustworthy** -- a redirect to
 * anything serving different content fails verification and is discarded.
 */
export const DEFAULT_ORIGINS = ["https://github.com", "https://huggingface.co"];

/** Enough to clear HuggingFace's resolve -> CDN hop several times over. */
const MAX_REDIRECTS = 8;

export interface FetchProgress {
  id: string;
  /** Bytes of THIS asset on disk, including anything resumed. */
  received: number;
  /** Expected total for this asset. */
  size: number;
  phase: "checking" | "downloading" | "verifying" | "done";
}

export interface FetchOptions {
  onProgress?: (p: FetchProgress) => void;
  allowOrigins?: readonly string[];
  signal?: AbortSignal;
  /** Idle timeout: how long a stream may deliver nothing before it is abandoned. */
  stallMs?: number;
}

/** Thrown for anything the caller may sensibly retry; carries the asset id. */
export class AssetFetchError extends Error {
  constructor(
    readonly assetId: string,
    message: string
  ) {
    super(message);
    this.name = "AssetFetchError";
  }
}

function assertAllowedOrigin(url: string, allow: readonly string[], id: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AssetFetchError(id, `asset ${id} has an unparseable url`);
  }
  if (parsed.username || parsed.password)
    throw new AssetFetchError(id, `asset ${id} url must not carry credentials`);
  if (!allow.includes(parsed.origin))
    throw new AssetFetchError(id, `asset ${id} url origin is not allowed: ${parsed.origin}`);
  return parsed;
}

/**
 * GET with redirects followed manually.
 *
 * `node:https` does not follow them, and the marketplace downloader treats any
 * non-2xx as failure -- correct there, fatal here, since the very first response
 * from HuggingFace is a 302.
 */
function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  redirectsLeft: number
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      reject(new Error(`unsupported protocol: ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(parsed, { headers, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain, or the socket is never released
        if (redirectsLeft <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        // Range is deliberately carried across the hop: dropping it would make a
        // resumed request silently restart from byte 0 at the CDN.
        request(next, headers, signal, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

/**
 * Ensure one asset exists at `absoluteDest`, verified.
 *
 * Downloads to `<dest>.part` and renames only once the digest matches, so an
 * interrupted run can never leave a truncated file sitting where a complete one
 * is expected -- the failure that would otherwise surface as an unreadable model
 * hours later, with nothing pointing back here.
 */
export async function fetchAsset(
  asset: PinnedAsset,
  absoluteDest: string,
  options: FetchOptions = {}
): Promise<void> {
  const { onProgress, signal, stallMs = 120_000 } = options;
  const allow = options.allowOrigins ?? DEFAULT_ORIGINS;
  assertAllowedOrigin(asset.url, allow, asset.id);

  const part = `${absoluteDest}.part`;
  await mkdir(dirname(absoluteDest), { recursive: true });

  const hash = createHash("sha256");
  let resumeFrom = 0;

  // A surviving .part is replayed through the hash rather than discarded. This
  // reads the partial file once (fast, local) to avoid re-downloading it (slow,
  // metered). If it is somehow longer than the pinned size it is junk from a
  // different pin -- start over rather than try to reconcile it.
  const existing = await stat(part).catch(() => undefined);
  if (existing?.isFile() && existing.size > 0 && existing.size < asset.bytes) {
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(part);
      rs.on("data", (c) => hash.update(c));
      rs.on("error", reject);
      rs.on("end", resolve);
    });
    resumeFrom = existing.size;
  } else if (existing) {
    await rm(part, { force: true });
  }

  onProgress?.({ id: asset.id, received: resumeFrom, size: asset.bytes, phase: "downloading" });

  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  const res = await request(asset.url, headers, signal, MAX_REDIRECTS).catch((e: Error) => {
    throw new AssetFetchError(asset.id, `${asset.id}: ${e.message}`);
  });

  // A server that ignores Range answers 200 with the whole body. Honour that
  // rather than appending a full copy onto a partial one, which would produce a
  // file of the right-ish size and the wrong contents.
  if (resumeFrom > 0 && res.statusCode === 200) {
    hash.destroy?.();
    res.destroy();
    await rm(part, { force: true });
    return fetchAsset(asset, absoluteDest, options);
  }

  let received = resumeFrom;
  const sink = createWriteStream(part, { flags: resumeFrom > 0 ? "a" : "w" });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.destroy();
      // `sink.end`, never `sink.destroy`. Destroying discards whatever is still
      // buffered, so a dropped connection would leave a .part shorter than the
      // bytes we actually received -- or empty. Resume exists precisely for this
      // path, and silently throwing the prefix away would defeat it while still
      // looking like it worked.
      sink.end(() => reject(new AssetFetchError(asset.id, `${asset.id}: ${error.message}`)));
    };
    // Idle timeout, not an absolute deadline: a legitimate 2.4 GB transfer on a
    // slow line can run for an hour, and killing it at a fixed wall-clock limit
    // would make the large downloads the ones that can never succeed.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error("stalled")), stallMs);
    };
    arm();
    const onAbort = () => fail(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });

    res.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      // Cap mid-stream. The pin states the size, so a body that outgrows it is
      // wrong no matter what its hash turns out to be, and there is no reason to
      // keep writing it to a customer's disk to find that out.
      if (received > asset.bytes) {
        fail(new Error(`body exceeds pinned size (${asset.bytes} bytes)`));
        return;
      }
      hash.update(chunk);
      arm();
      if (!sink.write(chunk)) {
        res.pause();
        sink.once("drain", () => res.resume());
      }
      onProgress?.({ id: asset.id, received, size: asset.bytes, phase: "downloading" });
    });
    res.on("error", fail);
    res.on("aborted", () => fail(new Error("connection aborted")));
    res.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sink.end(resolve);
    });
  });

  if (received !== asset.bytes) {
    // Leave the .part in place: it is a valid prefix and the next attempt resumes
    // from it. Deleting it here is what turns a flaky connection into a download
    // that can never complete.
    throw new AssetFetchError(
      asset.id,
      `${asset.id}: incomplete (${received} of ${asset.bytes} bytes)`
    );
  }

  onProgress?.({ id: asset.id, received, size: asset.bytes, phase: "verifying" });
  const digest = hash.digest("hex");
  if (digest !== asset.sha256) {
    // Here the .part IS discarded. A hash mismatch means the bytes are wrong,
    // not merely incomplete, and resuming from them would fail forever.
    await rm(part, { force: true });
    throw new AssetFetchError(
      asset.id,
      `${asset.id}: sha256 mismatch\n  expected ${asset.sha256}\n  got      ${digest}`
    );
  }

  await rename(part, absoluteDest);
  onProgress?.({ id: asset.id, received, size: asset.bytes, phase: "done" });
}

/** Hash a file already on disk, for when no marker vouches for it. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const stream = handle.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c) => hash.update(c));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
