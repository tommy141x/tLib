import type { CatalogueItem } from "./item.ts";

/**
 * The one marketplace catalogue transport, compiled into every resource's SERVER
 * bundle at build time. The shape is v2's camelCase verbatim, because it is the
 * wire; tLib's own snake_case NUI shape is an adapter in
 * `server/lib/marketplace/browse.ts` on top of this.
 *
 * SERVER-ONLY: it carries the tLib public key, so `shared/ts/index.ts`
 * deliberately does not re-export the marketplace subtree. Do not add it to that
 * barrel, and do not import it from any `client/` or `web/` tree.
 *
 * Design rationale, the public-key posture and the identity guarantees:
 * docs/internal/marketplace-transport.md
 */

import { createHash } from "node:crypto";
import { installIdHeaders } from "../install-id";

const g = globalThis as unknown as {
  GetConvar?: (name: string, defaultValue: string) => string;
};

function convar(name: string, fallback: string): string {
  return typeof g.GetConvar === "function" ? (g.GetConvar(name, fallback) ?? fallback) : fallback;
}

/**
 * The one value every tWeb API call authenticates with.
 *
 * THIS IS A PUBLIC KEY, ON PURPOSE — do not "fix" it. It is a speed bump against
 * the APIs being scriptable from a browser, not a credential, and baking it in is
 * what makes that true for every install with zero setup. It must never become a
 * convar, and never be handed to a FiveM export (which would let any third-party
 * script on a customer's server read it without file access).
 *
 * The wire header stays `x-resource-secret`: every shipped resource sends it and
 * tWeb authenticates on it, so renaming it is a live auth change.
 */
export const TLIB_PUBLIC_KEY = "tgmp-7c4a2f19d83e6b05a91f0c47e2d85b3a"; // gitleaks:allow

/** Browse is a read behind a panel someone already has open — keep it short. */
export const CATALOGUE_TIMEOUT_MS = 10_000;

/**
 * Where the TIMMYG Studios API lives — the ONE TypeScript definition of it. The
 * Lua side's match is `StudioApi.DEFAULT_BASE_URL` in `shared/sh_api.lua`; no
 * source can span both languages, so `tests/unit/marketplace-base-url.test.ts`
 * asserts the two literals are byte-equal.
 */
export const MARKETPLACE_DEFAULT_BASE_URL = "https://timmygstudios.com";

/** The convar that redirects every studio API call. */
export const API_BASE_URL_CONVAR = "tlib_api_base_url";

// Suffixes the callers append themselves; left on, they build `.../api/v1/api/v1/items`.
// Longest first — `endsWith` is not ordered for us. Mirrors APPENDED in shared/sh_api.lua.
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
          `[tLib] ${API_BASE_URL_CONVAR} ends in "${suffix}"; callers append that themselves, so it was trimmed to "${url}".`
        );
      }
      break;
    }
  }
  url = url.replace(/\/+$/, "");
  return url === "" ? MARKETPLACE_DEFAULT_BASE_URL : url;
}

/**
 * Where the marketplace is. Read from the convar on every call, never cached: an
 * import-time read can precede the convar being set on a cold start, and caching
 * would stop a mid-session change taking effect without a restart.
 */
export function marketplaceBaseUrl(): string {
  return normalizeStudioBaseUrl(convar(API_BASE_URL_CONVAR, MARKETPLACE_DEFAULT_BASE_URL));
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

/**
 * Headers for an UNAUTHENTICATED studio API call, and the one place a tWeb-bound
 * request gets its identity — so an endpoint added next year cannot forget it.
 *
 * Deliberately carries NO `x-resource-secret`: community-configs authenticates
 * only its publish call. `marketplaceHeaders` is the variant that adds the key.
 * Do not "complete" these headers.
 */
export function studioHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-FiveM-Server": marketplaceServerId(),
    ...installIdHeaders(),
    ...(extra ?? {}),
  };
}

/** Headers for an AUTHENTICATED studio API call. The wire name does not change. */
export function marketplaceHeaders(extra?: Record<string, string>): Record<string, string> {
  return studioHeaders({
    "X-Resource-Secret": TLIB_PUBLIC_KEY,
    ...(extra ?? {}),
  });
}

/**
 * The header `/items/:slug/download` carries the bundle's digest in. There is no
 * size header on the live backend — `content-length` is the only size signal.
 */
export const MARKETPLACE_HASH_HEADER = "x-marketplace-file-hash";

