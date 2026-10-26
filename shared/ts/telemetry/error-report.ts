/**
 * Turns a caught `unknown` into something pasteable, and into something
 * telemetry can send unattended.
 *
 * Redaction is `scrub()`, not `redactSecrets()` alone, so a home-directory path
 * and any host-registered player value are blanked too: a pasted
 * `C:\Users\<name>\...` leaks a Windows account to Discord.
 *
 * Against solid-js 2.0.0-rc.14 (tRadio's shipped renderer): `<Errored>` passes
 * a thrown value to its fallback by identity — a non-Error stays a non-Error,
 * `String(err)` on a plain object is `"[object Object]"`, and `.cause` is
 * whatever the thrower actually set. `describeNonError` below is what rescues
 * the non-Error case now.
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
   * The build of the code that actually threw, when it can differ from
   * `version` (the server's). tRadio's desktop app ships its own panel bundle
   * (`frontendDist` in tauri.conf.json) — why its dispatch header has a
   * mismatch badge — and without this field a pasted report can't say which
   * panel build crashed.
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
 * The version labels are `serverVersion:` and `panelVersion:`, both spelled out
 * because a bare `version:` is ambiguous when both exist. A suite pins both.
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
