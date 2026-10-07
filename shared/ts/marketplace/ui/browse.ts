/**
 * Request/reply wrapper around the server-side marketplace browse.
 *
 * ── Why this is not a `fetch` ───────────────────────────────────────────────
 *
 * The panel used to fetch `{baseUrl}/api/v1/items` directly, on the grounds
 * that the endpoint is public and read-only. Both of those are true and
 * neither is the point: CEF's origin here is `cfx-nui-tLib`, and the
 * marketplace host sends no `Access-Control-Allow-Origin` on that route, so
 * the browser made the request and then refused to hand this page the body.
 * Being public is not what makes a response readable cross-origin — the header
 * is. Browse failed for every resource whose only marketplace UI is this panel.
 *
 * The request now goes NUI → Lua → tLib's Node bundle, which is where the
 * resource secret can legitimately live, which is in turn what makes the v2
 * catalogue reachable. See `server/lib/marketplace/browse.ts`.
 *
 * ── Why a request id and not a `fetchNui` return value ──────────────────────
 *
 * A NUI callback must answer within a frame or the promise is abandoned — the
 * shared helper's own deadline is 10s and exists because a slow handler hangs
 * the caller forever. A marketplace round trip is an outbound HTTP request from
 * the game server and does not fit in that budget. So `fetchNui` is used purely
 * as fire-and-forget, and the answer arrives as an event, correlated by id.
 * This is the convention `server/lib/community-configs/bridge.ts` already
 * states for the same reason.
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
   *
   * Held per request rather than per event on purpose: a reader captured by
   * whichever call happened to register the listener first would silently
   * apply to every later call on that event.
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
  // Never torn down: this module is a singleton for the lifetime of the NUI
  // frame, and a listener that unregistered on the last settled request would
  // race the next one.
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
 *
 * Shared by browse and preview because the plumbing is the whole thing: an
 * outbound HTTP call from the game server cannot fit in a NUI callback's
 * budget, so every one of these is fire-and-forget plus an event.
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

    // An abort only stops this caller waiting; the server request is already
    // out and will settle on its own. That is the same contract the panel had
    // with `fetch` + AbortController.
    signal?.addEventListener(
      "abort",
      () => finish(() => reject(new Error("Marketplace request cancelled"))),
      { once: true }
    );

    void fetchNui(callback, { ...payload, requestId }).then((ack) => {
      // A null ack means the callback never answered — the Lua handler is
      // missing or the resource is mid-restart. Nothing will ever arrive, so
      // fail now rather than spin for 25 seconds.
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
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ NOTICE WHAT IS *NOT* IN THE PAYLOAD: ANY IDENTITY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This sends a slug and a desired state and nothing else. The player's FiveM
 * license is resolved SERVER-SIDE, from the `source` of the net event, by
 * `server/sv_marketplace.lua`. That is the single reason the like count is
 * resistant to an ordinary player at all: a value the NUI sent would be a value
 * the player chose, and any player could then like as a thousand different
 * people.
 *
 * ⚠️ So do not "optimise" this by passing a license, a server id, or any other
 * caller-supplied identifier, however convenient. The whole guarantee lives in
 * the fact that this function cannot say who it is.
 *
 * `next` is the STATE being asked for rather than a toggle, so the retry a
 * timeout invites is free — see `setCatalogueLike` on the server side.
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
      // ⚠️ `typeof` on BOTH. A reply that claims success but carries no numbers
      // is a bug on the Lua side, and accepting it would paint `0 likes` over a
      // count that was correct a moment ago — which looks like the like having
      // DELETED every other like on the item.
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
 *
 * ⚠️ Addressed by SLUG. The v1 route this replaces took an item id.
 */
export function previewMarketplaceHtml(slug: string, signal?: AbortSignal): Promise<string> {
  return nuiRequest<string>(
    "marketplacePreview",
    "marketplacePreviewResult",
    { slug },
    (reply: { html?: unknown }) => {
      if (typeof reply.html !== "string" || !reply.html) throw new Error("Preview unavailable");
      return reply.html;
    },
    signal
  );
}