/**
 * Verify downloaded bundle bytes against the marketplace's declared digest.
 *
 * FAILS CLOSED on a missing header: "we could not check" is the case an attacker
 * controls, since stripping a header is easier than forging one.
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
   * It travels as a HEADER and `catalogueQuery` deliberately does not serialise
   * it: a URL is a cache key and a log line, and a license is a durable
   * per-human identifier. Supplying it adds `liked` per item and makes the
   * response `private, no-store`.
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
 * Normalise one wire item. Optional fields are OMITTED rather than set to
 * `undefined`/`null`, because every consumer checks presence — a `previewUrl: null`
 * would make a UI item claim to be playable.
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
    // Not through `num()`, unlike `downloads`: that maps a missing value to 0, and
    // 0 is a real like count — a host predating likes must stay distinguishable
    // from an item nobody has liked.
    ...(typeof raw.likes === "number" && Number.isFinite(raw.likes) ? { likes: raw.likes } : {}),
    // Presence, not truthiness: a genuine `false` means "you have not liked this"
    // while absence means "no identity was asserted", and they render differently.
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
 * One GET against the v2 contract, decoded. Shared so the callers cannot drift on
 * the three contractual things: the credential goes on every request, an abort
 * reports as `request_timed_out`, and a non-JSON body is `unexpected_response`
 * rather than a parse crash.
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
    // An abort is a timeout; "This operation was aborted" reads like a bug in a panel.
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
  // A zero cursor is what a first page means, and the server's default is the
  // contract — say nothing rather than asserting it.
  if (typeof params.cursor === "number" && params.cursor > 0) {
    qs.set("cursor", String(params.cursor));
  }
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.sort) qs.set("sort", params.sort);
  // `params.identity` is deliberately NOT serialised here — it is a header.
  // `marketplace-catalogue.test.ts` asserts its absence from this string.
  return qs.toString();
}

/** The identity header both the browse and the like path read. */
export const MARKETPLACE_IDENTITY_HEADER = "X-FiveM-Identity";

/** `{ [MARKETPLACE_IDENTITY_HEADER]: license }`, or nothing. One spelling, one place. */
function identityHeaders(identity?: string): Record<string, string> | undefined {
  return identity ? { [MARKETPLACE_IDENTITY_HEADER]: identity } : undefined;
}

/**
 * List catalogue items. Always SERVER-SIDE: that is the precondition for sending
 * the key at all, and therefore for v2 being reachable. v1 exists because its
 * callers ship inside a game client and cannot hold one.
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
  // Slug is the install identity, so a slugless entry renders a card whose Install
  // button can only ever fail.
  const items = raw.map(toCatalogueItem).filter((item) => item.slug !== "");
  const page = parsed?.pagination ?? {};
  return {
    items,
    total: num(page.total),
    // Advance by what arrived rather than trusting a cursor to be sent; a missing
    // one would pin a panel to page one.
    nextCursor:
      typeof page.nextCursor === "number" ? page.nextCursor : (params.cursor ?? 0) + items.length,
    hasMore: page.hasMore === true,
  };
}

/* Likes */

/** The authoritative state of one item's likes after a write. */
export interface LikeState {
  likes: number;
  /** Whether the player this call was made for now holds a like on it. */
  liked: boolean;
}

/**
 * Like, or un-like, one item on behalf of one player.
 *
 * `identity` IS A CLAIM THIS SERVER MAKES, NOT A CREDENTIAL THE PLAYER PRESENTED.
 * It must come from `GetPlayerIdentifierByType(src, 'license')` server-side and
 * NEVER from a NUI payload — a value the client sent is a value the client chose.
 * Do not add a convar or export argument for it either. A player cannot inflate a
 * count (the backend holds `UNIQUE(item_id, subject)`); an operator can, and that
 * bound is accepted. See docs/internal/marketplace-transport.md.
 *
 * `next` is the state being asked for rather than a toggle, so a retry after a
 * timeout is free.
 */
export async function setCatalogueLike(
  slug: string,
  identity: string,
  next: boolean,
  timeoutMs: number = CATALOGUE_TIMEOUT_MS
): Promise<LikeState> {
  if (!slug) throw new CatalogueError("slug_required", 0);
  // Refused here as well as at the backend: a 400 from the host reads at the panel
  // as "the marketplace is down", when it means the caller forgot the license.
  if (!identity) throw new CatalogueError("identity_required", 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let body = "";
  try {
    const res = await fetch(`${marketplaceApiV2()}/items/${encodeURIComponent(slug)}/like`, {
      // POST adds, DELETE withdraws. The backend route takes no body at all, so
      // there is nothing for a caller to get wrong.
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

  // The server's numbers as-is, not the caller's optimistic ±1: a count that
  // includes somebody else's concurrent like is more current, not wrong, and using
  // it stops a panel drifting from the truth over a session.
  return {
    likes: num(parsed.likes),
    liked: parsed.liked === true,
  };
}

/* Cross-product install enforcement */

/**
 * The marketplace answered without saying which product owns the item. Fail-closed:
 * a field is easier to strip than to forge, so "ownership was never established"
 * must not be the state that installs.
 */
export const ITEM_RESOURCE_UNKNOWN = "item_resource_unknown";

/** The item belongs to a different product than the one asking to install it. */
export const ITEM_RESOURCE_MISMATCH = "item_resource_mismatch";

/**
 * One catalogue item, by slug — the ONLY way a caller can learn which product owns
 * one, which is why it exists. Server-side only, like `browseCatalogue`.
 *
 * Throws `CatalogueError`. A 404 is not translated, because a caller that wants to
 * tell "no such item" from "wrong product" needs the status.
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
  // `toCatalogueItem` never throws, so JSON that is not an item arrives as an item
  // of empty strings. Slug is the install identity; without one nothing was checked.
  if (!item.slug) throw new CatalogueError("unexpected_response", 0);
  return item;
}

/**
 * Refuse an item that belongs to another product. Browse already showed one
 * product's catalogue, but install used to accept any slug from any of them.
 *
 * Case-insensitive because no two products here differ only by case, so folding it
 * costs nothing and avoids turning a typo into a dead Install button.
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
