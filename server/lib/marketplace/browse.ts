/**
 * Server-side marketplace browse, for the in-game panel. Routing through Lua is
 * not merely a way around CORS, it is the precondition for speaking v2 at all —
 * see shared/ts/marketplace/README.md.
 */

import {
  browseCatalogue,
  type CatalogueParams,
  type LikeState,
  marketplaceApiV2,
  marketplaceHeaders,
  setCatalogueLike,
} from "../../../shared/ts/marketplace/catalogue";
import { type MarketplaceItem, toCanonicalItem } from "../../../shared/ts/marketplace/item";
import { MarketplaceError } from "./api";
import { request, toError } from "./http";

/** Browse is a read behind a panel the player already has open — keep it short. */
const BROWSE_TIMEOUT_MS = 10_000;

/**
 * A stall backstop, not a content policy: the string crosses the Lua VM and then
 * a NUI message. Sized above the largest shipped preview documents, because a cap
 * that refuses genuine content is a gate and the account quota is the only size
 * gate that should exist.
 */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/**
 * An alias, not a definition: the shape and the conversion live in
 * `shared/ts/marketplace/item.ts` so tRadio's admin server can reach them too.
 * The name is kept so this module's callers do not have to change.
 */
export type BrowseItem = MarketplaceItem;

/**
 * Aliased rather than re-declared so the two cannot drift, under this file's
 * historical name because the Lua bridge and the panel both spell it that way.
 */
export type BrowseParams = CatalogueParams;

export interface BrowseResult {
  items: BrowseItem[];
  total: number;
  nextCursor: number;
  hasMore: boolean;
}

/**
 * List items for the in-game panel. The request itself belongs to
 * `shared/ts/marketplace/catalogue.ts`, which tRadio's admin server compiles in as
 * well; this is the tLib-panel adapter on top of it and nothing more.
 */
export async function browseItems(params: BrowseParams): Promise<BrowseResult> {
  const page = await browseCatalogue(params, BROWSE_TIMEOUT_MS);
  return {
    items: page.items.map(toCanonicalItem),
    total: page.total,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * Like, or un-like, one item for one player.
 *
 * `license` must come from `GetPlayerIdentifierByType(src, 'license')` and from
 * nowhere else — resolved from a NUI payload, an export argument or a convar it
 * becomes a value the caller chooses and the per-player guarantee is gone.
 * `server/sv_marketplace.lua` is the only place it should be filled in. The
 * integrity argument and the residual operator risk are in
 * shared/ts/marketplace/README.md.
 *
 * `next` is the state being asked for, not a toggle, so the retry a timeout
 * invites cannot invert anything.
 */
export async function likeItem(slug: string, license: string, next: boolean): Promise<LikeState> {
  return setCatalogueLike(slug, license, next, BROWSE_TIMEOUT_MS);
}

/**
 * The preview HTML for a UI item, addressed by slug.
 *
 * A transport where the sound preview is not, because the panel does not merely
 * display this HTML — it reads the text, injects CSS and a binder script, and
 * derives the canvas size from a comment inside the markup, none of which a
 * cross-origin `<iframe src>` would allow. See shared/ts/marketplace/README.md.
 */
export async function previewHtml(slug: string): Promise<string> {
  if (!slug) throw new MarketplaceError("slug_required", 0);
  const resp = await request(
    `${marketplaceApiV2()}/items/${encodeURIComponent(slug)}/ui-html`,
    "GET",
    "",
    // The secret is safe here and nowhere client-side: this runs in the Node
    // bundle and must never reach a FiveM export.
    marketplaceHeaders({ Accept: "text/html" }),
    BROWSE_TIMEOUT_MS
  );
  if (!resp.ok) throw toError(resp);
  if (resp.body.length > MAX_PREVIEW_BYTES) {
    throw new MarketplaceError("preview_too_large", resp.status);
  }
  return resp.body;
}

/**
 * The published definition of a `theme` item, as JSON text.
 *
 * Brokered for the same reason the browse is — the request needs the resource
 * secret, which must never reach a client — and NOT because the panel reads the
 * body the way it reads a preview document. It does not: the string is pushed
 * into tRadio's offline panel over `postMessage` and that frame does the work.
 *
 * Returned as text rather than parsed because the only consumer that can usefully
 * validate it is the one that mounts it, and parsing here would make this module
 * a second place the theme contract is spelled out. `parsePanelThemeDefinition`
 * in `shared/ts/marketplace/ui/preview-frame.ts` is that one place.
 *
 * The same `MAX_PREVIEW_BYTES` backstop applies: a definition is a few KB in
 * practice, but it crosses the Lua VM and a NUI message exactly as a document
 * does, and that is what the ceiling is about.
 */
export async function themeJson(slug: string): Promise<string> {
  if (!slug) throw new MarketplaceError("slug_required", 0);
  const resp = await request(
    `${marketplaceApiV2()}/items/${encodeURIComponent(slug)}/theme`,
    "GET",
    "",
    marketplaceHeaders({ Accept: "application/json" }),
    BROWSE_TIMEOUT_MS
  );
  if (!resp.ok) throw toError(resp);
  if (resp.body.length > MAX_PREVIEW_BYTES) {
    throw new MarketplaceError("preview_too_large", resp.status);
  }
  return resp.body;
}
