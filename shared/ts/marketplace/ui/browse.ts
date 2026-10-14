/**
 * Request/reply wrapper around the server-side marketplace browse.
 *
 * NOT a `fetch`: CEF's origin here is `cfx-nui-tLib` and the marketplace host
 * sends no `Access-Control-Allow-Origin` on that route, so the browser made the
 * request and then refused to hand this page the body. Being public is not what
 * makes a response readable cross-origin -- the header is. The request goes
 * NUI -> Lua -> tLib's Node bundle, which is where the resource secret can
 * legitimately live.
 *
 * Correlated by request ID rather than by a `fetchNui` return value, because a
 * NUI callback must answer within a frame and a marketplace round trip is an
 * outbound HTTP request from the game server. So `fetchNui` is fire-and-forget
 * and the answer arrives as an event.
 */

import { fetchNui, onNuiEvent } from "../../nui";
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
 * Like, or un-like, one item — for the player at this NUI frame.
 *
 * NOTICE WHAT IS *NOT* IN THE PAYLOAD: ANY IDENTITY.
 *
 * This sends a slug and a desired state and nothing else. The player's FiveM
 * license is resolved SERVER-SIDE, from the `source` of the net event, by
 * `server/sv_marketplace.lua`. That is the single reason the like count is
 * resistant to an ordinary player at all: a value the NUI sent would be a value
 * the player chose, and any player could then like as a thousand different
 * people.
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

/**
 * Preview documents already fetched, newest use last.
 *
 * `MAX_PREVIEW_BYTES` on the server (`server/lib/marketplace/browse.ts`) refuses
 * any single document over 2 MB, so the budget below holds at least four of the
 * largest documents that can reach here at all.
 */
const previewCache = new Map<string, PreviewCacheEntry>();

/** 8 MB — four of the largest documents the server will pass, at 2 MB each. */
const PREVIEW_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

function evict(): void {
  let total = 0;
  for (const entry of previewCache.values()) total += entry.bytes;
  // Map iteration is insertion order and a hit re-inserts, so the first key is
  // the least recently used.
  for (const [slug, entry] of previewCache) {
    if (total <= PREVIEW_CACHE_BUDGET_BYTES) return;
    // An in-flight entry is 0 bytes and evicting it would abandon a request
    // another surface may already be awaiting, for no memory back.
    if (entry.bytes === 0) continue;
    previewCache.delete(slug);
    total -= entry.bytes;
  }
}

/**
 * Reset the cache. ITS CONSUMER IS THE TEST SUITE, not a surface.
 *
 * Stated plainly so this does not read as a production API waiting for a
 * caller. `previewCache` is module state, so `tests/unit/
 * marketplace-preview-cache.test.ts` has no other way to start each case from
 * empty, and a cache whose eviction order cannot be asserted is a cache nobody
 * can show is an LRU.
 *
 * NO SURFACE CALLS THIS AND NONE SHOULD, which is a decision rather than an
 * omission. The obvious caller is `MarketplaceBrowser.applyOpenData` — clear on
 * every open of the panel, in case an item was republished under the same slug —
 * and it is wrong: closing the panel and reopening it is the commonest thing a
 * player does, and clearing there would throw the cache away in exactly the
 * case it was built for. Restaging a document under one slug is rare; paying
 * 1.75 MB again on every reopen is not.
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
