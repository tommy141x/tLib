import type { CatalogueItem } from "./item.ts";

/**
 * The one marketplace catalogue transport, shared by every resource's SERVER
 * bundle at build time.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Before it there were three hand-rolled HTTP wrappers against one host on two
 * API versions: tLib's, tRadio's (inside its 4.7k-line admin server), and
 * community-configs'. Each had its own base-URL resolution, its own copy of the
 * resource secret, its own timeout and its own idea of what a marketplace item
 * looks like. That is not a style problem — it is why `previewColors` reached
 * tRadio and silently vanished on the way into tLib, and why tRadio's own store
 * carries a comment about theme swatches having already been lost once to
 * exactly this class of drift.
 *
 * ── Why build-time sharing and not a FiveM export ───────────────────────────
 *
 * `tRadio/server/main.ts` already imports `./agent` from here by relative path,
 * as do tELS, tDetector and tRadar. Compiling the transport into each consumer
 * is therefore the established mechanism in this codebase, and it is the better
 * one: no cross-resource export marshalling, no runtime dependency on tLib
 * having started, and the whole thing is unit-testable in-process.
 *
 * ── Why the shape here is v2's camelCase, verbatim ──────────────────────────
 *
 * Because it is the wire. Converting on arrival would mean every consumer that
 * wants a v2 field has to be taught about it in two places, which is the exact
 * failure above. tLib's NUI reads a snake_case shape for its own historical
 * reasons; that conversion lives in tLib's `server/lib/marketplace/browse.ts`
 * as an adapter on top of this, not in place of it.
 *
 * ⚠️ SERVER-ONLY. This module carries the resource secret — baked in, NOT read
 * from a convar; see `MARKETPLACE_RESOURCE_SECRET` below. It is reachable only
 * by explicit deep import — `shared/ts/index.ts` deliberately does not
 * re-export the marketplace subtree, so `@tlib/shared` cannot drag it into a
 * NUI bundle. Do not add it to that barrel, and do not import it from any
 * `client/` tree or any resource's `web/` tree.
 */

import { createHash } from "node:crypto";

const g = globalThis as unknown as {
  GetConvar?: (name: string, defaultValue: string) => string;
};

function convar(name: string, fallback: string): string {
  return typeof g.GetConvar === "function" ? (g.GetConvar(name, fallback) ?? fallback) : fallback;
}

/**
 * The marketplace resource secret.
 *
 * ⚠️ THIS IS A PUBLIC SECRET, ON PURPOSE. Do not "fix" it.
 *
 * It is not a credential and it is not trying to be one. Its whole job is to
 * stop the marketplace API being trivially scriptable from a browser against
 * timmygstudios.com — downloads should come through the game, from someone who
 * owns the resource, rather than from anyone who found the endpoint. Baking it
 * into the bundle is what makes that true for every install with zero setup.
 *
 * Yes, anyone who unzips the resource or reads this repo can find it. That is
 * understood and accepted: it raises the effort, it does not eliminate it. A
 * speed bump that works everywhere beats a lock nobody can install.
 *
 * ⚠️ It must therefore NEVER become a convar or any other operator-supplied
 * value. Requiring setup would break every existing install and buy nothing —
 * the same shared string would just move from a zip a customer can open into a
 * config file they can read. (An agent made exactly this change once, reasoning
 * from "it is public, so it is burned". The premise is right and the conclusion
 * is wrong: it is public BY DESIGN.)
 *
 * ⚠️ It must also never be handed to a FiveM export. That is a different and
 * genuinely worse exposure — an export would let any third-party script on a
 * customer's server read it without file access. It is the reason the
 * community-config upload lives in this bundle rather than in
 * `server/sv_community_configs.lua`.
 *
 * KNOWN LIMITATION: one value authenticates "some copy of a tScripts resource",
 * not a specific licence, so it cannot tell installs apart. Per-purchase
 * credentials would be vendor-side work; until then this is the intended
 * behaviour, not a gap to close here.
 */
export const MARKETPLACE_RESOURCE_SECRET = "tgmp-7c4a2f19d83e6b05a91f0c47e2d85b3a"; // gitleaks:allow

/** Browse is a read behind a panel someone already has open — keep it short. */
export const CATALOGUE_TIMEOUT_MS = 10_000;

