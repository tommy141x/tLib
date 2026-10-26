/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * The `solid-js/store` shim — one of five modules in this Solid 1 -> 2 compat
 * layer. See README.md for what it solves, module roles and adoption steps.
 */
/**
 * Vendor compatibility only — not reachable from `src/`. Companion to
 * solid-1-compat.ts for the `solid-js/store` subpath, which no longer exists
 * in 2.0 (store APIs moved into `solid-js` core). `{ createStore, reconcile }`
 * imported from here get the same legacy-call-shape-compatible versions as
 * bare `solid-js` (see solid-1-compat.ts).
 *
 * No `produce` re-export: its shim was removed from solid-1-compat.ts once
 * both its supposed consumers turned out to be imaginary (counted per-name
 * across the vendor tree and `src/`; see that file's tombstone). This is the
 * only subpath a `produce` consumer could import from, so the count was
 * re-run here specifically rather than inherited.
 */
/**
 * Both names come from the shim, not real `solid-js/store` — `reconcile`
 * re-exporting the real one was reverted once `@tanstack/solid-virtual`
 * started calling `reconcile(items, { key: "index" })`: Solid 2 reads that
 * second argument as the key itself, so the options object reaches the diff
 * walk and gets called, throwing `TypeError: keyFn is not a function` inside
 * a store setter inside a tracked callback. `@tanstack/solid-virtual` imports
 * `{ createStore, reconcile }` only from this subpath, so a wrapper defined
 * in `solid-1-compat.ts` but not re-exported here is never reached — see that
 * file's `reconcile` block for the fix.
 */
export { createStore, reconcile } from "./solid-1-compat";
