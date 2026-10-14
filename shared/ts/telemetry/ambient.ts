/**
 * The NUI timer that shared code can reach without being handed a handle.
 *
 * Why this module exists at all
 *
 * `installDiagnostics` returns a handle, and that is the right shape for a
 * resource's own call sites. It is the wrong shape for code INSIDE
 * `shared/ts/`: `nui.ts` is imported by every bundle in this estate and has no
 * way to be handed anything, and it cannot import `collect.ts` because
 * `collect.ts` imports IT — a cycle, which bun's bundler resolves by evaluating
 * one of them half-initialised.
 *
 * So the recorder is registered here, and both sides import this leaf. It has
 * no imports of its own beyond `timed.ts`.
 *
 * A NO-OP UNTIL REGISTERED, AND THAT IS NOT A FALLBACK
 *
 * Several bundles in this tree legitimately never install diagnostics — the
 * admin panel, the component gallery, the NUI harness, every unit test. For
 * those, `timeNui` must be a straight call-through: not a buffered sample, not a
 * queued report, not a thrown error. The alternative is that a shared module
 * cannot be instrumented at all unless every consumer of it opts in, which in
 * practice means it is never instrumented.
 *
 * The cost of the no-op is two `performance.now()` calls and a branch, on
 * paths that were chosen because they are measured in tens of milliseconds.
 */

import type { TimedOutlier, Timers } from "./timed";

let timers: Timers | null = null;

/** Called once by `installDiagnostics`. Last writer wins. */
export function registerAmbientTimers(next: Timers | null): void {
  timers = next;
}

/** `true` when diagnostics are installed in this page. For a suite's benefit. */
export function hasAmbientTimers(): boolean {
  return timers !== null;
}

/**
 * Time an async operation, reporting only outliers.
 *
 * `try/finally`, so a REJECTING call is still timed. The slowest operation on
 * a machine in trouble is frequently the one that then fails, and a timer that
 * only recorded successes would miss exactly that.
 */
export async function timeNuiAsync<T>(
  operation: string,
  thresholdMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const t = timers;
  if (!t) return fn();
  return t.timedAsync(operation, thresholdMs, fn);
}

/** The synchronous form. */
export function timeNui<T>(operation: string, thresholdMs: number, fn: () => T): T {
  const t = timers;
  if (!t) return fn();
  return t.timed(operation, thresholdMs, fn);
}

/** Record a duration measured somewhere else. */
export function recordNui(operation: string, thresholdMs: number, durationMs: number): void {
  timers?.record(operation, thresholdMs, durationMs);
}

export type { TimedOutlier };
