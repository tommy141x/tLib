/**
 * Server-side marketplace browse, for the in-game panel.
 *
 * ── Why browse is not a `fetch` from the NUI ────────────────────────────────
 *
 * It used to be, and it could never have worked. `MarketplacePanel.tsx` fetched
 * `{baseUrl}/api/v1/items` straight out of CEF, whose origin is
 * `cfx-nui-tLib`, and the marketplace host sends no `Access-Control-Allow-Origin`
 * on that route — verified on the live backend (tg-new's
 * `src/lib/marketplace/v1-compat.ts` sets only `Cache-Control`) and on the
 * rewrite. The panel's own comment said the endpoint is "public and read-only",
 * which is true and is not the point: being public is not what makes a response
 * readable cross-origin, the header is. The browser fetched it and refused to
 * hand over the body, so every browse failed.
 *
 * tDetector and tRadar have no marketplace UI other than that panel, which is
 * why they present as having no marketplace at all despite being fully wired
 * into the agent.
 *
 * Routing the request through Lua into this bundle makes it originate
 * server-side, which is not merely a way around CORS — it is the precondition
 * for speaking v2 at all.
 *
 * ── Why v2 ──────────────────────────────────────────────────────────────────
 *
 * v1 drops the `X-Resource-Secret` check *specifically because* its callers
 * ship inside a game client and cannot hold a credential. Once the request
 * leaves from here that objection is gone, and v2 is the better contract: it
 * takes `resource`, so a tDetector panel can be told to show only tDetector
 * items, it serves `theme` alongside `ui` and `sound`, and it answers with a
 * real error envelope instead of a bare status.
 *
 * ── The wire shape is deliberately v1's ─────────────────────────────────────
 *
 * v2 answers in camelCase. `toCanonicalItem` converts it to the canonical
 * snake_case shape, which every card component already reads. Both the shape and
 * the conversion live in `shared/ts/marketplace/item.ts` — NOT here, and not in
 * `./api.ts`, which used to own a fourth copy of the type.
 *
 * Normalising outside the components still keeps the API version an
 * implementation detail: if a v3 lands, or a customer's self-hosted host only
 * speaks v1, that is one function to change and no component. The difference is
 * that the one function is now reachable by tRadio's admin server too, which is
 * why it moved.
 */

import {
  browseCatalogue,
  type CatalogueParams,
  type LikeState,
  marketplaceApiV2,
  marketplaceHeaders,
  setCatalogueLike,
} from "../../../shared/ts/marketplace/catalogue";
import {
  type MarketplaceItem,
  toCanonicalItem,
} from "../../../shared/ts/marketplace/item";
import { MarketplaceError } from "./api";
import { request, toError } from "./http";

/** Browse is a read behind a panel the player already has open — keep it short. */
const BROWSE_TIMEOUT_MS = 10_000;

/** 2 MB. See `previewHtml` for why a preview document is bounded at all. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * An item as tLib's NUI reads it.
 *
 * This is now an ALIAS, not a definition. The shape and the camelCase->snake_case
 * conversion both live in `shared/ts/marketplace/item.ts`, because a private
 * `toItem` in this file is exactly why tRadio could not reuse the conversion and
 * grew a second, incompatible shape of its own. The name is kept so this module's
 * callers do not have to change.
 */
export type BrowseItem = MarketplaceItem;

/**
 * Browse parameters.
 *
 * Structurally `CatalogueParams`; aliased rather than re-declared so the two
 * cannot drift, and re-exported under this file's historical name because the
 * Lua bridge and the panel both spell it `BrowseParams`.
 */
export type BrowseParams = CatalogueParams;

export interface BrowseResult {
  items: BrowseItem[];
  total: number;
  nextCursor: number;
  hasMore: boolean;
}

