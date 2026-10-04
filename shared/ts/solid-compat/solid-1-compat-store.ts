/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE `solid-js/store` SHIM
 *
 * One shared copy, kept in tLib and consumed by five projects. `README.md` in
 * this directory documents the layer as a whole: what it solves, what each of
 * the five modules does, how a project adopts it, what `vendorPackages` is for
 * and how to derive one, and the debug environment variables. Read that first.
 *
 * ── TWO CONVENTIONS HOLD THROUGHOUT THESE FILES ──────────────────────────
 *
 *  · EVERY CLAIM WITH A NUMBER BEHIND IT IS A MEASUREMENT, and the number is
 *    the reason the code below is the shape it is. Several of them record
 *    failures that were expensive to diagnose and are silent when they recur.
 *    Re-measure before changing the code a number justifies; do not delete the
 *    number because the prose around it reads as history.
 *  · A MEASUREMENT IS STATED AT THE SCOPE IT WAS TAKEN AT. "Across the
 *    supported set" means every consumer's installed `node_modules` tree. A
 *    claim about `src/` is a claim about the consuming project's own `src/`,
 *    and a named project appears as the EVIDENCE for a claim, never as its
 *    subject. Re-measure at the union of all consumers before inheriting a
 *    conclusion into this shared copy.
 *
 * ── FORMATTING ─────────────────────────────────────────────────────
 *
 * `tLib/biome.json` excludes this directory, deliberately. biome and the
 * consumers' formatter (oxfmt, via `vp fmt`) disagree on import order and line
 * breaking here — measured, biome wants to rewrite all seven files — and the
 * churn would bury the annotations that are the only record of why each shim
 * is the shape it is.
 *
 * ⚠️ NOTHING FORMATS OR LINTS THIS DIRECTORY TODAY, AND THAT IS A GAP RATHER
 * THAN A DESIGN. Measured: every consumer's `fmt`/`lint` script names only its
 * own `src` and configs, and `vp fmt` refuses a path containing `..`, so a
 * consumer cannot point it here even by hand. Match the surrounding style when
 * you edit, and do not assume a green `vp fmt --check` in a consumer says
 * anything about these files. See README.md § Formatting.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * VENDOR COMPATIBILITY ONLY. Not reachable from `src/`.
 *
 * Companion to solid-1-compat.ts for the `solid-js/store` subpath, which no
 * longer exists in 2.0 (store APIs moved into the main `solid-js` package).
 * Vendor code importing `{ createStore, reconcile } from "solid-js/store"`
 * redirects here and gets the same legacy-call-shape-compatible `createStore`
 * as everything importing from bare `solid-js` (see solid-1-compat.ts).
 *
 * ── ⚠️ NO `produce` RE-EXPORT, AND IT IS NOT AN OVERSIGHT ────────────────────
 *
 * There was one. It is gone because the `produce`
 * shim it re-exported is gone: see the block comment where `produce`/`isProducer`
 * used to be in solid-1-compat.ts for why (the mutation form IS the native
 * setter in 2.0, so the wrapper was an identity function, and both of its
 * supposed consumers turned out to be imaginary).
 *
 * Re-measured here rather than inherited from that file's argument, because
 * this is the subpath a `produce` consumer would actually import from. Measured
 * across the supported set:
 *
 *  · VENDORS. Exactly ONE file under the whole `VENDOR_PACKAGES` set mentions
 *    `solid-js/store` at all — `@tanstack/solid-virtual/src/index.tsx:18` — and
 *    it imports `{ createStore, reconcile }`. No vendor file imports `produce`
 *    from this subpath, and none mentions `isProducer`.
 *  · OURS. `src/` does not reach this file by construction (the resolve-time
 *    throw in solid-1-compat-plugin.ts), and has no `produce` call site either:
 *    the last one, `theme-editor/editor.tsx`, now passes a bare draft mutator
 *    and carries its own `migration.txt` citation for why.
 *
 * The two names below are therefore the complete set of what anything actually
 * asks this module for. Re-adding a third is one line, and should be done when
 * a consumer appears rather than in anticipation of one.
 */
export { createStore } from "./solid-1-compat";
/**
 * ⚠️ `reconcile` COMES FROM REAL SOLID 2, NOT FROM THE SHIM, AND THE SPELLING
 * MATTERS EVEN THOUGH BOTH WOULD RUN.
 *
 * It used to be on the line above, beside `createStore`. `solid-1-compat.ts` does
 * not DEFINE a `reconcile` — the name only resolved because that file does
 * `export * from` the real package, so it was passing straight through anyway.
 * `tsc` reports that as TS2305 ("Module './solid-1-compat' has no exported member
 * 'reconcile'"); the bundler does not, because a wildcard re-export satisfies it.
 * So this is a real defect that only one of the two gates can see — keep the
 * two spellings distinct here, and run a consumer's `tsc --noEmit` and not only
 * its build after touching this file.
 *
 * Solid 2 kept `reconcile` with the same semantics and simply moved it from
 * `solid-js/store` into `solid-js` core, so the real one is the correct thing to
 * hand back — there is nothing for the shim to adapt. See the block comment where
 * a `reconcile` wrapper used to be in solid-1-compat.ts for the measurement that
 * retired it (measured across every consumer's installed tree: no vendor passes
 * a second argument at all).
 */
export { reconcile } from "virtual:solid-1-compat-real/solid-js";
