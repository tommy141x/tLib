/**
 * The one-click install that renders without a resource restart.
 *
 * FiveM builds a client's file manifest when a resource STARTS, so a file written
 * afterwards -- which is what a marketplace install is -- 404s over `nui://`
 * until the next restart. The fill is to let the NUI pull the item from tWeb,
 * extract it in the browser and serve it from `blob:` URLs for the session.
 *
 * THE LOCAL FILE WINS, ALWAYS, and the remote is reached only when the local
 * file is genuinely absent: `acquireBundle` and `acquireFile` HEAD-probe the
 * resource's own NUI file server FIRST. That is structural rather than left to
 * the call site, because a cache that kept preferring the remote copy would turn
 * every installed item into a permanent tWeb dependency and nothing would notice
 * until tWeb went down.
 *
 * It does not persist -- a persisted remote preference is exactly that failure --
 * and it cannot write the file into place: `SaveResourceFile` is false
 * cross-resource, so session-scoped blobs are the whole of what is available.
 */

/** A bundle's extracted contents: normalised relative path → value. */
type FileMap = Map<string, string>;

/**
 * The slice of `fetch` this module uses, and the shape a suite has to supply.
 */
export type FetchLike = (
  input: string,
  init?: { method?: string; signal?: AbortSignal }
) => Promise<Response>;

export interface RuntimeAssetCacheOptions {
  /**
   * Log tag, written as `[<tag>]`. The consumer's own name — these lines are
   * read in F8 next to that resource's other output.
   */
  tag: string;
  /**
   * The local URL prefix the resource itself serves a bundle's files from,
   * INCLUDING the trailing slash. tRadio's NUI document sits at the resource
   * root so it is `/layouts/<key>/`; tELS, tRadar and tDetector serve their
   * bundle from a nested page and use `../../layouts/<key>/`.
   */
  bundleBase: (key: string) => string;
  /**
   * The files whose presence means "the resource serves this bundle itself".
   *
   * The FIRST entry is also the bundle's entry document — the one
   * `bundleDocument` returns. Any later entry is a local-first marker ONLY.
   * Probes are tried IN ORDER and stop at the first that answers, so the
   * common case still costs exactly one HEAD.
   */
  bundleProbe?: string | readonly string[];
  /** The local URL a single standalone file (a sound) is served from. */
  filePath: (filename: string) => string;
  /** Per-file ceiling inside a bundle. */
  maxEntryBytes?: number;
  /** Ceiling on a bundle's total expanded size. */
  maxTotalBytes?: number;
  /** Deadline for one remote request. */
  timeoutMs?: number;
  /** Injected by the suite. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /**
   * Injected by the suite. Defaults to the global `console`.
   *
   * `debug` is OPTIONAL and call sites use `?.`: the suite injects `log`/`warn`
   * only, and a consumer typechecks this file in its own build.
   */
  logger?: Pick<Console, "log" | "warn"> & Partial<Pick<Console, "debug">>;
  /**
   * How a bundle's files are addressed once extracted.
   *
   * `"blob"` (the default) is what you want: one URL per file, no base64
   * inflation, revocable.
   *
   * `"data"` exists for ONE measured constraint: a `blob:` URL belongs to the
   * origin that created it, so a document with an OPAQUE origin -- tELS's
   * `sandbox`ed layout iframe with no `allow-same-origin` -- cannot load one. A
   * `data:` URL carries its bytes and has no origin to check, at 4/3 the size and
   * with nothing to revoke, so lower `maxTotalBytes` to match.
   */
  urlMode?: "blob" | "data";
  /** Injected by the suite — happy-dom has no real blob URLs. */
  objectUrls?: {
    create: (blob: Blob) => string;
    revoke: (url: string) => void;
  };
}