/**
 * List items for the in-game panel.
 *
 * The request itself — base URL, credential, timeout, error envelope, wire
 * normalisation — belongs to `shared/ts/marketplace/catalogue.ts`, which
 * tRadio's admin server compiles in as well. This function is the tLib-panel
 * adapter on top of it and nothing more.
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
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ `license` MUST COME FROM `GetPlayerIdentifierByType(src, 'license')` AND
 * FROM NOWHERE ELSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the whole integrity story of the feature on the client side, so it is
 * stated at the one function a new caller would reach for:
 *
 *   · The marketplace credential on the outbound request is
 *     `MARKETPLACE_RESOURCE_SECRET`, which is PUBLIC BY DESIGN. It identifies a
 *     server running tLib and says nothing about a person.
 *   · The person is named by this argument. Resolved from the `source` of a net
 *     event, it is a value the player cannot choose, which is exactly what makes
 *     `UNIQUE(item_id, subject)` on the backend stop a player liking twice.
 *   · Resolved from ANY other source — a NUI payload, an export argument, a
 *     convar — it becomes a value the caller chooses, and the per-player
 *     guarantee is gone. `server/sv_marketplace.lua` is the only place this
 *     should be filled in.
 *
 * ⚠️ AND THE RESIDUAL RISK, WHICH THIS CANNOT FIX: whoever runs the game server
 * can call the HTTP endpoint directly with any license they invent. The backend
 * rate-limits by calling server and by subject, which bounds how fast, not
 * whether. So the count is resistant to a PLAYER and not to an OPERATOR. The
 * full argument is in tWeb's `src/lib/marketplace/like-identity.ts`.
 *
 * `next` is the state being asked for, not a toggle, so the retry a timeout
 * invites cannot invert anything.
 */
export async function likeItem(
  slug: string,
  license: string,
  next: boolean
): Promise<LikeState> {
  return setCatalogueLike(slug, license, next, BROWSE_TIMEOUT_MS);
}

/**
 * The preview HTML for a UI item.
 *
 * ── Why this is a transport and the sound preview is not ────────────────────
 *
 * Both previews were `fetch` calls from the NUI and both were CORS-blocked.
 * Only one of them needs a server round trip to fix, and the difference is
 * what the panel does with the answer.
 *
 * The panel does not merely display this HTML. It reads the text: it injects
 * centering CSS, appends the `data-hud-*` preview script that makes a
 * declarative layout render a populated device instead of every state stacked
 * on top of each other, and derives the canvas size from a base64
 * `studio-design:` comment inside the markup. A cross-origin `<iframe src>`
 * would render the page and give the parent none of that — a frame from
 * another origin cannot be read or scripted. So the text has to come here.
 *
 * The sound preview needs none of that: the waveform is drawn from the
 * `preview_waveform` array the list already carries, and playback, duration and
 * seeking are all an `<audio>` element's own job. So it stays a media element
 * pointed at `preview_url`, which is exempt from CORS and needs no credential.
 * Pulling audio bytes through Lua would mean shipping binary across the
 * Lua↔JS boundary, which this codebase avoids everywhere else for good reason.
 *
 * ⚠️ Addressed by SLUG. v1 addressed preview HTML by item id; v2 addresses
 * every endpoint by slug.
 */
export async function previewHtml(slug: string): Promise<string> {
  if (!slug) throw new MarketplaceError("slug_required", 0);
  const resp = await request(
    `${marketplaceApiV2()}/items/${encodeURIComponent(slug)}/ui-html`,
    "GET",
    "",
    // Same credential and same base URL as browse, from the one shared module
    // — not a second copy of either. The secret is safe here and nowhere
    // client-side: this runs in the Node bundle and must never reach a FiveM
    // export.
    marketplaceHeaders({ Accept: "text/html" }),
    BROWSE_TIMEOUT_MS
  );
  if (!resp.ok) throw toError(resp);
  // A preview is one self-contained document with its assets inlined. The cap
  // is not about a malicious host — it is that this string crosses into the Lua
  // VM and then into a NUI message, and an unbounded one would stall both.
  if (resp.body.length > MAX_PREVIEW_BYTES) {
    throw new MarketplaceError("preview_too_large", resp.status);
  }
  return resp.body;
}
