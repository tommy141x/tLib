/**
 * Turning a caught `unknown` into something a customer can paste back — and,
 * now, into something the transport can send without a customer involved.
 *
 * Provenance
 *
 * This was `tRadio/shared/ui/src/error-report.ts`. It moved here whole because
 * it was already one hop from a telemetry payload: it normalises a throw into
 * `name`/`message`/`stack`/`causes` and pairs it with a context carrying
 * `surface`, `location`, `version` and `panelVersion`. tRadio's two render
 * boundaries still use it, now across the `@tlib/shared` alias, and the copy
 * that was in tRadio is gone rather than re-exported.
 *
 * ONE BEHAVIOUR CHANGED IN THE MOVE, deliberately: redaction is now
 * `scrub()` rather than `redactSecrets()` alone, so a home-directory path and
 * any value the host registered as the player's are blanked as well. That is
 * strictly more redaction in the pasteable report too, and it should be: a
 * pasted `C:\Users\<their real name>\...` leaks the player's Windows account to
 * a Discord channel. Nothing that was readable before became unreadable — the
 * path rule replaces only the home segment, not the path.
 *
 * Why the original exists at all
 *
 * Both of tRadio's frontends wrap their render tree in a Solid error boundary,
 * and both used to render the error with `String(err)` (admin) or `err?.message`
 * (NUI) — which throws away the error NAME, the STACK and every scrap of
 * context about where it happened. BUG-68735 ("admin panel replaceChild render
 * crash") was blocked on exactly that: the report said "a render error appeared"
 * and nothing more, so the affected page, the preceding action and the first
 * caught exception were all unavailable and no fix could be selected.
 *
 * `String(err)` is lossy in three specific ways worth spelling out:
 *   - `String(new TypeError("x"))` is `"TypeError: x"` but drops `.stack`, which
 *     is the only part that names the component and the Solid internal frame.
 *   - `String({})` is `"[object Object]"`. A thrown non-Error — common from
 *     rejected `fetch` wrappers — becomes literally no information.
 *   - a wrapped error's `.cause` is never shown, so the underlying failure is
 *     invisible behind a generic "failed to apply settings".
 *
 * That last one is neither hypothetical nor optional, but the reason has
 * changed, so read it as history and not as current behaviour.
 *
 * MEASURED against solid-js 1.9.15: `handleError` wrapped a thrown non-Error as
 * `new Error("Unknown error", { cause: thrown })` before any error boundary
 * fallback saw it, so `String(err)` on a thrown object rendered the literal
 * text "Error: Unknown error" — strictly worse than `[object Object]` — and the
 * payload was reachable ONLY through `.cause`.
 *
 * RE-MEASURED against solid-js 2.0.0-rc.14 (2026-10-13), the renderer tRadio
 * ships on: `<Errored>` passes the thrown value to its fallback BY IDENTITY.
 * `err() === thrown` for a plain object, `instanceof Error` is false, `.cause`
 * is undefined, and `String(err)` is back to `[object Object]`. A real `Error`
 * is likewise passed through untouched with its own `.cause` intact. So the
 * wrapper no longer rescues a non-Error throw — `describeNonError` below is
 * what does — and the `.cause` walk now only ever carries causes the thrower
 * actually set. Both still matter; neither is for the reason above any more.
 */

import { scrub } from "./scrub";

/** A caught `unknown`, flattened into the fields a bug report needs. */
export interface ErrorReport {
  /** `err.constructor.name` where available, else a description of the shape. */
  name: string;
  /** Scrubbed `err.message`, or the stringified value for a non-Error throw. */
  message: string;
  /** Scrubbed `err.stack`, when the runtime provided one. */
  stack?: string;
  /** One line per `.cause` hop, outermost first. Capped — see MAX_CAUSE_DEPTH. */
  causes: string[];
}

