// HTTP client for the community-configs API (`/api/v1/community-configs`).
//
// ── Why this is in the Node bundle and not in Lua ───────────────────────────
//
// `server/sv_community_configs.lua` used to do this with PerformHttpRequest,
// and it did not authenticate. The publish endpoint now requires
// `X-Resource-Secret` — the baked-in constant re-exported as `_RS` from
// `../marketplace/api.ts`, defined once in
// `shared/ts/marketplace/catalogue.ts`.
//
// ⚠️ It is NOT read from a convar, and must never become one. This comment
// used to say `tmarketplace_resource_secret`, which was wrong and is exactly
// the misreading that got the secret converted to required operator config
// once already. See the note on `MARKETPLACE_RESOURCE_SECRET` for why it is
// public by design.
//
// Handing it to the Lua VM through a FiveM export would let any third-party
// script on a customer's server read it without console or file access — a
// strictly worse exposure. So the request moves to the secret rather than the
// other way round.
//
// ── Where the request helper went ───────────────────────────────────────────
//
// It used to live in this file, because `../marketplace/api.ts`'s `nodeRequest`
// hardcodes `"GET"` with an empty body — three of the five calls here are POSTs
// — and, worse, is built on `PerformHttpRequest`, which does not exist in this
// runtime. It is now `../marketplace/http.ts`, unchanged, because the browse
// path needs the same thing and a third copy of it would have been the fourth
// hand-rolled HTTP wrapper pointed at one host.

import { _RS, buildHeaders, MarketplaceError } from "../marketplace/api";
import { resolveConfig } from "../marketplace/config";
import { parseJson, request, toError } from "../marketplace/http";

/** The community-configs endpoints hang off the same `/api/v1` prefix. */
function endpoint(path = ""): string {
  return `${resolveConfig().apiBase}/community-configs${path}`;
}

// ── Publish ─────────────────────────────────────────────────────────────────

export interface PublishPayload {
  script: string;
  configType: "led_layout" | "pattern" | "vehicle_setup";
  /** Model key. Omitted for `pattern`, which is vehicle-agnostic. */
  key?: string;
  keyLabel?: string;
  name: string;
  description?: string;
  serverName?: string;
  configJson: string;
  /** The model fingerprint from tELS's `shared/model_fingerprint.lua`. */
  fp?: unknown;
  /**
   * ⚠️ Attribution, not authentication. This is what the game server CLAIMS
   * about the publishing player, and the Worker treats it that way — it is a
   * display name and a handle to ban, nothing more.
   */
  publisher?: { name?: string; identifiers?: string[] };
}

/** Resolves to the new config's id. */
export async function publishConfig(payload: PublishPayload): Promise<string> {
  const resp = await request(
    endpoint(),
    "POST",
    JSON.stringify(payload),
    // The ONLY call in this file that sends the secret. The reads below are
    // deliberately unauthenticated, because publishing is the only act that
    // needs attributing -- but they are NOT reachable from an in-game browse
    // panel, which is what this comment used to claim. Needing no credential
    // and being fetchable from CEF are independent properties: the Worker
    // sends no `Access-Control-Allow-Origin` on any /api/v1 route, so a fetch
    // from `cfx-nui-<resource>` receives its 200 and then has the body
    // withheld by the browser. Public is not what makes a response readable
    // cross-origin; the header is. Every read here therefore runs server-side.
    // See `shared/ts/marketplace/ui/browse.ts`, which already pays this cost.
    buildHeaders({ "Content-Type": "application/json", "X-Resource-Secret": _RS })
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ id?: string }>(resp);
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return parsed.id;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** One published config, as the Worker's `toPublicConfig` projects it. */
export interface CommunityConfigSummary {
  id: string;
  configType: string;
  name: string;
  description: string;
  keyLabel: string | null;
  ledNames: string[];
  requires: { sounds: string[] } | null;
  publisherName: string;
  serverName: string | null;
  importCount: number;
  createdAt: string;
  fp: unknown;
}

export async function listConfigs(params: {
  script: string;
  configType: string;
  key?: string;
  limit?: number;
  cursor?: number;
}): Promise<CommunityConfigSummary[]> {
  const qs = new URLSearchParams({ script: params.script, type: params.configType });
  if (params.key) qs.set("key", params.key);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", String(params.cursor));

  const resp = await request(`${endpoint()}?${qs}`, "GET", "", buildHeaders());
  if (!resp.ok) throw toError(resp);
  return parseJson<{ items?: CommunityConfigSummary[] }>(resp).items ?? [];
}

/**
 * CANDIDATES for a vehicle, by model fingerprint — not matches.
 *
 * The Worker range-scans on body length and width and returns each row's own
 * fingerprint in `fp`. Deciding whether a candidate actually IS the same model
 * is the caller's job, using `TELS_FP_Compare` from tELS's shared fingerprint
 * module. That split keeps the similarity algorithm shipping with the resource
 * rather than behind a Worker deploy, so the two ends cannot disagree.
 *
 * A POST because the fingerprint is a few dozen bone offsets and does not
 * belong in a URL. It still writes nothing.
 */
export async function matchConfigs(params: {
  script: string;
  configType: string;
  fp: unknown;
  key?: string;
  limit?: number;
}): Promise<CommunityConfigSummary[]> {
  const resp = await request(
    endpoint("/match"),
    "POST",
    JSON.stringify({
      script: params.script,
      type: params.configType,
      fp: params.fp,
      key: params.key,
      limit: params.limit,
    }),
    buildHeaders({ "Content-Type": "application/json" })
  );
  if (!resp.ok) throw toError(resp);
  return parseJson<{ items?: CommunityConfigSummary[] }>(resp).items ?? [];
}

/**
 * Fetch one config and count the import.
 *
 * ⚠️ Returns `configJson` as the raw STRING it was published as. The consuming
 * resource decodes it itself — tELS applies its own migrations on the way in,
 * so handing it a pre-parsed object would skip them.
 */
export async function importConfig(id: string): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}/import`),
    "POST",
    "",
    buildHeaders()
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ ok?: boolean; configJson?: string }>(resp);
  if (!parsed.ok || typeof parsed.configJson !== "string") {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return parsed.configJson;
}

/**
 * Fetch one config WITHOUT counting an import.
 *
 * The same payload `importConfig` returns, from `GET /{id}/peek`, which does
 * not write `import_count` or an import row. It exists because tELS's
 * marketplace tab animates a listing's LED preview on hover and in its detail
 * overlay, and animating needs the config's real frames — pulling those through
 * `/import` would make the import counter a measure of mouse movement.
 *
 * ⚠️ NO `X-Resource-Secret`. `publishConfig` is the only call in this file that
 * sends it, and the reason is in this file's header: the secret must not reach a
 * path any anonymous caller can hit. Peek is a public read of a row that is
 * public by definition — `status = 'published'` is the Worker's only gate.
 *
 * ⚠️ Returns `configJson` as the raw STRING, exactly as `importConfig` does.
 * tELS applies its own migrations on the way in, so a pre-parsed object would
 * skip them.
 */
export async function peekConfig(id: string): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}/peek`),
    "GET",
    "",
    buildHeaders()
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ ok?: boolean; configJson?: string }>(resp);
  if (!parsed.ok || typeof parsed.configJson !== "string") {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return parsed.configJson;
}