/**
 * Where the TIMMYG Studios API lives — the ONE TypeScript definition of it.
 *
 * `server/lib/marketplace/config.ts` used to carry its own copy of this literal;
 * it now calls through here. The Lua VMs have the matching single definition in
 * `shared/sh_api.lua` (`StudioApi.DEFAULT_BASE_URL`). No single source can span
 * both languages, so `tests/unit/marketplace-base-url.test.ts` asserts the two
 * literals are byte-equal and that neither side grows a fresh copy.
 */
export const MARKETPLACE_DEFAULT_BASE_URL = "https://timmygstudios.com";

/** The convar that redirects every studio API call. Do not rename. */
export const MARKETPLACE_BASE_URL_CONVAR = "tmarketplace_base_url";

// Suffixes the callers append themselves. `http://localhost:8787/api/v1` names
// the same host as `http://localhost:8787`; taking it literally would build
// `.../api/v1/api/v1/items`, a 404 that reads as a broken dev server. Longest
// first — `endsWith` is not ordered for us. Mirrors APPENDED in shared/sh_api.lua.
const APPENDED_API_PATHS = ["/api/v2/marketplace", "/api/v2", "/api/v1", "/api"];

let warnedAboutApiSuffix = false;

/**
 * Normalise a raw convar value into a base URL with no trailing slash and no API
 * path. Pure — it never reads a convar. Mirrored exactly by `StudioApi.normalize`
 * in `shared/sh_api.lua`.
 */
export function normalizeStudioBaseUrl(raw: unknown): string {
  let url = typeof raw === "string" ? raw.trim() : "";
  if (url === "") return MARKETPLACE_DEFAULT_BASE_URL;
  url = url.replace(/\/+$/, "");
  for (const suffix of APPENDED_API_PATHS) {
    if (url.length > suffix.length && url.endsWith(suffix)) {
      url = url.slice(0, -suffix.length);
      if (!warnedAboutApiSuffix) {
        warnedAboutApiSuffix = true;
        console.warn(
          `[tLib] ${MARKETPLACE_BASE_URL_CONVAR} ends in "${suffix}"; callers append that themselves, so it was trimmed to "${url}".`
        );
      }
      break;
    }
  }
  url = url.replace(/\/+$/, "");
  return url === "" ? MARKETPLACE_DEFAULT_BASE_URL : url;
}

/**
 * Where the marketplace is.
 *
 * Read from the convar on every call rather than cached at module scope: a
 * cached value is resolved at import time, which on a cold start can precede
 * the convar being set, and it makes the value untestable without a fresh
 * module registry. `resolveConfig()` in `server/lib/marketplace/config.ts` used
 * to memoise on top of this and no longer does, so changing the convar
 * mid-session now takes effect everywhere without a resource restart — which is
 * the entire point of pointing it at a local dev server.
 */
export function marketplaceBaseUrl(): string {
  return normalizeStudioBaseUrl(
    convar(MARKETPLACE_BASE_URL_CONVAR, MARKETPLACE_DEFAULT_BASE_URL)
  );
}

export function marketplaceApiV2(): string {
  return `${marketplaceBaseUrl()}/api/v2/marketplace`;
}

let cachedServerId: string | null = null;

/**
 * A stable, non-reversible install label, used by the Worker as its rate-limit
 * key. Not a credential: the raw `sv_licenseKey` is used for other sensitive
 * purposes and must never go over the wire.
 */
export function marketplaceServerId(): string {
  if (cachedServerId) return cachedServerId;
  const license = convar("sv_licenseKey", "").trim();
  const hostname = convar("sv_hostname", "").trim();
  const fallback = convar("sv_projectName", "").trim() || "unknown-server";
  const source = license || `${hostname}|${fallback}`;
  cachedServerId = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return cachedServerId;
}

/** Test seam: forget the memoised id so a convar change is observable. */
export function _resetServerId(): void {
  cachedServerId = null;
}

export function marketplaceHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Resource-Secret": MARKETPLACE_RESOURCE_SECRET,
    "X-FiveM-Server": marketplaceServerId(),
    ...(extra ?? {}),
  };
}

/**
 * The header `/items/:slug/download` carries the bundle's digest in.
 *
 * Set by the live backend in `tg-new/src/lib/marketplace/shared.ts` (and by
 * `sound-download.ts` for sound items). There is no `X-Marketplace-Size-Bytes`
 * on the live backend — `content-length` is the only size signal.
 */
