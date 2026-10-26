/**
 * Request/reply wrapper around the server-side marketplace browse. Not a `fetch`: CEF's
 * origin here is `cfx-nui-tLib` and the marketplace sends no `Access-Control-Allow-Origin`,
 * so the browser would refuse the body. The request goes NUI -> Lua -> tLib's Node bundle,
 * where the resource secret can legitimately live. Correlated by request ID, not a
 * `fetchNui` return value, since a NUI callback must answer within a frame while a
 * marketplace round trip is an outbound HTTP request — `fetchNui` is fire-and-forget and the
 * answer arrives as an event.
 */

import { fetchNui, onNuiEvent } from "../../nui";
import { type PanelThemeDefinition, parsePanelThemeDefinition } from "./preview-frame";
import type { MarketplaceItem } from "./types";

export interface BrowseParams {
  /** Product scope, e.g. `tDetector`. Omitted browses the whole catalogue. */
  resource?: string;
  /** `ui`, `sound` or `theme`. */
  type?: string;
  search?: string;
  cursor?: number;
  limit?: number;
  sort?: "downloads" | "created_at";
}

export interface BrowsePage {
  items: MarketplaceItem[];
  total: number;
  nextCursor: number;
  hasMore: boolean;
}

interface BrowseReply {
  requestId?: string;
  ok?: boolean;
  error?: string;
  items?: MarketplaceItem[];
  total?: number;
  nextCursor?: number;
  hasMore?: boolean;
}

/**
 * Longer than the server's own 20s backstop, so a real answer always wins the
 * race and this only fires when nothing came back at all.
 */
const REPLY_TIMEOUT_MS = 25_000;

interface Pending {
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  /**
   * Turns a loose wire payload into the shape this caller asked for, and
   * throws if the reply claims success but is not usable.
   */
  read: (reply: never) => unknown;
  timer: number;
}

const pending = new Map<string, Pending>();
const listening = new Set<string>();
let sequence = 0;

function ensureListener(event: string): void {
  if (listening.has(event)) return;
  listening.add(event);
  onNuiEvent<{ requestId?: string; ok?: boolean; error?: string }>(event, (reply) => {
    const id = typeof reply?.requestId === "string" ? reply.requestId : "";
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    window.clearTimeout(entry.timer);
    if (reply.ok !== true) {
      entry.fail(new Error(reply.error || "Marketplace unavailable"));
      return;
    }
    try {
      entry.settle(entry.read(reply as never));
    } catch (e) {
      entry.fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * One request, one correlated reply.
 */
function nuiRequest<T>(
  callback: string,
  resultEvent: string,
  payload: Record<string, unknown>,
  read: (reply: never) => T,
  signal?: AbortSignal
): Promise<T> {
  ensureListener(resultEvent);
  const requestId = `mpb-${Date.now().toString(36)}-${++sequence}`;

  return new Promise<T>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      window.clearTimeout(timer);
      fn();
    };
    const timer = window.setTimeout(
      () => finish(() => reject(new Error("Marketplace request timed out"))),
      REPLY_TIMEOUT_MS
    );
    pending.set(requestId, {
      settle: resolve as (value: unknown) => void,
      fail: reject,
      read: read as (reply: never) => unknown,
      timer,
    });

    signal?.addEventListener(
      "abort",
      () => finish(() => reject(new Error("Marketplace request cancelled"))),
      { once: true }
    );

    void fetchNui(callback, { ...payload, requestId }).then((ack) => {
      if (ack === null) finish(() => reject(new Error("Marketplace bridge unavailable")));
    });
  });
}

export function browseMarketplace(params: BrowseParams, signal?: AbortSignal): Promise<BrowsePage> {
  return nuiRequest<BrowsePage>(
    "marketplaceBrowse",
    "marketplaceBrowseResult",
    { ...params },
    (reply: BrowseReply) => {
      if (!Array.isArray(reply.items)) throw new Error("Invalid marketplace response");
      return {
        items: reply.items,
        total: typeof reply.total === "number" ? reply.total : reply.items.length,
        nextCursor: typeof reply.nextCursor === "number" ? reply.nextCursor : 0,
        hasMore: reply.hasMore === true,
      };
    },
    signal
  );
}

/**
 * Like, or un-like, one item for the player at this NUI frame. Notice what's not in the
 * payload: any identity. Only a slug and a desired state — the license is resolved
 * server-side from the net event's `source` in `server/sv_marketplace.lua`, since a value
 * the NUI sent would be a value the player chose, letting anyone like as a thousand people.
 */
export function likeMarketplaceItem(
  slug: string,
  next: boolean,
  signal?: AbortSignal
): Promise<LikeState> {
  return nuiRequest<LikeState>(
    "marketplaceLike",
    "marketplaceLikeResult",
    { slug, next },
    (reply: { likes?: unknown; liked?: unknown }) => {
      if (typeof reply.likes !== "number" || typeof reply.liked !== "boolean") {
        throw new Error("Invalid like response");
      }
      return { likes: reply.likes, liked: reply.liked };
    },
    signal
  );
}

/** The authoritative state the server answers a like with. */
export interface LikeState {
  likes: number;
  liked: boolean;
}

/**
 * The published definition of a `theme` item — a dispatch panel's CSS variables, raw CSS,
 * slot fragments and script. Through the bridge, not fetched, for the same CORS reason as
 * browse. The panel it's pushed into IS loaded cross-origin (an application, not a document
 * this code reads) — only the definition needs the round trip. Not cached beside the
 * preview documents: a definition is a few KB against their megabytes, no claim on that
 * budget.
 */
export function marketplaceThemeDefinition(
  slug: string,
  signal?: AbortSignal
): Promise<PanelThemeDefinition> {
  return nuiRequest<PanelThemeDefinition>(
    "marketplaceThemeJson",
    "marketplaceThemeJsonResult",
    { slug },
    // Parsed here, not in Lua, so the VM stays a relay — decoding a stranger's JSON there
    // would put an unbounded table through a runtime with no structural check to apply.
    (reply: { json?: unknown }) => {
      if (typeof reply.json !== "string") throw new Error("Theme preview unavailable");
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.json);
      } catch {
        throw new Error("Theme preview unavailable");
      }
      const definition = parsePanelThemeDefinition(parsed);
      if (!definition) throw new Error("Theme preview unavailable");
      return definition;
    },
    signal
  );
}

