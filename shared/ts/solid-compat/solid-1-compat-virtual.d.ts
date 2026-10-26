/*
 * Types for the `virtual:` specifiers — one of five modules in this Solid 1
 * -> 2 compat layer. See README.md for what it solves and module roles. This
 * file is ambient declarations only; it emits nothing and is not bundled.
 */
/**
 * `virtual:solid-1-compat-real/*` are synthetic ids `solid-1-compat-plugin.ts`
 * resolves itself with a plain `require.resolve`. Without this file `tsc`
 * reports `TS2307: Cannot find module '...'` ten times across the four shim
 * modules (9 of 10 of one consumer's `tsc --noEmit` baseline errors), so it
 * ships alongside the shims rather than per-project. Each shim carries a
 * `/// <reference path>` to this, since a consumer's tsconfig `include` names
 * only its own `src`.
 *
 * Deliberately the shorthand (body-less) form, not `declare module "..." {
 * export * from "solid-js"; }`: this file lives in tLib, where
 * `shared/ts/node_modules/solid-js` is 1.9.12, so the precise form would type
 * a Solid-2 shim against Solid 1's declarations. The shorthand is typed `any`
 * wholesale — `tsc` no longer checks shim bodies against the real Solid 2
 * surface (a typo is caught by the build instead, rolldown's `"X" is not
 * exported by ...`). A consumer wanting the stronger check can add precise
 * declarations in its own tree; TypeScript prefers an exact match over the
 * wildcard, so the two coexist. A body-FUL wildcard also can't export `*`
 * (TS2498) or named members (TS2305 per member), so it must stay body-less.
 *
 * `virtual:solid-1-compat-real/solid-js` legitimately exports `sharedConfig`,
 * which `solid-js`'s own `.d.ts` does not declare though every runtime build
 * exports it — `solid-1-compat-web.ts` reads it from core rather than
 * `@solidjs/web`, whose client production build omits it (MISSING_EXPORT).
 *
 * Do not "fix" a TS2307 by dropping the shims from a tsconfig's `include` —
 * they are ~2,000 lines of load-bearing logic that would then ship untyped.
 */
declare module "virtual:solid-1-compat-real/*";