export const MARKETPLACE_HASH_HEADER = "x-marketplace-file-hash";

/**
 * Verify downloaded bundle bytes against the marketplace's declared digest.
 *
 * Mirrors the identical check inside `installer/bundle.ts`'s `prepareBundle`,
 * which is how tLib's own install agent has always verified. It is factored out
 * here rather than reused from there because `prepareBundle` is entangled with
 * an `InstallTarget` and a whole extraction pipeline that a caller doing its own
 * extraction (tRadio) cannot supply.
 *
 * ⚠️ FAILS CLOSED on a missing header. A bundle that arrives with no digest is
 * refused, not waved through — "we could not check" is the case an attacker
 * controls, since stripping a header is strictly easier than forging one.
 */
export function assertBundleHash(bytes: Uint8Array, headerValue: string | null | undefined): void {
  const declared = (headerValue ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(declared)) {
    throw new CatalogueError("missing_or_invalid_bundle_hash", 0);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== declared) {
    throw new CatalogueError("bundle_hash_mismatch", 0);
  }
}

/** The envelope the Worker returns on 4xx/5xx. */
export class CatalogueError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "CatalogueError";
  }
}

export interface CatalogueParams {
  /** Product scope, e.g. `tRadio`. Omitted browses the whole catalogue. */
  resource?: string;
  /** `ui`, `sound` or `theme`. */
  type?: string;
  search?: string;
  /** v2's cursor is an offset, not an opaque token. */
  cursor?: number;
  limit?: number;
  /**
   * `downloads` asks for the type-interleaved ranking, so the best UI and the
   * best sound both surface instead of the list being all of whichever type
   * has the most downloads. v2's own default is `created_at`.
   */
  sort?: "downloads" | "created_at";
  /**
   * The FiveM license of the player this browse is for, if there is one.
   *
   * ⚠️ IT TRAVELS AS A HEADER, NOT AS A QUERY PARAMETER, and `catalogueQuery`
   * deliberately does not serialise it. Three reasons, in order of how much they
   * would cost:
   *
   *   1. A URL is a cache key. Putting a per-player value in it would give every
   *      player on a server a distinct URL for the same catalogue page and make
   *      every intermediate cache useless — while ALSO risking the opposite
   *      failure if something normalised the query string away.
   *   2. A URL is what gets logged. A license is a durable per-human identifier;
   *      it belongs in a header that nothing writes to an access log by default.
   *   3. The backend reads `X-FiveM-Identity` on both the browse and the like
   *      path, so one spelling serves both and the `liked` flag cannot disagree
   *      with the write that set it.
   *
   * Supplying it makes the response carry `liked` per item and makes it
   * `private, no-store`. Omitting it changes nothing about what comes back
   * except that `liked` is absent — which is the state that renders a count with
   * no button.
   */
  identity?: string;
}