export interface RuntimeAssetCache {
  // bundles (a zip: a layout/skin and its artwork)
  /** Is this bundle being served from a session blob rather than from disk? */
  hasBundle(key: string): boolean;
  /** The `blob:` URL for one file inside a runtime-cached bundle. */
  bundleUrl(key: string, relPath: string): string | null;
  /** The decoded text of one file inside a runtime-cached bundle. */
  bundleText(key: string, relPath: string): string | null;
  /** The in-flight acquisition for this bundle, if one is running. */
  pendingBundle(key: string): Promise<void> | undefined;
  /**
   * Local-first acquisition. Resolves when the bundle is usable — which for a
   * bundle the resource already serves means immediately, with no request to
   * `downloadUrl` at all.
   */
  acquireBundle(key: string, downloadUrl: string): Promise<void>;
  /** Re-attempt a previously registered acquisition that failed. */
  ensureBundle(key: string): Promise<void> | undefined;
  /** Revoke this bundle's blobs and forget both it and its local verdict. */
  evictBundle(key: string): void;
  /**
   * A bundle's entry document, from wherever it actually lives, with its
   * relative `src`/`href` attributes resolved so they load from the page.
   */
  bundleDocument(key: string, signal?: AbortSignal): Promise<string>;
  /** Resolve relative `src`/`href` in `html` against this bundle. */
  rewriteDocument(key: string, html: string): string;

  // standalone files (a sound)
  /** The `blob:` URL for a runtime-cached file, by the name it is played under. */
  fileUrl(filename: string): string | null;
  /**
   * Local-first acquisition of one file. `probeAs` is the name HEAD-probed on
   * the local file server when it differs from the cache key — a marketplace
   * sound is played under its catalogue filename but keyed by slug.
   */
  acquireFile(filename: string, downloadUrl: string, probeAs?: string): Promise<void>;
  /** Revoke a file's blob, forget it, and clear its recorded failure. */
  evictFile(filename: string): void;
  /**
   * Replay a whole installed-sound list, downloading only the entries the
   * resource cannot serve.
   *
   * The install broadcast reaches whoever is connected at install time and is
   * never replayed, so without this a custom sound worked for the admin who
   * installed it and for nobody else. Fire-and-forget by design: a failure
   * leaves no blob registered and the consumer's resolver falls through to the
   * plain local path.
   */
  syncFiles(
    entries: ReadonlyArray<{ slug?: string; filename?: string; localOnly?: boolean }>,
    baseUrl: unknown,
    onReady?: (filename: string, blobUrl: string) => void
  ): void;
}

/**
 * Where one marketplace item's payload is downloaded from.
 *
 * ONE definition of this path, for the same reason the default host has one per
 * language: four NUI bundles and `cl_bridge.lua` were each about to build it.
 * The base arrives from Lua (`tlib.marketplace.baseUrl()`, which reads the
 * `tlib_api_base_url` convar on every call) rather than being a constant
 * here, so a server pointed at a dev worker follows.
 */
export function marketplaceItemUrl(baseUrl: unknown, slug: string): string | null {
  if (typeof baseUrl !== "string") return null;
  const base = baseUrl.replace(/\/+$/, "");
  if (!base || !slug) return null;
  return `${base}/api/v1/items/${slug}/download`;
}

const DEFAULT_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Lower-cased, forward-slashed, leading slash stripped. The one key shape. */
function normalise(relPath: string): string {
  return relPath.toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
}

