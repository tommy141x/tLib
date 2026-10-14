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
import { fExports, fPerformHttpRequest } from "./fivem";

/** tWeb's `SUPPORT_MESSAGE_MAX`. A longer body is a 400, so it is trimmed here. */
export const MESSAGE_MAX = 2000;

/**
 * `PerformHttpRequest` HAS NO TIMEOUT. Without this the Lua callback never
 * fires, the player's dialog sits on "Sending…" forever and their text is
 * stranded in a box that will not answer. It also has to stay UNDER the menu
 * channel's own timeout (`tlib_menu_request_timeout_ms`, 10s default): a slower
 * transport answers after the channel has told the player "timed out" about a
 * message that may well have been delivered. 8s here, 9s for the Lua backstop,
 * 10s for the channel.
 */
const REQUEST_TIMEOUT_MS = 8_000;

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

type PostFn = (url: string, body: string, done: (status: number) => void) => void;

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

const performPost: PostFn = (url, body, done) => {
  let settled = false;
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    done(status);
  };
  const timer = setTimeout(() => finish(0), REQUEST_TIMEOUT_MS);
  try {
    fPerformHttpRequest(
      url,
      (status) => {
        clearTimeout(timer);
        finish(status);
      },
      "POST",
      body,
      headers()
    );
  } catch {
    clearTimeout(timer);
    finish(0);
  }
};

/** The whole send, with the transport substitutable for a suite. */
export function submit(
  input: FeedbackInput,
  done: (result: FeedbackResult) => void,
  post: PostFn = performPost
): void {
  const url = endpointFor(input.baseUrl);
  const body = buildBody(input);
  // `invalid` rather than `refused`: nothing left this server, so there is
  // nothing for the player to retry and the dialog says so.
  if (!url || !body) {
    done({ ok: false, reason: "invalid" });
    return;
  }
  post(url, JSON.stringify(body), (status) => done(classify(status)));
}

let installed = false;

/**
 * The one export, for `server/sv_feedback.lua`.
 *
 *   exports['tLib']:fbSubmit(payloadJson, function(ok, reason) end)
 */
export function installFeedback(): void {
  if (installed) return;
  installed = true;

  fExports("fbSubmit", (payloadJson: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, reason: string | null) => void;
    const answer = (result: FeedbackResult) => {
      try {
        done(result.ok, result.ok ? null : result.reason);
      } catch {
        // A throwing Lua callback is the caller's problem and must not take the
        // Node runtime's event loop with it.
      }
    };
    try {
      let input: unknown;
      try {
        input = JSON.parse(typeof payloadJson === "string" ? payloadJson : "null");
      } catch {
        answer({ ok: false, reason: "invalid" });
        return;
      }
      if (!input || typeof input !== "object") {
        answer({ ok: false, reason: "invalid" });
        return;
      }
      submit(input as FeedbackInput, answer);
    } catch {
      answer({ ok: false, reason: "unreachable" });
    }
  });
}
