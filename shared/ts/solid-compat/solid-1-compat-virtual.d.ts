/*
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  TYPES FOR THE `virtual:` SPECIFIERS
 *
 * One shared copy, kept in tLib and consumed by five projects. `README.md` in
 * this directory documents the layer as a whole: what it solves, what each of
 * the five modules does, how a project adopts it, what `vendorPackages` is for
 * and how to derive one, and the debug environment variables. Read that first.
 *
 * This file is ambient declarations only — it emits nothing and is the one file
 * here that is not bundled into a consumer's output. The two conventions and
 * the formatting note in the sibling modules' banners apply to it too.
 */
/**
 * Types for the `virtual:solid-1-compat-real/*` specifiers.
 *
 * Those are synthetic module ids that `solid-1-compat-plugin.ts` resolves itself,
 * with a plain `require.resolve`, specifically to bypass the plugin resolution
 * chain — read that file's header for the Vitest-only empty-module bug that made
 * the bypass necessary. Being synthetic, they exist only at build time: `tsc` has
 * nothing to resolve and reports
 *
 *   TS2307: Cannot find module 'virtual:solid-1-compat-real/solid-js'
 *
 * ten times across the four shim modules. A consumer that lacked this file was
 * measured carrying 9 of those 10 as 9 of the 16 errors in its `tsc --noEmit`
 * baseline — shipping this file alongside the shims fixes it for every
 * consumer, and is why it lives here rather than in each project.
 *
 * EACH OF THE FOUR SHIM FILES CARRIES A `/// <reference path>` TO THIS
 *
 * An ambient declaration only applies if its file is part of the program, and a
 * consumer's tsconfig `include` is its own `src` — it has no reason to name a
 * file inside tLib. The triple-slash reference is what pulls this into the
 * program wherever one of the shims is reached, rather than asking four separate
 * projects to each add a path to their `include`.
 *
 * THE SHORTHAND (BODY-LESS) FORM, AND THAT IS A CONSEQUENCE OF SHARING
 *
 * The richer form declares each virtual id AS the real package it stands for:
 *
 *   declare module "virtual:solid-1-compat-real/solid-js" { export * from "solid-js"; }
 *
 * That is strictly better where it works: the whole point of the bypass is that
 * these resolve to the genuine `solid-js`/`@solidjs/web`, so re-exporting their
 * types is accurate rather than convenient, and it keeps the shims themselves
 * typechecked against the real surface they wrap.
 *
 * IT CANNOT WORK FROM A SHARED LOCATION, MEASURED. TypeScript resolves
 * `"solid-js"` relative to the file containing the declaration, and this file
 * lives in tLib, where `shared/ts/node_modules/solid-js` is **1.9.12** — tLib's
 * own UI and every t* resource are deliberately still on Solid 1.9.x. So the
 * precise form would type a Solid-2 shim against Solid 1's declarations and
 * report errors that say nothing about the consumer's actual toolchain. A
 * shorthand ambient module is typed `any` wholesale, which depends on nothing
 * outside this file.
 *
 * WHAT THAT COSTS, SAID PLAINLY: `tsc` no longer checks the shim bodies
 * against the real Solid 2 surface. A typo in a re-exported name here is caught
 * by the BUILD (rolldown reports `"X" is not exported by …`) and not by the
 * typechecker. A consumer that wants the stronger check back can add the precise
 * exact-match declarations in its OWN tree — TypeScript prefers an exact ambient
 * module match over a wildcard pattern, so the two coexist with no conflict.
 * A consumer doing this keeps its own `vite/solid-1-compat-virtual.d.ts`
 * alongside its `vite/solid-compat-vendors.ts`; one of the five does today.
 *
 * AND IT MUST BE THE BODY-LESS FORM SPECIFICALLY. A wildcard module WITH a
 * body has to enumerate its exports, so `export * from` and every named import
 * fail (TS2498 "uses 'export =' and cannot be used with 'export *'", then TS2305
 * per member).
 *
 * ONE PIECE OF KNOWLEDGE THE PRECISE VERSION CARRIED, PRESERVED AS PROSE
 *
 * `virtual:solid-1-compat-real/solid-js` legitimately exports `sharedConfig`,
 * though `solid-js`'s own `.d.ts` does not declare it (`grep -c sharedConfig
 * node_modules/solid-js/types/index.d.ts` is 0, and so is @solidjs/web's) while
 * every runtime build does export it. `solid-1-compat-web.ts` reads
 * `sharedConfig.hydrating` and takes the flag from core rather than from
 * `@solidjs/web` because @solidjs/web's CLIENT PRODUCTION build (`dist/web.js`)
 * does not export it, which fails `bun run build` with MISSING_EXPORT.
 *
 * Do NOT "fix" a TS2307 here by dropping the shims from a tsconfig's
 * `include`. These files are ~2,000 lines of load-bearing compatibility logic;
 * leaving them untypechecked is how a typo in one ships.
 */
declare module "virtual:solid-1-compat-real/*";