export interface CataloguePage {
  items: CatalogueItem[];
  total: number;
  nextCursor: number;
  hasMore: boolean;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function numArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Normalise one wire item.
 *
 * Optional fields are OMITTED rather than set to `undefined`/`null`, because
 * every consumer checks presence: a `previewUrl: null` on a UI item would make
 * it claim to be playable, and a `previewColors: null` on a theme renders an
 * empty swatch row instead of falling back to the placeholder tile.
 */
export function toCatalogueItem(raw: Record<string, unknown>): CatalogueItem {
  const waveform = numArray(raw.previewWaveform);
  const colors = strArray(raw.previewColors);
  return {
    id: str(raw.id),
    slug: str(raw.slug),
    type: str(raw.type),
    resource: str(raw.resource),
    name: str(raw.name),
    description: str(raw.description),
    creatorName: str(raw.creatorName, "Anonymous"),
    currentVersion: str(raw.currentVersion, "1"),
    sizeBytes: num(raw.sizeBytes),
    downloads: num(raw.downloads),
    createdAt: str(raw.createdAt),
    // ⚠️ NOT through `num()`, unlike `downloads` directly above, and the
    // difference is load-bearing: `num()` maps a missing value to 0, and 0 is a
    // real like count. Collapsing the two would make a host that predates likes
    // indistinguishable from an item nobody has liked, and every consumer checks
    // presence. See `likes` on `CatalogueItem` in `./item.ts`.
    ...(typeof raw.likes === "number" && Number.isFinite(raw.likes)
      ? { likes: raw.likes }
      : {}),
    // ⚠️ A presence check, not a truthiness one — a genuine `false` must
    // survive, because it means "you have not liked this" while absence means
    // "no identity was asserted". The two render differently.
    ...(typeof raw.liked === "boolean" ? { liked: raw.liked } : {}),
    ...(waveform ? { previewWaveform: waveform } : {}),
    ...(colors ? { previewColors: colors } : {}),
    ...(typeof raw.thumbnail === "string" ? { thumbnail: raw.thumbnail } : {}),
    ...(typeof raw.previewUrl === "string" ? { previewUrl: raw.previewUrl } : {}),
  };
}

function toError(status: number, body: string): CatalogueError {
  let code = `http_${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error) code = parsed.error;
  } catch {
    // Non-JSON body: keep the http_<status> fallback.
  }
  return new CatalogueError(code, status);
}

/**
 * One GET against the v2 contract, decoded.
 *
 * Factored out of `browseCatalogue` when `fetchCatalogueItem` arrived, so the
 * two cannot drift on the three things that are actually contractual: the
 * credential goes on every request, an abort is reported as
 * `request_timed_out` rather than "This operation was aborted", and a non-JSON
 * body is `unexpected_response` rather than a parse crash.
 */
async function getCatalogueJson(
  url: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let body = "";
  try {
    const res = await fetch(url, {
      headers: marketplaceHeaders(extraHeaders),
      signal: controller.signal,
    });
    status = res.status;
    body = await res.text();
    if (!res.ok) throw toError(status, body);
  } catch (e: unknown) {
    // An abort is a timeout; say so rather than surfacing "This operation was
    // aborted", which reads like a bug to whoever sees it in a panel.
    if (e instanceof Error && e.name === "AbortError") {
      throw new CatalogueError("request_timed_out", 0);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CatalogueError("unexpected_response", status);
  }
}

export function catalogueQuery(params: CatalogueParams): string {
  const qs = new URLSearchParams();
  if (params.resource) qs.set("resource", params.resource);
  if (params.type) qs.set("type", params.type);
  if (params.search) qs.set("search", params.search);
  // A zero cursor is what a first page means; the server's default is the
  // contract, so say nothing rather than asserting it.
  if (typeof params.cursor === "number" && params.cursor > 0) {
    qs.set("cursor", String(params.cursor));
  }
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.sort) qs.set("sort", params.sort);
  // ⚠️ `params.identity` IS DELIBERATELY NOT SERIALISED HERE. It is a header —
  // see the field's own note for the three reasons, the first of which is that a
  // URL is a cache key and a license is per-player. `marketplace-catalogue.test.ts`
  // asserts its absence from this string, so adding it would fail a test rather
  // than quietly fragmenting every cache and logging a player identifier.
  return qs.toString();
}

/** The identity header both the browse and the like path read. */
export const MARKETPLACE_IDENTITY_HEADER = "X-FiveM-Identity";

/** `{ [MARKETPLACE_IDENTITY_HEADER]: license }`, or nothing. One spelling, one place. */
function identityHeaders(identity?: string): Record<string, string> | undefined {
  return identity ? { [MARKETPLACE_IDENTITY_HEADER]: identity } : undefined;
}

/**
 * List catalogue items.
 *
 * ⚠️ Always runs SERVER-SIDE. That is not incidental — it is the precondition
 * for sending `X-Resource-Secret` at all, and therefore for v2 being reachable.
 * v1 exists precisely because its callers ship inside a game client and cannot
 * hold a credential.
 */
export async function browseCatalogue(
  params: CatalogueParams,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS
): Promise<CataloguePage> {
  const qs = catalogueQuery(params);
  const url = `${marketplaceApiV2()}/items${qs ? `?${qs}` : ""}`;

  const parsed = (await getCatalogueJson(url, timeoutMs, identityHeaders(params.identity))) as {
    items?: unknown;
    pagination?: Record<string, unknown>;
  } | null;

  const raw = Array.isArray(parsed?.items) ? (parsed.items as Record<string, unknown>[]) : [];
  // An entry with no slug renders a card whose Install button can only ever
  // fail, which is worse than not listing it: slug is the install identity.
  const items = raw.map(toCatalogueItem).filter((item) => item.slug !== "");
  const page = parsed?.pagination ?? {};
  return {
    items,
    total: num(page.total),
    // Fall back to advancing by what actually arrived rather than trusting the
    // server to have sent a cursor; a missing one would pin a panel to page one.
    nextCursor:
      typeof page.nextCursor === "number" ? page.nextCursor : (params.cursor ?? 0) + items.length,
    hasMore: page.hasMore === true,
  };
}

/* ── Likes ─────────────────────────────────────────────────────────────────── */

/** The authoritative state of one item's likes after a write. */
export interface LikeState {
  likes: number;
  /** Whether the player this call was made for now holds a like on it. */
  liked: boolean;
}

/**
 * Like, or un-like, one item on behalf of one player.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ `identity` IS A CLAIM THIS SERVER IS MAKING, NOT A CREDENTIAL THE PLAYER
 * PRESENTED. READ THIS BEFORE WIRING A NEW CALLER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The only credential on this request is `MARKETPLACE_RESOURCE_SECRET`, and that
 * is **public by design** — see its own note above. It says "a server running
 * tLib"; it says nothing about a person. The player is named by `identity`,
 * which the CALLER resolved with `GetPlayerIdentifierByType(src, 'license')`.
 *
 * So the integrity property is bounded, and it is bounded in a way that happens
 * to be exactly what was asked for:
 *
 *   · ✅ A PLAYER cannot inflate a count. They do not choose their own license —
 *     the game server resolves it from their Cfx.re entitlement — and the
 *     backend holds `UNIQUE(item_id, subject)`, so a second like on one item
 *     writes nothing. This is why `identity` must come from the native and NEVER
 *     from a NUI payload: a value the client sent is a value the client chose,
 *     and routing one through here would hand every player the operator's
 *     capability below.
 *   · ❌ A SERVER OPERATOR can. Anyone who can call this function can pass any
 *     hex string. Rate limits on the backend bound how fast; nothing bounds
 *     whether.
 *
 * ⚠️ DO NOT ADD A CONVAR, AN EXPORT ARGUMENT OR ANY OTHER OPERATOR-SUPPLIED
 * PATH TO `identity`. The one source that makes the player-level guarantee true
 * is the native, called server-side, for the `source` of the event being
 * handled. `server/sv_marketplace.lua` is where that happens and it is the only
 * place it should.
 *
 * `next` is the STATE being asked for rather than a toggle, so a retry after a
 * timeout is free: a second like writes nothing and answers the same numbers,
 * and an un-like of something never liked is a success.
 */
export async function setCatalogueLike(
  slug: string,
  identity: string,
  next: boolean,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS
): Promise<LikeState> {
  if (!slug) throw new CatalogueError("slug_required", 0);
  // ⚠️ Refused here as well as at the backend. An empty identity would otherwise
  // produce a 400 from the host that reads, at the panel, as "the marketplace is
  // down" — and it means a caller forgot to resolve the license, which is a bug
  // in the caller rather than a transport failure.
  if (!identity) throw new CatalogueError("identity_required", 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let body = "";
  try {
    const res = await fetch(`${marketplaceApiV2()}/items/${encodeURIComponent(slug)}/like`, {
      // ⚠️ POST adds, DELETE withdraws. Not one endpoint with a body: the
      // backend route declares both methods and takes no body at all, so there
      // is nothing for a caller to get wrong and nothing to parse on refusal.
      method: next ? "POST" : "DELETE",
      headers: marketplaceHeaders(identityHeaders(identity)),
      signal: controller.signal,
    });
    status = res.status;
    body = await res.text();
    if (!res.ok) throw toError(status, body);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new CatalogueError("request_timed_out", 0);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let parsed: { likes?: unknown; liked?: unknown };
  try {
    parsed = JSON.parse(body) as { likes?: unknown; liked?: unknown };
  } catch {
    throw new CatalogueError("unexpected_response", status);
  }

  // ⚠️ The SERVER'S numbers, read as-is, rather than the caller's optimistic
  // ±1. The count after the write may include a like somebody else cast a
  // millisecond ago, which is a more current number and not a wrong one — and
  // using it is what stops a panel's displayed count drifting away from the
  // truth over a session.
  return {
    likes: num(parsed.likes),
    liked: parsed.liked === true,
  };
}

/* ── Cross-product install enforcement ─────────────────────────────────────── */

/**
 * The marketplace answered, but it did not say which product owns the item.
 *
 * Fail-closed, exactly like `assertBundleHash`'s missing-header case: "we could
 * not establish ownership" is the state an attacker controls — a field is
 * easier to strip than to forge — so it must not be the state that installs.
 */
export const ITEM_RESOURCE_UNKNOWN = "item_resource_unknown";

/** The item belongs to a different product than the one asking to install it. */
export const ITEM_RESOURCE_MISMATCH = "item_resource_mismatch";

/**
 * One catalogue item, by slug.
 *
 * ⚠️ This is the ONLY way a caller can learn which product owns a slug, and it
 * is why it exists. `search` matches `name` and `description` and never `slug`,
 * `/download` and `/items/:slug/theme` carry no `resource`, and the list
 * endpoint would have to be walked page by page to find one item. Without this
 * call, "does this slug belong to me?" is unanswerable and every install path
 * is obliged to take the caller's word for it.
 *
 * Same contract, credential, error envelope and timeout as `browseCatalogue`;
 * see that function for why this can only run SERVER-SIDE.
 *
 * Throws `CatalogueError`. A slug that does not exist, or that is not
 * published, surfaces as the backend's own `Not found` at HTTP 404 — it is not
 * translated here, because a caller that wants to distinguish "no such item"
 * from "wrong product" needs the status.
 */
export async function fetchCatalogueItem(
  slug: string,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS
): Promise<CatalogueItem> {
  const wanted = (slug ?? "").trim();
  if (!wanted) throw new CatalogueError("slug_required", 0);

  const raw = await getCatalogueJson(
    `${marketplaceApiV2()}/items/${encodeURIComponent(wanted)}`,
    timeoutMs
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CatalogueError("unexpected_response", 0);
  }

  const item = toCatalogueItem(raw as Record<string, unknown>);
  // `toCatalogueItem` is total and never throws, so a body that is JSON but not
  // an item arrives here as an item with empty strings. Slug is the install
  // identity; without one there is nothing to have checked.
  if (!item.slug) throw new CatalogueError("unexpected_response", 0);
  return item;
}

/**
 * Refuse an item that belongs to another product.
 *
 * ── What this closes ────────────────────────────────────────────────────────
 *
 * tLib's coordinator keys registrations `resource:type` and writes into that
 * resource's own registered `installPath`, so a tELS item can never land in
 * tRadio's *directory*. What was unenforced is the item's own `resource`
 * field: `tlib:marketplace:install('tRadar', 'ui', '<a-tELS-slug>')` passed
 * every check and tLib fetched and installed it. Browse showed one product's
 * catalogue; install accepted any slug from any of them.
 *
 * ── Why the comparison is case-insensitive ──────────────────────────────────
 *
 * `expectedResource` is the same string the panel sends as v2's `resource`
 * filter, so it already has to equal the marketplace's product name for browse
 * to have shown anything at all. Case is the one difference that can plausibly
 * arise without being a different product — there is no pair of products here
 * distinguishable only by case — so folding it costs nothing and avoids turning
 * a typo into a dead Install button.
 */
export function assertItemResource(item: CatalogueItem, expectedResource: string): void {
  const declared = (item.resource ?? "").trim();
  const expected = (expectedResource ?? "").trim();
  // Either side missing means ownership was never established. Refuse.
  if (!declared || !expected) throw new CatalogueError(ITEM_RESOURCE_UNKNOWN, 0);
  if (declared.toLowerCase() !== expected.toLowerCase()) {
    throw new CatalogueError(ITEM_RESOURCE_MISMATCH, 0);
  }
}

/**
 * Look the slug up and refuse it if another product owns it.
 *
 * The one call an install path should make. Returns the item so a caller that
 * wants its metadata does not pay for a second round trip.
 */
export async function assertItemBelongsToResource(
  slug: string,
  expectedResource: string,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS
): Promise<CatalogueItem> {
  const item = await fetchCatalogueItem(slug, timeoutMs);
  assertItemResource(item, expectedResource);
  return item;
}
