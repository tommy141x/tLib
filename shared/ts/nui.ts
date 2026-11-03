import { timeNuiAsync } from "./telemetry/ambient";

declare global {
  interface Window {
    GetParentResourceName?: () => string;
  }
}

export function isNUI(): boolean {
  return typeof window.GetParentResourceName === "function";
}

/** Latches the one no-bridge warning in `fetchNui`, so it is said once per page. */
let _noBridgeWarned = false;

/** Test seam: re-arm the latch so a suite can observe the warning more than once. */
export function __resetNuiBridgeWarning(): void {
  _noBridgeWarned = false;
}

// ⚠ The fallback is another resource's name, so it is only ever correct for tLib's own
// pages. A CONSUMER whose page reaches this fallback POSTs its callbacks to
// `https://tLib/<event>`, which has no such handler, and every call hangs to the
// timeout below. `??` alone did not cover that: `GetParentResourceName` can exist
// (so `isNUI()` is true and the fetch path is NOT short-circuited) and still answer
// `undefined` or `""`, and `?? ` passes an empty string straight through to the URL.
// Checked for a usable string instead, so the fallback is reached deliberately rather
// than by an empty host.
export function getResourceName(fallback = "tLib"): string {
  const name = window.GetParentResourceName?.();
  return typeof name === "string" && name !== "" ? name : fallback;
}

// A NUI callback that returns without invoking its `cb` leaves the request open
// forever: the promise never settles, so neither `.then` nor `.catch` runs and
// the caller's loading state spins for the rest of the session -- this is what
// hung tLS's Vehicle Import on "Loading...". Every callback in the consuming
// resources answers inside the same frame, so 10s (~600 frames) only ever
// catches one that was never going to answer.
export const NUI_TIMEOUT_MS = 10_000;

export type NuiFailureReason = "not-nui" | "timeout" | "network";

// `reason` separates a callback that never answered from one that errored or
// does not exist, without string-matching a message.
export class NuiError extends Error {
  readonly reason: NuiFailureReason;
  readonly event: string;

  constructor(reason: NuiFailureReason, event: string, message: string) {
    super(message);
    this.name = "NuiError";
    this.reason = reason;
    this.event = event;
  }
}

export interface FetchNuiOptions {
  /** Defaults to getResourceName(). */
  resource?: string;
  /** Non-finite or <= 0 waits forever. */
  timeout?: number;
}

// The third parameter used to be a bare `resource` string, and still is public
// API across every consuming resource.
function normaliseOptions(options?: string | FetchNuiOptions): FetchNuiOptions {
  if (typeof options === "string") return { resource: options };
  return options ?? {};
}

// AbortSignal.timeout needs Chromium 103+, which covers every current FiveM
// client -- but a missing static method would be a TypeError at call time in a
// library several resources depend on, so fall back rather than assume.
function createDeadline(ms: number): { signal?: AbortSignal; release: () => void } {
  if (!Number.isFinite(ms) || ms <= 0) return { release: () => {} };

  const timeoutSignal = (AbortSignal as { timeout?: (delay: number) => AbortSignal }).timeout;
  if (typeof timeoutSignal === "function") {
    // Self-clearing: no handle to release.
    return { signal: timeoutSignal(ms), release: () => {} };
  }

  const controller = new AbortController();
  const handle = setTimeout(
    () => controller.abort(new DOMException("timeout", "TimeoutError")),
    ms
  );
  return { signal: controller.signal, release: () => clearTimeout(handle) };
}

/**
 * Budget for one NUI -> Lua round trip, for the diagnostics timer below.
 *
 * NOT `NUI_TIMEOUT_MS`. Ten seconds is the deadline at which a callback is
 * declared NEVER COMING — a Lua handler that returned without calling its `cb`,
 * which is a bug in the handler and is already reported as a warning. This is
 * the much lower bar at which a round trip that DID answer was unacceptably
 * slow: every callback in every consuming resource answers inside the same
 * frame, so one second is ~60 frames of slack and still an order of magnitude
 * under the deadline.
 */
const NUI_ROUND_TRIP_BUDGET_MS = 1000;

// Shared transport for both public wrappers. Throws NuiError; the caller decides
// whether that surfaces as a rejection or as null.
async function requestNui<T>(
  event: string,
  data: unknown,
  options: FetchNuiOptions
): Promise<T | null> {
  // INSTRUMENTED HERE AND NOT IN `fetchNui`, deliberately: `fetchNui`
  // returns early when `isNUI()` is false, so timing it would record a dev-mode
  // no-op as a fast round trip and dilute the p95 with samples that measured
  // nothing. This function only runs when a real request is made.
  //
  // `timeNuiAsync` is a straight call-through until a page installs
  // diagnostics, so the admin panel, the gallery and the harness pay two
  // `performance.now()` calls and nothing else.
  return timeNuiAsync(`nui:${event}`, NUI_ROUND_TRIP_BUDGET_MS, () =>
    requestNuiInner<T>(event, data, options)
  );
}

