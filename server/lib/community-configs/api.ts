// HTTP client for the community-configs API (`/api/v1/community-configs`).
//
// The publish endpoint requires `X-Resource-Secret: TLIB_PUBLIC_KEY` — the same
// constant that authenticates every tWeb API, not marketplace-specific despite
// the name. It is never read from a convar and must not become one: handing it
// to the Lua VM via an export would let any third-party script read it. Only
// `publishConfig` sends it; reads are unauthenticated but still identified via
// `studioHeaders`'s `x-install-id`. Reads are also unreachable from an in-game
// browse panel — the Worker sends no CORS header on /api/v1, so a CEF fetch gets
// its body withheld.

import { studioHeaders, TLIB_PUBLIC_KEY } from "../../../shared/ts/marketplace/catalogue";
import { MarketplaceError } from "../marketplace/api";
import { resolveConfig } from "../marketplace/config";
import { parseJson, request, toError } from "../marketplace/http";

/** The community-configs endpoints hang off the same `/api/v1` prefix. */
function endpoint(path = ""): string {
  return `${resolveConfig().apiBase}/community-configs${path}`;
}

// Publish

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
  /** The model fingerprint from tLS's `shared/model_fingerprint.lua`. */
  fp?: unknown;
  publisher?: { name?: string; identifiers?: string[] };
}

/**
 * A listing, and the capability to edit it.
 *
 * `editToken` is `HMAC-SHA256(TLS_CONFIG_EDIT_SECRET, id)`, minted by the
 * Worker at publish and required by `updateConfig` and `withdrawConfig`.
 *
 * Optional: a host running a build from before the endpoint existed answers
 * `{ id }` with no token — a listing that can't be edited in game, not an
 * error. Demanding one would break publishing against such hosts.
 *
 * A capability — whoever holds it can overwrite or withdraw the listing — so
 * it stays server-side only. tLS keeps it out of the broadcast `serverDefaults`.
 */
export interface PublishResult {
  id: string;
  editToken: string | null;
}

/** Resolves to the new config's id and, when the Worker mints one, its token. */
export async function publishConfig(payload: PublishPayload): Promise<PublishResult> {
  const resp = await request(
    endpoint(),
    "POST",
    JSON.stringify(payload),
    // The ONLY call in this file that sends the secret. The reads below are
    studioHeaders({ "Content-Type": "application/json", "X-Resource-Secret": TLIB_PUBLIC_KEY })
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ id?: string; editToken?: string }>(resp);
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return {
    id: parsed.id,
    editToken: typeof parsed.editToken === "string" && parsed.editToken ? parsed.editToken : null,
  };
}

// Edits
//
// Both send the resource secret AND the per-listing edit token: the secret
// alone proves "somebody running tLib" (every deployment, so nobody); the
// token proves "the publisher of THIS listing". `(server_hash,
// publisher_license)` was rejected as a credential — a license is known to
// every server the player has joined, and the server hash is caller-set.

/** The editable half of a listing. Same validation as publish, on the Worker. */
export interface UpdatePayload {
  configJson: string;
  name?: string;
  description?: string;
  key?: string;
  keyLabel?: string;
  fp?: unknown;
}

/**
 * Replace a listing's payload in place. The Worker re-derives `led_names_json`
 * and the fingerprint columns from `configJson` in the same write, so the
 * listing can't drift from what it's matched by. Does not touch publisher,
 * server, import count, or status.
 */
export async function updateConfig(
  id: string,
  editToken: string,
  payload: UpdatePayload
): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}`),
    "PATCH",
    JSON.stringify(payload),
    studioHeaders({
      "Content-Type": "application/json",
      "X-Resource-Secret": TLIB_PUBLIC_KEY,
      "X-Edit-Token": editToken,
    })
  );
  if (!resp.ok) throw toError(resp);
  return parseJson<{ id?: string }>(resp).id ?? id;
}

/**
 * Take a listing out of the catalogue. `POST .../withdraw`, not `DELETE`: the
 * Worker sets `status = 'unlisted'` rather than deleting, since
 * `tls_community_config_imports` rows still point at it. Every public read
 * gates on `status = 'published'`, so withdrawal is immediate. No un-withdraw —
 * publishing again mints a new id and token.
 */
export async function withdrawConfig(id: string, editToken: string): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}/withdraw`),
    "POST",
    "",
    studioHeaders({ "X-Resource-Secret": TLIB_PUBLIC_KEY, "X-Edit-Token": editToken })
  );
  if (!resp.ok) throw toError(resp);
  return parseJson<{ status?: string }>(resp).status ?? "unlisted";
}

// Reads

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

  const resp = await request(`${endpoint()}?${qs}`, "GET", "", studioHeaders());
  if (!resp.ok) throw toError(resp);
  return parseJson<{ items?: CommunityConfigSummary[] }>(resp).items ?? [];
}

/**
 * CANDIDATES for a vehicle, by model fingerprint -- not matches. Deciding whether
 * a candidate actually IS the same model is the caller's job, which keeps the
 * similarity algorithm shipping with the resource rather than behind a Worker
 * deploy. A POST because the fingerprint does not belong in a URL; it writes
 * nothing.
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
    studioHeaders({ "Content-Type": "application/json" })
  );
  if (!resp.ok) throw toError(resp);
  return parseJson<{ items?: CommunityConfigSummary[] }>(resp).items ?? [];
}

/**
 * Fetch one config and count the import. Returns `configJson` as the raw STRING
 * it was published as: the consuming resource applies its own migrations on the
 * way in, so a pre-parsed object would skip them.
 */
export async function importConfig(id: string): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}/import`),
    "POST",
    "",
    studioHeaders()
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ ok?: boolean; configJson?: string }>(resp);
  if (!parsed.ok || typeof parsed.configJson !== "string") {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return parsed.configJson;
}

/**
 * Fetch one config WITHOUT counting an import. It exists because a marketplace
 * tab animates a listing's preview on hover, and pulling those frames through
 * `/import` would make the import counter a measure of mouse movement.
 */
export async function peekConfig(id: string): Promise<string> {
  const resp = await request(
    endpoint(`/${encodeURIComponent(id)}/peek`),
    "GET",
    "",
    studioHeaders()
  );
  if (!resp.ok) throw toError(resp);

  const parsed = parseJson<{ ok?: boolean; configJson?: string }>(resp);
  if (!parsed.ok || typeof parsed.configJson !== "string") {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
  return parsed.configJson;
}