/**
 * The preview document for a UI item, as text.
 *
 * Text, and not a frame URL, because the caller reads it: it injects the
 * `data-hud-*` preview script and derives the canvas size from a comment
 * inside the markup, neither of which is possible against a cross-origin
 * frame. See `server/lib/marketplace/browse.ts`.
 */
export function previewMarketplaceHtml(slug: string): Promise<string> {
  const hit = previewCache.get(slug);
  if (hit) {
    previewCache.delete(slug);
    previewCache.set(slug, hit); // LRU: a hit is a use, so re-insert at the tail.
    return hit.doc;
  }

  const doc = nuiRequest<string>(
    "marketplacePreview",
    "marketplacePreviewResult",
    { slug },
    (reply: { html?: unknown }) => {
      if (typeof reply.html !== "string" || !reply.html) throw new Error("Preview unavailable");
      return reply.html;
    }
  );

  const entry: PreviewCacheEntry = { doc, bytes: 0 };
  previewCache.set(slug, entry);
  void doc.then(
    (text) => {
      entry.bytes = text.length;
      evict();
    },
    () => {
      if (previewCache.get(slug) === entry) previewCache.delete(slug);
    }
  );
  return doc;
}

interface PreviewCacheEntry {
  doc: Promise<string>;
  /** Charged to the budget once the document has arrived; 0 while in flight. */
  bytes: number;
}

/** Preview documents already fetched, newest use last. */
const previewCache = new Map<string, PreviewCacheEntry>();

/**
 * 8 MB — four of the 1.0-1.8 MB documents this corpus contains. Not a multiple of the
 * server's own ceiling: `MAX_PREVIEW_BYTES` in `server/lib/marketplace/browse.ts` is 10 MB
 * (raised from 2 MB once two shipped tLS documents exceeded the old cap), so one admissible
 * document can exceed this whole budget — which is what `evict` keeping the newest entry is for.
 */
export const PREVIEW_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

function evict(): void {
  let total = 0;
  for (const entry of previewCache.values()) total += entry.bytes;
  // Map iteration is insertion order and a hit re-inserts, so the first key is
  // the least recently used.
  for (const [slug, entry] of previewCache) {
    if (total <= PREVIEW_CACHE_BUDGET_BYTES) return;
    // Never evict down to nothing — a single document admitted up to 10 MB against the 8 MB
    // budget used to get deleted right after being charged, so the biggest documents (the
    // most expensive to re-fetch) were silently the only ones never cached.
    if (previewCache.size <= 1) return;
    // An in-flight entry is 0 bytes and evicting it would abandon a request
    // another surface may already be awaiting, for no memory back.
    if (entry.bytes === 0) continue;
    previewCache.delete(slug);
    total -= entry.bytes;
  }
}

/**
 * Reset the cache. Its consumer is the test suite, not a surface — stated plainly so this
 * doesn't read as a production API waiting for a caller. The obvious candidate caller,
 * `MarketplaceBrowser.applyOpenData` clearing on every panel open in case a slug was
 * republished, is wrong: closing/reopening the panel is the commonest thing a player does,
 * and clearing there throws the cache away in exactly the case it exists for. Restaging
 * under one slug is rare; paying 1.75 MB again on every reopen is not.
 */
export function clearPreviewCache(): void {
  previewCache.clear();
}

/** The cache's current contents. Same consumer as above: the test suite. */
export function previewCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of previewCache.values()) bytes += entry.bytes;
  return { entries: previewCache.size, bytes };
}
