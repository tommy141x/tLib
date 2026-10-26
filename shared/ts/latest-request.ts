/**
 * "Only the newest in-flight request may touch anything" — one async fence,
 * behind tLS's `createHudRequest` and tDetector/tRadar's
 * `createLatestLayoutRequest`.
 *
 * `AbortController` alone is not sufficient: abort is best-effort and races —
 * `fetch` can already have resolved, or be mid-`.json()`, when `abort()`
 * lands, and the continuation then writes a stale value into the live DOM.
 * The generation check fences that because it's evaluated *after* the await,
 * not signalled before it; the controller stays as an optimisation (frees the
 * socket) layered on top, not the fence itself.
 *
 * `pending` is cleared only by the winner: a superseded request's `finally`
 * runs while its replacement is still loading, so an unguarded `pending =
 * false` would flicker a bound spinner off and read as idle while work is
 * outstanding.
 *
 * A→B→A needs request identity, not a name: callers are skin/layout loaders
 * where a user can go back to the skin they started on, so keying on a name
 * would let a stale A response pass as the newest A. Each `run` takes a fresh
 * monotonic number instead.
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
    fail: () => void
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
      fail: () => void
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
      // Bumping the generation retires requests already awaiting: `disposed`
      // alone would cover `apply`/`fail`, but the `finally` guard is
      // deliberately not disposal-aware so `pending` settles to false exactly
      // once, for all of them.
      generation++;
      controller?.abort();
      pending = false;
    },
  };
}
