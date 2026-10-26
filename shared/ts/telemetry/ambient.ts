/**
 * The NUI timer that shared code can reach without being handed a handle.
 * `installDiagnostics`'s own handle is the wrong shape inside `shared/ts/`:
 * `nui.ts` is imported by every bundle and has nothing to be handed, and it
 * can't import `collect.ts` since `collect.ts` imports it (a cycle). So the
 * recorder is registered here and both sides import this leaf instead.
 *
 * A no-op until registered, not a fallback: several bundles (admin panel,
 * component gallery, NUI harness, every unit test) legitimately never install
 * diagnostics, and `timeNui` must still be a straight call-through for them —
 * otherwise a shared module can't be instrumented unless every consumer opts
 * in, which in practice means never. Cost of the no-op is two
 * `performance.now()` calls and a branch.
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