async function requestNuiInner<T>(
  event: string,
  data: unknown,
  options: FetchNuiOptions
): Promise<T | null> {
  const timeout = options.timeout ?? NUI_TIMEOUT_MS;
  const deadline = createDeadline(timeout);
  try {
    const resp = await fetch(`https://${options.resource ?? getResourceName()}/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: deadline.signal,
    });
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Not a failure: a Lua handler answering with a bare cb() sends a plain body.
      return null;
    }
  } catch (err) {
    // AbortSignal.timeout raises TimeoutError, the fallback raises what abort()
    // was given, and an older engine ignores that and raises AbortError. All are
    // a timeout: nothing else here ever aborts the request.
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new NuiError(
      timedOut ? "timeout" : "network",
      event,
      timedOut
        ? `callback "${event}" did not answer within ${timeout}ms — the Lua handler most likely returned without calling its cb`
        : `callback "${event}" failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    deadline.release();
  }
}

// POSTs to the game's NUI callback endpoint, no-ops in dev. Never rejects, and
// resolves to null on any failure: ~190 call sites across tRadio, tLS,
// tDetector and tAFK are bare `fetchNui(...)` with no rejection handler, so
// rejecting would turn a hang into an unhandled-rejection storm. The deadline is
// what fixes the hang. Use fetchNuiOrThrow to distinguish the failure.
export async function fetchNui<T = unknown>(
  event: string,
  data: unknown = {},
  options?: string | FetchNuiOptions
): Promise<T | null> {
  if (!isNUI()) {
    // ONE warn, not a per-call debug, and this is the whole point of it.
    //
    // In a browser or the dev harness this branch is expected and silence is right.
    // IN GAME it means the page has no NUI bridge, so every callback it makes resolves
    // null WITHOUT BEING SENT and nothing it asks Lua will ever happen. That was
    // reported only at `console.debug`, which FiveM's F8 filters out by default — so a
    // client in this state looked like a slow or misconfigured SERVER, and a customer
    // spent ten days checking ports, convars and Lua handlers while the requests were
    // never leaving the page. The condition is now audible on the one channel that
    // still works, and once rather than ~190 times.
    if (!_noBridgeWarned) {
      _noBridgeWarned = true;
      console.warn(
        `[tLib/nui] window.GetParentResourceName is absent: every fetchNui resolves ` +
          `null without being sent (first was "${event}"). Expected in a browser or the ` +
          `dev harness. In game this page has no NUI bridge — nothing it asks Lua will ` +
          `happen, and this is not a server, address or token fault.`
      );
    }
    console.debug(`[NUI dev] fetchNui("${event}")`, data);
    return null;
  }
  try {
    return await requestNui<T>(event, data, normaliseOptions(options));
  } catch (err) {
    // A timeout is a real bug in the Lua handler; say so rather than swallow it.
    console.warn(`[tLib/nui] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// For callers that want to show an error rather than read "no answer" as "no
// data". Still resolves to null on an empty or non-JSON body: that is a
// successful call with no payload.
export async function fetchNuiOrThrow<T = unknown>(
  event: string,
  data: unknown = {},
  options?: string | FetchNuiOptions
): Promise<T | null> {
  if (!isNUI()) {
    throw new NuiError("not-nui", event, `callback "${event}" called outside of NUI`);
  }
  return requestNui<T>(event, data, normaliseOptions(options));
}

// The three SendNUIMessage shapes in use:
//   { name, args: [payload] }  cfx structured
//   { action, ... }            tRadio/tLS flat
//   { type, ... }              destroyUI and friends
export function onNuiEvent<T = unknown>(action: string, handler: (data: T) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    if (
      typeof event.data.type !== "string" &&
      typeof event.data.name !== "string" &&
      typeof event.data.action !== "string"
    )
      return;
    const msg = event.data;
    if (!msg) return;
    if (msg.name === action) {
      handler((msg.args?.[0] ?? msg) as T);
    } else if (msg.action === action) {
      handler((msg.data ?? msg) as T);
    } else if (msg.type === action) {
      handler(msg as T);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export function onAnyNuiEvent(handler: (action: string, data: unknown) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    if (
      typeof event.data.type !== "string" &&
      typeof event.data.name !== "string" &&
      typeof event.data.action !== "string"
    )
      return;
    const msg = event.data;
    if (!msg) return;
    if (msg.name) {
      handler(msg.name, msg.args?.[0] ?? msg);
    } else if (msg.action) {
      handler(msg.action, msg.data ?? msg);
    } else if (msg.type) {
      handler(msg.type, msg);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// Takes the caller's onCleanup so this file stays framework-agnostic.
export function createNuiEvent<T = unknown>(
  action: string,
  handler: (data: T) => void,
  onCleanup: (fn: () => void) => void
): void {
  onCleanup(onNuiEvent(action, handler));
}
