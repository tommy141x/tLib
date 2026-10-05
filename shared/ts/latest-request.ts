/**
 * "Only the newest in-flight request may touch anything" — one async fence.
 *
 * Three resources had arrived at this independently and identically: tELS as
 * `createHudRequest`, tDetector and tRadar as `createLatestLayoutRequest`. The
 * three bodies differed only in the nouns (`epoch`/`generation`,
 * `abort`/`controller`) and in how the comment above them was worded, so there
 * was nothing resource-specific to preserve — only three places to fix the next
 * time the fence turns out to be wrong.
 *
 * ── Why a generation counter and not just AbortController ──
 *
 * `AbortController` is the obvious tool and it is not sufficient. Abort is
 * best-effort and it races: `fetch` can already have resolved, or be between
 * resolving the response and resolving `.json()`, when `abort()` lands. The
 * continuation then runs with a perfectly good value from a request nobody
 * wants any more, and writes it into the live DOM or re-subscribes callbacks
 * that belong to the previous skin. The generation check is what actually
 * fences that, because it is evaluated *after* the await rather than signalled
 * before it. The controller is still here, because aborting also stops the
 * transfer and frees the socket — it is an optimisation layered on the fence,
 * not the fence.
 *
 * ── Why `pending` is cleared only by the winner ──
 *
 * A superseded request settling must not report "idle": its `finally` runs
 * while the request that replaced it is still loading. Guarding the clear with
 * the same generation check keeps `pending` true for exactly as long as some
 * request the caller still cares about is in flight, which is what a spinner
 * bound to it needs. An unguarded `pending = false` makes the spinner flicker
 * off and on again on every supersede, and — worse — reads as idle while work
 * is outstanding.
 *
 * ── Why A→B→A needs request identity ──
 *
 * The callers are skin/layout loaders, and a user can go back to the skin they
 * started on. Keying the fence on a *name* would let the stale A response pass
 * as the newest A. Each `run` therefore takes a fresh monotonic number, so the
 * identity being compared is the request's, never the payload's.
 */

export interface LatestRequest {
  /** True while a request the caller still cares about is in flight. */
  readonly pending: boolean;
  /**
   * Start a request, superseding any earlier one.
   *
   * `apply` runs only if this call is still the newest and the instance is not
   * disposed; `fail` runs under the same condition when `load` rejects. Neither
   * runs for a superseded request, however it settles.
   */
  run<T>(
    load: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    fail: () => void,
  ): Promise<void>;
  /**
   * Retire the instance: nothing in flight may commit, and no later `run` may
   * either. Call this on unmount — a resolved body cannot be un-resolved, so
   * the only safe thing is to refuse to act on it.
   */
  dispose(): void;
}

export function createLatestRequest(): LatestRequest {
  let generation = 0;
  let controller: AbortController | undefined;
  let pending = false;
  let disposed = false;

  return {
    get pending() {
      return pending;
    },

    async run<T>(
      load: (signal: AbortSignal) => Promise<T>,
      apply: (value: T) => void,
      fail: () => void,
    ) {
      if (disposed) return;
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      pending = true;
      try {
        const value = await load(controller.signal);
        if (!disposed && request === generation) apply(value);
      } catch {
        if (!disposed && request === generation) fail();
      } finally {
        if (request === generation) pending = false;
      }
    },

    dispose() {
      disposed = true;
      // Bumping the generation is what retires the requests already awaiting:
      // `disposed` alone would be enough for `apply`/`fail`, but the `finally`
      // guard is deliberately *not* disposal-aware so that `pending` settles to
      // false exactly once. Moving the generation past every outstanding
      // request is what makes that guard fail for all of them.
      generation++;
      controller?.abort();
      pending = false;
    },
  };
}
