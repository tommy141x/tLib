/**
 * Player feedback, from a t* menu to `POST /api/feedback` on tWeb.
 *
 * FEEDBACK DOES NOT REQUIRE TELEMETRY CONSENT, AND THAT IS A DECISION. The
 * consent switch governs PASSIVE collection; a feedback message is one person
 * opening a dialog and pressing Send. `/api/feedback` is unauthenticated and
 * takes no credential, and the message carries strictly less than a telemetry
 * event.
 *
 * The only identifier is the per-install id, which is NOT conditional on consent
 * -- it rides every tWeb-bound request. Feedback is therefore attributable to an
 * install and not to a PERSON, and the dialog must not call it anonymous, nor
 * imply that diagnostics or consent apply to it.
 *
 * THE MESSAGE BODY IS NOT SCRUBBED AND MUST NOT BE: client-side censorship of a
 * complaint is how a report about a credential leak gets truncated. What this
 * file does instead is attach NOTHING of its own.
 */

import { INSTALL_ID_HEADER } from "../../../shared/ts/install-id";
import { DIMENSION_CAPS, slug, versionSlug } from "../../../shared/ts/telemetry/payload";
import { installId } from "../install-id";
import { fExports } from "./fivem";

/** tWeb's `SUPPORT_MESSAGE_MAX`. A longer body is a 400, so it is trimmed here. */
export const MESSAGE_MAX = 2000;

/**
 * Why a send failed, in the vocabulary the dialog can act on. `rate-limited` is
 * its own reason and not folded into `refused`, because the two call for opposite
 * UI. tWeb's limit is ten a minute PER IP, which for a game server means per
 * server, so an ordinary busy evening can reach it.
 */
export type FeedbackFailure = "rate-limited" | "refused" | "unreachable" | "invalid";

export interface FeedbackInput {
  /** `StudioApi.baseUrl()`, resolved in Lua. Never re-derived here — see below. */
  baseUrl: unknown;
  message: unknown;
  resource: unknown;
  resourceVersion: unknown;
}

export type FeedbackResult = { ok: true } | { ok: false; reason: FeedbackFailure };


/**
 * The request body, or `null` when there is nothing worth sending. `resource` and
 * `resourceVersion` go through the TELEMETRY module's own `slug`/`versionSlug`
 * rather than a local copy: they land in the same columns, validated by the same
 * pattern at tWeb, so a second implementation here would be a second thing to
 * drift and the looser of the two would win. A field that slugs to empty is
 * OMITTED, not sent blank.
 */
export function buildBody(input: FeedbackInput): Record<string, string> | null {
  if (typeof input.message !== "string") return null;
  const message = input.message.trim().slice(0, MESSAGE_MAX);
  if (message === "") return null;

  const body: Record<string, string> = {
    message,
    source: "game",
  };
  const resource = slug(input.resource, DIMENSION_CAPS.resource);
  if (resource) body.resource = resource;
  const version = versionSlug(input.resourceVersion);
  if (version) body.resourceVersion = version;
  const install = installId();
  if (install) body.installId = install;
  return body;
}

/** `https://…/api/feedback`, or `null` for anything that is not an http(s) origin. */
export function endpointFor(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) return null;
  return `${baseUrl.replace(/\/+$/, "")}/api/feedback`;
}

/**
 * Map one HTTP status onto a reason. `0` is this module's own timeout or a thrown
 * native. Everything 5xx is `unreachable` -- a server-side fault is not the
 * player's message being wrong, and telling them it was refused would make them
 * edit text that was fine.
 */
export function classify(status: number): FeedbackResult {
  if (status === 200 || status === 201) return { ok: true };
  if (status === 429) return { ok: false, reason: "rate-limited" };
  if (status >= 400 && status < 500) return { ok: false, reason: "refused" };
  return { ok: false, reason: "unreachable" };
}

/**
 * NOT `studioHeaders()`, and this is the one place in tLib that is not.
 * `/api/feedback` takes no `x-resource-secret` and no `x-fivem-server`. What it
 * does share is `x-install-id`, from the same constant and resolver.
 */
function headers(): Record<string, string> {
  const install = installId();
  return {
    "Content-Type": "application/json",
    ...(install ? { [INSTALL_ID_HEADER]: install } : {}),
  };
}

/**
 * THE POST IS DONE IN LUA, AND THAT IS NOT WHERE IT STARTED.
 *
 * This module used to call `PerformHttpRequest` itself. MEASURED on a live
 * server 2026-10-16: `globalThis.PerformHttpRequest` is **undefined** in
 * FXServer's server JS runtime. `Citizen`, `setTick`, `onNet`, `emitNet`,
 * `exports` and `GetConvar` are all there -- 626 globals -- and that one is
 * not. So the captured handle was `undefined`, calling it threw, the catch
 * mapped it to status `0`, and `classify(0)` answered `unreachable` in **zero
 * milliseconds**. Every feedback message this server ever sent failed that way,
 * from the menu as well as from a dialog, and the 8s timeout that used to be
 * documented here never once had anything to time out.
 *
 * The same native from the Lua VM returns 201. So the split moves: Lua performs
 * the request, and this module keeps the two pure halves that have tests --
 * what to send (`buildBody`, `endpointFor`, `headers`) and what the answer
 * means (`classify`).
 *
 * `server/lib/telemetry/fivem.ts` and `server/lib/marketplace/fivem.ts`
 * reach for the same global. Telemetry already tolerates its absence with an
 * explicit fallback; marketplace captures it the way this module did. Neither
 * is verified end to end and neither is changed here.
 */

let installed = false;

/**
 * Two exports, both for `server/sv_feedback.lua`: what to send, and what the
 * answer meant. Neither performs the request — see the note above.
 */
export function installFeedback(): void {
  if (installed) return;
  installed = true;

  /**
   * What to send, for `server/sv_feedback.lua` to actually send.
   *
   *   local prepared = exports['tLib']:fbPrepare(payloadJson)
   *   -> '{"url":"...","body":"...","headers":{...}}' or '{"error":"invalid"}'
   */
  fExports("fbPrepare", (payloadJson: unknown): string => {
    let input: unknown;
    try {
      input = JSON.parse(typeof payloadJson === "string" ? payloadJson : "null");
    } catch {
      return JSON.stringify({ error: "invalid" });
    }
    if (!input || typeof input !== "object") return JSON.stringify({ error: "invalid" });
    const typed = input as FeedbackInput;
    const url = endpointFor(typed.baseUrl);
    const body = buildBody(typed);
    // `invalid` rather than `refused`: nothing left this server, so there is
    // nothing for the player to retry and the dialog says so.
    if (!url || !body) return JSON.stringify({ error: "invalid" });
    return JSON.stringify({ url, body: JSON.stringify(body), headers: headers() });
  });

  /** What one HTTP status means, in the dialog's vocabulary. */
  fExports("fbClassify", (status: unknown): string | null => {
    const result = classify(typeof status === "number" ? status : 0);
    return result.ok ? null : result.reason;
  });
}
