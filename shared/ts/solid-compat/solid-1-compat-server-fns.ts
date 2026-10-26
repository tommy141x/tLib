/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * The server-functions shim — one of five modules in this Solid 1 -> 2 compat
 * layer. See README.md for what it solves, module roles and adoption steps.
 */
/**
 * Vendor compatibility only — not reachable from `src/`. Companion to
 * solid-1-compat.ts for `@solidjs/web/server-functions/server`. Pure RC-to-RC
 * skew, not a Solid 1-vs-2 issue: `@tanstack/solid-start@2.0.0-rc.8` was built
 * against an earlier `@solidjs/web` RC where this helper was named
 * `parseServerFunctionUrl`; the installed `@solidjs/web@2.0.0-rc.13` renamed
 * it to `parseServerFunctionActionUrl` with an identical implementation. This
 * is a straight rename-back, not a reimplementation.
 *
 * Uses the `virtual:solid-1-compat-real/*` bypass for its own import of the
 * real package — see README.md § "Why the shims import
 * virtual:solid-1-compat-real/*".
 */
export * from "virtual:solid-1-compat-real/@solidjs/web/server-functions/server";
export { parseServerFunctionActionUrl as parseServerFunctionUrl } from "virtual:solid-1-compat-real/@solidjs/web/server-functions/server";
