// HTTP client for the community-configs API (`/api/v1/community-configs`).
//
// ── Why this is in the Node bundle and not in Lua ───────────────────────────
//
// `server/sv_community_configs.lua` used to do this with PerformHttpRequest,
// and it did not authenticate. The publish endpoint now requires
// `X-Resource-Secret`, and that secret lives in `../marketplace/api.ts`.
// Handing it to the Lua VM through a FiveM export would let any third-party
// script on a customer's server read it — a strictly worse exposure than the
// bundle already has, since extracting it from here at least requires file
// access. So the request moves to the secret rather than the other way round.
//
// ── Why this file has its own request helper ────────────────────────────────
//
// Two reasons. `../marketplace/api.ts`'s `nodeRequest` hardcodes `"GET"` and an
// empty body, and three of the five calls here are POSTs. More importantly it
// is built on `PerformHttpRequest`, which does not exist in this runtime — see
// the note on `request` below. Generalising that function would mean editing
// the hash-verified bundle-download path to fix a break this module does not
// need to inherit.

import { _RS, buildHeaders, MarketplaceError } from "../marketplace/api";
import { resolveConfig } from "../marketplace/config";

/** The community-configs endpoints hang off the same `/api/v1` prefix. */
function endpoint(path = ""): string {
  return `${resolveConfig().apiBase}/community-configs${path}`;
}

const TIMEOUT_MS = 15_000;

interface RawResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * ⚠️ `fetch`, NOT `PerformHttpRequest`.
 *
 * `PerformHttpRequest` is a Lua-runtime native and is simply absent from
 * globalThis in FiveM's Node server runtime — `../marketplace/fivem.ts`
 * snapshots it at module load and gets `undefined`, so every call through it
 * dies with "fPerformHttpRequest is not a function". It fails at CALL time,
 * not load time, which is why nothing catches it until a request is made.
 * (`../marketplace/api.ts` still routes through that native and has the same
 * latent break in its download path.)
 *
 * The manifest declares Node 22, so global `fetch` is here and is the better
 * tool regardless: real methods, real headers, and a real abort on timeout —
 * PerformHttpRequest has no cancellation at all.
 */
async function request(
  url: string,
  method: "GET" | "POST",
  body: string,
  headers: Record<string, string>
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e: unknown) {
    // An abort is a timeout; say so rather than surfacing "This operation was
    // aborted", which reads like a bug to whoever sees it in game.
    if (e instanceof Error && e.name === "AbortError") {
      throw new MarketplaceError("request_timed_out", 0);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a non-2xx into the same error type the marketplace path throws, so a
 * caller handling one handles both.
 *
 * The Worker answers `{error: string}` on every refusal — see
 * `src/lib/tels-configs/api.ts` — and that message is written to be shown to a
 * player ("3 of 4 LEDs in this pattern have no name…"), so it is carried
 * through rather than replaced with a status code.
 */
function toError(resp: RawResponse): MarketplaceError {
  let code = `http_${resp.status}`;
  try {
    const parsed = JSON.parse(resp.body) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error) code = parsed.error;
  } catch {
    // Non-JSON body: keep the http_<status> fallback.
  }
  return new MarketplaceError(code, resp.status);
}

function parseJson<T>(resp: RawResponse): T {
  try {
    return JSON.parse(resp.body) as T;
  } catch {
    throw new MarketplaceError("unexpected_response", resp.status);
  }
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
    // deliberately unauthenticated: they are also reachable from an in-game
    // browse panel, which cannot hold a credential.
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

/** `{ "<modelKey>": count }`, for the "N available" badge. Absent means zero. */
export async function countConfigs(params: {
  script: string;
  configType: string;
  keys: string[];
}): Promise<Record<string, number>> {
  if (params.keys.length === 0) return {};
  const qs = new URLSearchParams({
    script: params.script,
    type: params.configType,
    keys: params.keys.join(","),
  });

  const resp = await request(`${endpoint("/exists")}?${qs}`, "GET", "", buildHeaders());
  if (!resp.ok) throw toError(resp);
  return parseJson<{ counts?: Record<string, number> }>(resp).counts ?? {};
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
