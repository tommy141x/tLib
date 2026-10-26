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
 * BOTH names must come from the shim, not from the real package.
 * `@tanstack/solid-virtual` imports `{ createStore, reconcile }` only from this
 * subpath, so a wrapper defined in `solid-1-compat.ts` but not re-exported here
 * is never reached — and re-exporting the real `reconcile` hands its Solid 1
 * options object to Solid 2 as the key, throwing `TypeError: keyFn is not a
 * function` inside a store setter inside a tracked callback.
 */
export { createStore, reconcile } from "./solid-1-compat";