/** Context the boundary knows and the error does not. */
export interface ErrorContext {
  /** Where the boundary lives, e.g. "admin" or "nui". */
  surface: string;
  /** What was mounted under it, e.g. the admin page id. */
  location?: string;
  /** Build identity, so a stale bundle is visible in the paste itself. */
  version?: string;
  /**
   * The build of the code that actually threw, when it can differ from `version`.
   *
   * `version` is the SERVER's. The two diverge: tRadio's desktop app ships its own
   * panel bundle (`frontendDist` in tauri.conf.json), which is why its dispatch header
   * has a mismatch badge at all. Without this field a pasted report cannot say which
   * panel build crashed — and a renderer migration makes that the first question anyone
   * asks, because the answer decides whether the reported mechanism still exists.
   */
  panelVersion?: string;
}

/** A wrapped error can in principle cycle; stop rather than hang the fallback. */
const MAX_CAUSE_DEPTH = 4;

/** Keep a pasted report to something a chat client will not truncate. */
export const MAX_STACK_CHARS = 4000;

const isError = (v: unknown): v is Error =>
  v instanceof Error || (typeof v === "object" && v !== null && "message" in v && "name" in v);

/** Best-effort one-line description of a value that is not an Error. */
function describeNonError(err: unknown): { name: string; message: string } {
  if (err === null) return { name: "ThrownNull", message: "null" };
  if (err === undefined) return { name: "ThrownUndefined", message: "undefined" };
  if (typeof err === "string") return { name: "ThrownString", message: err };
  if (typeof err !== "object") return { name: `Thrown${typeof err}`, message: String(err) };
  // `String({})` is "[object Object]", which is why this path exists at all.
  let serialised: string;
  try {
    serialised = JSON.stringify(err) ?? String(err);
  } catch {
    serialised = String(err);
  }
  return {
    name: err.constructor?.name ? `Thrown${err.constructor.name}` : "ThrownObject",
    message: serialised,
  };
}

/** Flatten a caught `unknown` into scrubbed, displayable fields. */
export function describeError(err: unknown): ErrorReport {
  const causes: string[] = [];
  let cursor: unknown = isError(err) ? (err as { cause?: unknown }).cause : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor != null; depth += 1) {
    const inner = isError(cursor)
      ? `${(cursor as Error).name}: ${(cursor as Error).message}`
      : describeNonError(cursor).message;
    causes.push(scrub(inner));
    cursor = isError(cursor) ? (cursor as { cause?: unknown }).cause : undefined;
  }

  if (!isError(err)) {
    const { name, message } = describeNonError(err);
    return { name, message: scrub(message), causes };
  }

  const e = err as Error;
  const stack = typeof e.stack === "string" && e.stack.length > 0 ? e.stack : undefined;
  return {
    name: e.name || "Error",
    message: scrub(e.message || "(no message)"),
    stack: stack ? scrub(stack).slice(0, MAX_STACK_CHARS) : undefined,
    causes,
  };
}

/**
 * The copyable block. Plain text on purpose — it is pasted into Discord or a
 * board card, where markdown tables and ANSI colour do not survive.
 *
 * The two version labels are `serverVersion:` and `panelVersion:`, and that
 * is deliberate rather than verbose: a bare `version:` is ambiguous when both
 * exist, and the whole point of carrying both is that a reader can tell them
 * apart. A suite pins both labels.
 */
export function formatErrorReport(report: ErrorReport, ctx: ErrorContext): string {
  const lines = [`surface: ${ctx.surface}`, `location: ${ctx.location ?? "(unknown)"}`];
  if (ctx.version) lines.push(`serverVersion: ${ctx.version}`);
  if (ctx.panelVersion) lines.push(`panelVersion: ${ctx.panelVersion}`);
  lines.push(
    `when: ${new Date().toISOString()}`,
    `userAgent: ${typeof navigator === "undefined" ? "(n/a)" : navigator.userAgent}`,
    "",
    `${report.name}: ${report.message}`
  );
  for (const c of report.causes) lines.push(`caused by: ${c}`);
  if (report.stack) {
    lines.push("", report.stack);
  } else {
    lines.push("", "(no stack — the runtime did not attach one to this throw)");
  }
  return lines.join("\n");
}
