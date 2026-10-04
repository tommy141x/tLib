/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE SERVER-FUNCTIONS SHIM
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
 * Companion to solid-1-compat.ts for
 * `@solidjs/web/server-functions/server`. This is pure RC-to-RC skew, not
 * a Solid 1-vs-2 issue: `@tanstack/solid-start@2.0.0-rc.8` was built against
 * an earlier `@solidjs/web` RC where this helper was named
 * `parseServerFunctionUrl`; our installed `@solidjs/web@2.0.0-rc.13` renamed
 * it to `parseServerFunctionActionUrl` with an identical implementation
 * (confirmed by diffing both RCs' compiled output — same body, same
 * behavior). Restoring the old name here is a straight rename-back, not a
 * reimplementation.
 *
 * Uses the `virtual:solid-1-compat-real/*` bypass for its own import of the
 * real package — see solid-1-compat.ts's header and
 * solid-1-compat-plugin.ts's for why a plain bare import breaks here.
 */
export * from "virtual:solid-1-compat-real/@solidjs/web/server-functions/server";
export { parseServerFunctionActionUrl as parseServerFunctionUrl } from "virtual:solid-1-compat-real/@solidjs/web/server-functions/server";