const MIME_BY_EXT: Record<string, string> = {
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

function mimeFor(norm: string): string {
  return MIME_BY_EXT[(norm.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
}

/** Extensions decoded to text as well as blobbed, because a consumer reads them. */
const TEXT_EXTS = new Set(["html", "htm", "json", "css", "js", "svg"]);

/**
 * Relative `src`/`href` only: an absolute URL, a protocol-relative one, a
 * root-relative one, a `../` and a fragment are all left exactly as authored.
 */
const RELATIVE_ASSET_ATTR =
  /\b(src|href)=["']((?!https?:\/\/|\/\/|\/|\.\.\/|#|data:|blob:)[^"']*?)["']/gi;

/**
 * A fetch deadline that does not assume `AbortSignal.timeout` exists.
 *
 * `AbortSignal.timeout()` shipped in Chromium **103**, which is exactly the CEF
 * milestone FiveM runs — so it works today with zero version margin. On
 * anything older it is `undefined`, and calling it throws a synchronous
 * `TypeError` that rejects the download before the request is made: a customer
 * on an older client would lose every runtime asset with no useful error.
 * `AbortController` + `setTimeout` is universally available, so this costs one
 * branch and removes the cliff. Mirrors `createDeadline` in `@tlib/shared/nui`
 * rather than inventing a second pattern.
 */
function fetchDeadline(ms: number): { signal: AbortSignal; release: () => void } {
  const nativeTimeout = (AbortSignal as { timeout?: (delay: number) => AbortSignal }).timeout;
  if (typeof nativeTimeout === "function") {
    return { signal: nativeTimeout(ms), release: () => {} };
  }
  const controller = new AbortController();
  const handle = setTimeout(
    () => controller.abort(new DOMException("timeout", "TimeoutError")),
    ms
  );
  return { signal: controller.signal, release: () => clearTimeout(handle) };
}

export function createRuntimeAssetCache(options: RuntimeAssetCacheOptions): RuntimeAssetCache {
  const {
    tag,
    bundleBase,
    bundleProbe: bundleProbeOption = ["ui.html", "module.json"],
    filePath,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    urlMode = "blob",
  } = options;

  const bundleProbes: readonly string[] =
    typeof bundleProbeOption === "string" ? [bundleProbeOption] : bundleProbeOption;
  /** The entry document: the first probe, which is the file consumers load. */
  const bundleEntry = bundleProbes[0] as string;

  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const log = options.logger ?? console;
  const urls = options.objectUrls ?? {
    create: (blob: Blob) => URL.createObjectURL(blob),
    revoke: (url: string) => URL.revokeObjectURL(url),
  };

  /**
   * One extracted file's address.
   *
   * `data:` is built here rather than through the injected `objectUrls`,
   * because it is not an object URL at all: there is nothing to register and
   * nothing to revoke, and routing it through a create/revoke pair would
   * invite a future reader to "fix" the missing revoke.
   */
  function addressFor(bytes: Uint8Array, mime: string): string {
    if (urlMode === "blob") {
      return urls.create(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    }
    let binary = "";
    // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte asset blows
    // the argument limit and throws RangeError rather than returning anything.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  }

  const bundleBlobs = new Map<string, FileMap>();
  const bundleTexts = new Map<string, FileMap>();
  const bundlePending = new Map<string, Promise<void>>();
  /** key → download URL, kept so a failed acquisition can be retried. */
  const bundleUrls = new Map<string, string>();
  /**
   * Keys the local file server answered for. The memo matters because
   * `ensureBundle` is called on every load of a bundle: without it a bundle
   * served from disk costs one HEAD per load forever.
   */
  const bundleLocal = new Set<string>();
  /**
   * Bumped on eviction so an acquisition that completes AFTER its bundle was
   * evicted discards its result instead of reinstating stale data.
   */
  const bundleGenerations = new Map<string, number>();

  const fileBlobs = new Map<string, string>();
  const filePending = new Map<string, Promise<void>>();
  const fileLocal = new Set<string>();
  /**
   * Names whose remote fetch already failed. Without this a permanent miss -- a
   * sound with no marketplace item behind it -- is retried on every config
   * refresh, which gave a server with a folder of local files a wall of warnings
   * every push. Cleared per name by `evictFile`, so a later install is seen.
   */
  const fileFailures = new Set<string>();

  /**
   * Is this path in the resource's own file manifest?
   *
   * `HEAD` is measured to work on the NUI file server: 200 with a
   * Content-Length for a file in the manifest, 404 for one that is not.
   *
   * Only a **404** counts as absent, and a network error counts as SERVED.
   * Both lean the same way on purpose. This gates a tWeb fallback, and the
   * failure to avoid is downloading files the client can already read — so
   * anything short of the file server positively saying "no such file" leaves
   * us local. The consumer's own loader then tries the same local path, which
   * is where a genuine miss surfaces, instead of it becoming a silent
   * permanent remote dependency for every asset on the server.
   */
  async function servedByResource(path: string): Promise<boolean> {
    try {
      const resp = await doFetch(path, { method: "HEAD" });
      return resp.status !== 404;
    } catch {
      return true;
    }
  }

  /** No-op in `data` mode: a data: URL holds its own bytes and has no registry. */
  function revokeAll(map: FileMap): void {
    if (urlMode !== "blob") return;
    for (const url of map.values()) urls.revoke(url);
  }

  function evictBundle(key: string): void {
    bundleLocal.delete(key);
    bundleUrls.delete(key);
    const fileMap = bundleBlobs.get(key);
    bundleBlobs.delete(key);
    bundleTexts.delete(key);
    // Bumped even when nothing was cached: an acquisition may be in flight.
    bundleGenerations.set(key, (bundleGenerations.get(key) ?? 0) + 1);
    if (!fileMap) return;
    revokeAll(fileMap);
  }

  async function extractBundle(key: string, downloadUrl: string, gen: number): Promise<void> {
    log.log(`[${tag}] runtime bundle: fetching "${key}" from ${downloadUrl}`);
    const deadline = fetchDeadline(timeoutMs);
    let resp: Response;
    try {
      resp = await doFetch(downloadUrl, { signal: deadline.signal });
    } finally {
      deadline.release();
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());

    if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
      const magic = [...buf.slice(0, 4)].map((b) => b.toString(16)).join(" ");
      throw new Error(`not a zip bundle (magic: ${magic})`);
    }

    // Async unzip so a large bundle does not block the render thread.
    const { unzip } = await import("fflate");
    const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
    });

    const blobs: FileMap = new Map();
    const texts: FileMap = new Map();
    const decoder = new TextDecoder();
    const prefix = `${key.toLowerCase()}/`;
    let totalBytes = 0;
    try {
      for (const [name, data] of Object.entries(extracted)) {
        let norm = normalise(name);
        // tLib's installer rejects these outright, so reaching one here means
        // the bundle did not come through it. Skip rather than trust it.
        if (norm.includes("..")) {
          log.warn(`[${tag}] skipping unsafe bundle entry "${name}"`);
          continue;
        }
        if (norm.startsWith(prefix)) norm = norm.slice(prefix.length);
        if (!norm || norm.endsWith("/")) continue;
        if (data.length > maxEntryBytes) {
          log.warn(`[${tag}] skipping oversized entry "${name}" (${data.length} bytes)`);
          continue;
        }
        totalBytes += data.length;
        if (totalBytes > maxTotalBytes) {
          log.warn(`[${tag}] bundle "${key}" exceeds the expanded ceiling — truncating`);
          break;
        }
        blobs.set(norm, addressFor(data, mimeFor(norm)));
        if (TEXT_EXTS.has((norm.split(".").pop() ?? "").toLowerCase())) {
          texts.set(norm, decoder.decode(data));
        }
      }
    } catch (err) {
      revokeAll(blobs);
      throw err;
    }

    if ((bundleGenerations.get(key) ?? 0) !== gen) {
      revokeAll(blobs);
      log.log(`[${tag}] runtime bundle: discarding stale download for "${key}"`);
      return;
    }
    // Revoke any prior blobs before replacing — a reinstall within a session.
    evictBundle(key);
    bundleBlobs.set(key, blobs);
    bundleTexts.set(key, texts);
    bundleUrls.set(key, downloadUrl);
    // evictBundle bumped the generation; this acquisition is the live one.
    bundleGenerations.set(key, gen);
    log.log(`[${tag}] runtime bundle: cached ${blobs.size} files for "${key}"`);
  }

  function acquireBundle(key: string, downloadUrl: string): Promise<void> {
    // Kept even when the acquisition fails, so ensureBundle can retry.
    bundleUrls.set(key, downloadUrl);
    if (bundleLocal.has(key) || bundleBlobs.has(key)) return Promise.resolve();
    const existing = bundlePending.get(key);
    if (existing) return existing;

    const gen = bundleGenerations.get(key) ?? 0;

    async function run(): Promise<void> {
      // THE LOCAL-FIRST GATE. Do not move this below the fetch.
      for (const probe of bundleProbes) {
        if (!(await servedByResource(bundleBase(key) + probe))) continue;
        bundleLocal.add(key);
        // Debug, because this is the ordinary outcome: it printed once per layout
        // on every boot, announcing that nothing had been downloaded. Downloads
        // and failures still log.
        log.debug?.(
          `[${tag}] runtime bundle: "${key}" is served by the resource (${probe}) — not downloading`
        );
        return;
      }
      for (let attemptsLeft = 1; ; attemptsLeft--) {
        try {
          await extractBundle(key, downloadUrl, gen);
          return;
        } catch (err) {
          if (attemptsLeft > 0) {
            log.warn(`[${tag}] bundle download failed for "${key}", retrying in 3s:`, err);
            await new Promise<void>((r) => setTimeout(r, 3000));
            continue;
          }
          // Never rethrown: callers await this to know the asset is as ready as
          // it is going to get, and must proceed to their local fallback.
          log.warn(`[${tag}] bundle download permanently failed for "${key}":`, err);
          return;
        }
      }
    }

    const p = run().finally(() => bundlePending.delete(key));
    bundlePending.set(key, p);
    return p;
  }

  function rewriteDocument(key: string, html: string): string {
    const base = bundleBase(key);
    const blobs = bundleBlobs.get(key);
    return html.replace(RELATIVE_ASSET_ATTR, (_, attr: string, path: string) => {
      const clean = path.replace(/^\.\//, "");
      // A runtime bundle's files are not on the file server at all, so a
      // relative path has to become its blob. A path the zip does not contain
      // falls back to the local base: it is broken either way, and the local
      // URL is the one that produces a diagnosable 404 rather than silence.
      const blob = blobs?.get(normalise(clean));
      return `${attr}="${blob ?? base + clean}"`;
    });
  }

  async function bundleDocument(key: string, signal?: AbortSignal): Promise<string> {
    const runtimeText = bundleTexts.get(key)?.get(normalise(bundleEntry));
    if (runtimeText !== undefined) return rewriteDocument(key, runtimeText);
    // Cache-busted because a reinstall replaces the file under the same URL and
    // CEF will otherwise serve the copy it read before the install.
    const resp = await doFetch(`${bundleBase(key)}${bundleEntry}?_=${Date.now()}`, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return rewriteDocument(key, await resp.text());
  }

  async function fetchFile(filename: string, downloadUrl: string): Promise<void> {
    const deadline = fetchDeadline(timeoutMs);
    let resp: Response;
    try {
      resp = await doFetch(downloadUrl, { signal: deadline.signal });
    } finally {
      deadline.release();
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const old = fileBlobs.get(filename);
    if (old && urlMode === "blob") urls.revoke(old);
    fileBlobs.set(filename, addressFor(new Uint8Array(buf), mimeFor(filename)));
  }

  function acquireFile(filename: string, downloadUrl: string, probeAs?: string): Promise<void> {
    const key = filename.toLowerCase();
    if (fileLocal.has(key) || fileBlobs.has(key) || fileFailures.has(key)) {
      return Promise.resolve();
    }
    const existing = filePending.get(key);
    if (existing) return existing;

    async function run(): Promise<void> {
      // THE LOCAL-FIRST GATE. Do not move this below the fetch.
      if (await servedByResource(filePath(probeAs ?? filename))) {
        fileLocal.add(key);
        return;
      }
      try {
        await fetchFile(key, downloadUrl);
      } catch (err) {
        fileFailures.add(key);
        log.warn(`[${tag}] runtime file cache failed for "${filename}":`, err);
      }
    }

    const p = run().finally(() => filePending.delete(key));
    filePending.set(key, p);
    return p;
  }

  return {
    hasBundle: (key) => bundleBlobs.has(key),
    bundleUrl: (key, relPath) => bundleBlobs.get(key)?.get(normalise(relPath)) ?? null,
    bundleText: (key, relPath) => bundleTexts.get(key)?.get(normalise(relPath)) ?? null,
    pendingBundle: (key) => bundlePending.get(key),
    acquireBundle,
    ensureBundle(key) {
      if (bundleLocal.has(key) || bundleBlobs.has(key)) return undefined;
      const pending = bundlePending.get(key);
      if (pending) return pending;
      const url = bundleUrls.get(key);
      if (!url) return undefined;
      return acquireBundle(key, url);
    },
    evictBundle,
    bundleDocument,
    rewriteDocument,

    fileUrl: (filename) => fileBlobs.get(filename.toLowerCase()) ?? null,
    acquireFile,
    evictFile(filename) {
      const key = filename.toLowerCase();
      const url = fileBlobs.get(key);
      if (url && urlMode === "blob") urls.revoke(url);
      fileBlobs.delete(key);
      fileLocal.delete(key);
      fileFailures.delete(key);
    },
    syncFiles(entries, baseUrl, onReady) {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const base = typeof baseUrl === "string" ? baseUrl : "";
      if (!base) return;
      for (const entry of entries) {
        const slug = entry?.slug;
        if (!slug) continue;
        // Seeded from the tone map or auto-discovered on disk — there is no
        // marketplace item behind it, so asking for one only produces a 404.
        if (entry.localOnly) continue;
        const downloadUrl = marketplaceItemUrl(base, slug);
        if (!downloadUrl) continue;
        // An entry's played filename is not always `<slug>.<ext>`, and the
        // probe has to use the name the consumer will look the blob up by.
        const filename = entry?.filename || `${slug}.wav`;
        void acquireFile(filename, downloadUrl, filename).then(() => {
          const blobUrl = fileBlobs.get(filename.toLowerCase());
          if (blobUrl && onReady) onReady(filename, blobUrl);
        });
      }
    },
  };
}
