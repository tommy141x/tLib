/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE VITE PLUGIN (the layer's only entry point)
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
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
/*
 * ── ⚠️ NO `import type { Plugin } from "vite"`, AND THAT IS NOT A PREFERENCE ──
 *
 * It was that while this file lived inside each project, beside that project's
 * own `vite`. From a SHARED location the import
 * resolves against whatever `vite` is reachable from THIS directory — tLib's
 * `shared/ts/node_modules/vite` — which is a different package instance from the
 * `vite-plus` the consumers build with.
 *
 * ⛔ MEASURED. With `Plugin` imported from tLib's `vite`, a consumer's
 * `tsc --noEmit` reported, at the `defineConfig({...})` call and not at this
 * file:
 *
 *   vite.config.ts(122,16): error TS2321: Excessive stack depth comparing types
 *   '{ resolve: …; plugins: (PluginOption[] …' and 'ViteUserConfigExport'
 *
 * i.e. TypeScript gave up structurally comparing two independently-installed
 * copies of the same enormous type. The error names neither this file nor the
 * two packages, which is the whole reason this comment is this long.
 *
 * So the contract is declared HERE, as the exact subset of the plugin interface
 * this file implements. Vite's `Plugin` is structural, so a consumer's
 * `plugins: [...]` accepts this with no cast and no `as Plugin`, and the shape
 * is checked against this declaration rather than against nothing.
 */
interface CompatShimPlugin {
  name: string;
  enforce: "pre";
  /**
   * ⚠️ `plugins` IS READ ONLY TO CHECK ORDER, and it is declared as the narrowest
   * shape that permits that — a list of things that may have a name. Vite's own
   * `ResolvedConfig["plugins"]` is a `readonly Plugin[]`, so the structural match
   * holds, and widening this to the real type would reintroduce exactly the
   * two-copies-of-an-enormous-type error this interface exists to avoid.
   */
  configResolved(config: {
    isProduction: boolean;
    root: string;
    plugins?: readonly ({ name?: string } | null | undefined)[];
  }): void;
  resolveId(
    this: {
      resolve(
        source: string,
        importer?: string,
        options?: { skipSelf?: boolean },
      ): Promise<{ id: string } | null>;
    },
    source: string,
    importer: string | undefined,
    options: { ssr?: boolean },
    // `{ id }` as well as a bare string: the `virtual:solid-1-compat-real/*`
    // branch hands back whatever `this.resolve` returned, which is an object.
  ): Promise<string | { id: string } | null>;
}

/**
 * THE LAYER'S ENTRY POINT. A Vite `resolveId` plugin that lets vendor packages
 * built for Solid 1 run on Solid 2 without patching them.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 * Redirects `solid-js`, `solid-js/web`, `solid-js/store` and
 * `@solidjs/web/server-functions/server` to the sibling shim modules, which
 * restore the Solid 1.x names and call shapes 2.0 renamed or removed (`onMount`,
 * `splitProps`, `mergeProps`, `Index`, the `on()` helper, single-arg
 * `createEffect`, the legacy multi-arg `createStore` setter, `use()`), plus one
 * RC-to-RC rename (`parseServerFunctionUrl`) between `@tanstack/solid-start`
 * and the installed `@solidjs/web`.
 *
 * ── WHAT IT GUARANTEES ──────────────────────────────────────────────────────
 *
 *  1. THE REDIRECT IS SCOPED TO VENDOR CODE. A specifier is rewritten only when
 *     the importing module lives under one of the `vendorPackages` trees,
 *     matched on the importer's absolute path against
 *     `node_modules/<pkg>/`. Everything else — application `src/` above all —
 *     resolves to the real Solid 2 packages untouched.
 *  2. APPLICATION CODE CANNOT REACH THE SHIMS. Importing a shim module from
 *     outside a vendor tree is a THROW at resolve time, not a warning: see the
 *     error below. Application code is expected to be native Solid 2.
 *  3. ONE REACTIVE RUNTIME. The shims obtain the real packages through the
 *     `virtual:solid-1-compat-real/*` specifiers this plugin resolves itself,
 *     against the CONSUMER's root — never against tLib, which is still on
 *     Solid 1. Two instances of the Solid runtime in one graph is the hazard
 *     the whole file is arranged to prevent.
 *
 * ── HOW TO USE IT ───────────────────────────────────────────────────────────
 *
 *     import { solid1CompatShim } from "<path>/solid-1-compat-plugin";
 *     import { VENDOR_PACKAGES } from "<path>/solid-compat-vendors";
 *
 *     plugins: [solid1CompatShim({ vendorPackages: VENDOR_PACKAGES }), …]
 *
 * It must come FIRST in `plugins`, and `optimizeDeps.exclude` must list
 * `solid-js`, `@solidjs/web` and every vendor package. README.md § Adopting it
 * gives the full recipe and says what each omission looks like when it fails.
 *
 * Use it from vite.config.ts AND vitest.config.ts. Those two normally disagree
 * on most plugins, but both resolve through the same `node_modules`, so both
 * need this one.
 *
 * ── THE SELF-REFERENCE BUG, AND WHY THE SHIMS IMPORT
 *    `virtual:solid-1-compat-real/*` INSTEAD OF THE BARE PACKAGE NAME ───────
 *
 * The shim files need the REAL `solid-js`/`@solidjs/web` to build their
 * compat surface on top of. The obvious way to get it — have them `import
 * ... from "solid-js"` like anything else, and have this plugin's
 * `resolveId` recognize its OWN shim files as importers and `return null`
 * (defer to normal resolution) instead of redirecting — silently resolved to
 * a completely EMPTY module under Vitest specifically (confirmed by logging
 * `Object.keys(realSolidImport)` from inside a shim: `[]`). Not a dual-
 * instance problem, not a dep-optimizer cache issue, not a `sharedViteServer`
 * issue — all three were suspected and ruled out by direct measurement before
 * finding this, so do not re-open them. The actual cause: this plugin needs
 * `enforce: "pre"` so its
 * redirect wins over @solidjs/vite-plugin's OWN several `enforce: "pre"`
 * resolveId hooks (confirmed necessary — removing `enforce: "pre"` breaks
 * the main redirect entirely, verified with a `PROOF_OF_REDIRECT` marker
 * export). But "pre" also means THIS hook runs first for the shim's own
 * `solid-js` import, and `return null`ing from a "pre" hook to fall through
 * to whatever runs next — rather than resolving it directly — apparently
 * hands off to @solidjs/vite-plugin's own "pre" resolveId for the exact same
 * specifier in a way that breaks SPECIFICALLY under Vitest's module runner
 * (the production build, which goes through ordinary Vite/rolldown, never
 * exhibited this). `this.resolve(source, importer, { skipSelf: true })` —
 * the standard "defer past just this plugin" idiom — was tried too and
 * still produced the empty module, so the fallthrough chain itself is the
 * problem, not merely which plugin picks it up next.
 *
 * The fix: don't go through resolveId's normal fallthrough AT ALL for the
 * shims' own real-package imports. `virtual:solid-1-compat-real/<pkg>` is a
 * synthetic specifier this plugin recognizes and resolves with a plain
 * `require.resolve`, in one step, before any other plugin (including
 * @solidjs/vite-plugin's) ever sees the request. Confirmed fixed: a
 * `createSignal` call from a shimmed `solid-js` import that previously threw
 * `createSignal is not a function` (because the shim's own `export *`
 * source had resolved to nothing) now works under both `bun run build` and
 * `bun run test`.
 *
 * ── ONE MORE LAYER: THE VIRTUAL RESOLVER ALSO NEEDS TO RESPECT ssr/CLIENT
 *    POSTURE, NOT JUST BYPASS THE FALLTHROUGH CHAIN ─────────────────────────
 *
 * `solid-js` and `@solidjs/web` BOTH ship separate client ("browser") and
 * server ("node"/"deno") builds via their package.json `exports` conditions
 * — confirmed by printing both packages' full exports maps. A plain
 * `require.resolve(realSpecifier)` has no idea which one a given Vitest
 * project wants; it just resolves via Node's own default conditions, which
 * come back as the SERVER build every time. That was invisible for the
 * `solid-js` core self-reference fix above (a plain `node`-postured project
 * happens to want the server build anyway), but broke `@solidjs/web`
 * specifically for `happy-dom`-postured (client) tests: `Dynamic`,
 * `render`, `Portal` and friends all silently became their
 * `"Client-only API called on the server side"`-throwing server stubs
 * again, even though the `solid-js/web` → this shim redirect and the
 * `test.projects` posture split were both working correctly by this point.
 * `resolveId`'s third argument carries Vite's own resolved `ssr: boolean`
 * for the CURRENT environment/project, so `pickBuild` below uses it to
 * choose the sibling dist file explicitly instead of trusting whatever
 * `require.resolve`'s default conditions hand back — only for the two
 * packages that actually have a client/server split; `solid-js/internal` and
 * `@solidjs/web/server-functions/server` are single-build subpaths and pass
 * straight through.
 *
 * ── AND THE SAME TABLE MUST RESPECT PRODUCTION vs DEVELOPMENT MODE, NOT
 *    JUST ssr vs client ────────────────────────────────────────────────────
 *
 * `POSTURE_SPLIT` originally hardcoded the `.dev.js` file for both postures
 * unconditionally — written and only ever exercised under `bun run dev`/
 * `bun run test`, never re-checked against `bun run build`. That shipped
 * `solid-js`'s and `@solidjs/web`'s DEV builds — dev-only diagnostics
 * installers included (`OBSERVE.server = serverSlots(); installServerWith-
 * Origin(...); installConsoleFooter();`, confirmed by reading
 * `node_modules/solid-js/dist/server.dev.js` directly) — into every
 * PRODUCTION build too, for any vendor package whose compat shim pulls in
 * the real package through this bypass. Worse, `@solidjs/signals` (which
 * `server.dev.js` imports `OBSERVE` from) is NOT in this table and so
 * resolves through the normal, unforced path — which in a production build
 * correctly picks `@solidjs/signals`'s mangled/tree-shaken `dist/prod/
 * index.js`. Forcing the DEV file of one package while the other correctly
 * got PROD created a real dev/prod split across a single import, and
 * Rollup's production-mode tree-shaking dropped the `OBSERVE` binding to
 * `void 0` rather than reconciling it — confirmed by reading the exact
 * crashing line in the built `dist/server/assets/input-*.js`
 * (`(void 0).server = serverSlots();`) against the matching real source line
 * in `server.dev.js` (`OBSERVE$1.server = serverSlots();`). Fixed by
 * reading the actual build mode (`configResolved`'s `command`/`mode`, the
 * same signal Vite itself uses to decide `production` vs `development`) and
 * selecting the non-dev sibling file (`solid.js`/`server.js`/`web.js`) in a
 * production build, matching what `@solidjs/signals`'s own conditions give
 * it either way.
 */
// ── THE VENDOR SET, AND WHY EACH ENTRY IS STILL ON IT ──────────────────────
//
// Each package below was checked against its LATEST published version —
// prerelease/next/rc/beta tags included, not just latest stable — and found to
// have no Solid 2-compatible release. Re-check the actual published source
// before assuming an entry still needs shimming, and record what you found:
//  - @ark-ui/solid: zero upstream Solid-2 work found (main branch identical
//    to the published release, no open PR, no prerelease tag).
//  - lucide-solid: a real port exists (upstream PR #4751) but is unmerged,
//    reported "dirty"/unmergeable by GitHub, and maintainers asked for it to
//    ship as a brand-new `@lucide/solid` package rather than a version bump
//    — not consumable today.
//  - @responsive-image/solid: an active draft PR (#2636) combining v1+v2
//    support, but the author's
//    own description says "tested on a solid v2 project, but not yet on a
//    solid v1 project" — unverified, unpublished.
//  - better-auth:
//    `solid-store.ts` imports `createStore`/`reconcile` from the now-gone
//    `solid-js/store` subpath; confirmed against both the published 1.7.7
//    tarball and the live GitHub main branch, no fix upstream either.
//  - @zag-js/solid, @tanstack/charts: transitive dependencies of the above
//    (zag-js underlies @ark-ui/solid) that were measured hitting removed
//    Solid 1 APIs in their installed source, and still do. Per-package
//    findings:
//      - @zag-js/solid: a `2.0.0-next.3` tag exists, but its actual published
//        source still imports `mergeProps`/`onMount` from bare "solid-js" —
//        the 2.0.0 line tracks zag-js's own core API bump, not a Solid-2
//        migration of this adapter. `bun patch`ed instead (see `patches/`).
//      - @tanstack/charts: latest is `0.18.0`, no prerelease tag at all; its
//        solid adapter (`dist/solid/index.js`) still imports `onMount` from
//        bare "solid-js" and `createComponent`/`insert`/etc from
//        "solid-js/web".
//  - @solid-primitives/keyed is GONE from this list as of 2026-10-02: its
//    `3.0.0-next.2` IS genuinely Solid-2-native — peer deps explicitly
//    require `solid-js: ^2.0.0-rc.0` and `@solidjs/web: ^2.0.0-rc.0`, and its
//    published source imports only real Solid 2 names (no `on()`, `isServer`
//    from the real "@solidjs/web"). Forced via `package.json`'s `overrides`
//    (its only consumer, @zag-js/solid@1.43.3, pins it to `^1.5.3`, a range
//    a 3.x prerelease can't satisfy on its own) — no shim redirect needed at
//    all anymore, and no patch either. This is the one entry on this list
//    that should be periodically re-checked for a stable `3.0.0` release.
//  - @tanstack/solid-start: NOT a "no Solid 2 release" case — it's the
//    separate RC-to-RC skew documented in solid-1-compat-server-fns.ts
//    (`parseServerFunctionUrl` renamed to `parseServerFunctionActionUrl`
//    between the @solidjs/web RC this package was built against and the one
//    installed here). Checked again at the latest of both: `@tanstack/
//    solid-start@2.0.0-rc.8` (latest) still imports the old name; installed
//    `@solidjs/web@2.0.0-rc.13` (latest) only exports the new one — the two
//    projects' RC lines simply haven't caught up to each other yet. Still
//    needs the redirect for `@solidjs/web/server-functions/server`
//    specifically.
// ── THE REDIRECT GATE, AND THE RULE IT ENFORCES ─────────────────────────────
//
// VENDOR CODE ONLY. The shim is a compatibility bridge for packages we do not
// control and cannot change; our own `src/` is migrated to native Solid 2 APIs
// instead. That is a deliberate project rule and not an implementation detail:
// a shimmed `src/` would compile and run while leaving the codebase written
// against a dead API, so the migration would never actually happen.
//
// It is ENFORCED rather than documented. Any importer under `src/` asking for
// one of the shimmed specifiers throws at resolve time (see `resolveId` below),
// which makes the build itself the progress meter for the migration.
//
// ── ⚠️ `vendorPackages` IS THE ONE PER-PROJECT VALUE IN THIS WHOLE LAYER ─────
//
// Every other byte of these seven files is shared verbatim by the projects that
// use them. The vendor list cannot be, because it is a statement about ONE
// project's installed tree: "packages whose Solid 1 specifiers must be
// rewritten", derived by grepping each installed package for `"solid-js"`,
// `"solid-js/web"` and `"solid-js/store"` and keeping only the ones with a real
// RUNTIME hit. The lists genuinely differ: measured across the supported set
// they run from 2 entries to 12, and only `@ark-ui/solid` and `@zag-js/solid`
// appear in every one.
//
// It is therefore a REQUIRED ARGUMENT, and it lives in each project's own
// vite.config.ts next to the `optimizeDeps.exclude` that has to hold the same
// set: "packages whose Solid-1 specifiers get rewritten" and "packages the
// optimizer must not pre-bundle" are the same set by construction.
//
// ⛔ THERE IS DELIBERATELY NO DEFAULT, because a default would be a list
// measured against somebody else's node_modules, and both directions of being
// wrong are hard to read. A MISSING package fails as `"./web" is not exported
// ... from package .../solid-js` naming no importer anywhere (that is what the
// debug env var below exists for). A SPURIOUS one never matches — the gate
// tests for a `/node_modules/<pkg>/` substring, so a package that is not
// installed is simply dead weight that READS as a supported case; measured,
// one consumer's list named four packages it does not install.
//
// ⛔ AND IT IS NOT `readonly string[] | undefined`. An accidentally-empty list
// disables every redirect while the build still succeeds for a project whose
// vendors happen not to be reached on that run, so the constructor throws on an
// empty array rather than letting the gate quietly become a no-op.

/**
 * Specifiers that DO NOT EXIST in Solid 2 at all, so a request for one can only
 * have originated in Solid 1 code — i.e. in a vendor package, since src/ is
 * migrated. `solid-js` itself is deliberately absent from this set: it is a real
 * Solid 2 package and a request for it with no importer must resolve normally.
 *
 * ── ⚠️ WHY AN ABSENT IMPORTER NEEDS A RULE AT ALL ──────────────────────────
 *
 * Narrowing the redirect to vendor importers broke `bun run build` outright, and
 * the error named neither this plugin nor the package at fault:
 *
 *   [plugin tanstack-start-core:import-protection]
 *   Error: Errored while resolving "solid-js/web" in `this.resolve`.
 *   Caused by: "./web" is not exported under the conditions
 *   ["solid","module","browser","production","import"] from package
 *   node_modules/solid-js
 *
 * `@tanstack/solid-start`'s import-protection plugin re-resolves specifiers it
 * sees by calling `this.resolve(source)` with NO importer argument. The vendor
 * check below is a path test on that importer, so with `undefined` it answered
 * "not vendor", this plugin returned `null`, and the request fell through to the
 * real `solid-js` — which has no `./web` subpath, because the DOM runtime moved
 * to `@solidjs/web`. Dozens of identical errors, all of them about solid-js and
 * none about the package that actually asked for the old specifier.
 *
 * Treating an absent importer as vendor WHOLESALE would have reopened the hole
 * the narrowing closed, since a bare `solid-js` re-resolution would land on the
 * shim again. Keying on the specifier instead is exact: `solid-js/web` and
 * `solid-js/store` are gone from Solid 2's `exports` map (confirmed by reading
 * node_modules/solid-js/package.json: only `.`, `./refresh`, `./attribution`,
 * `./internal`, `./package.json`), so nothing migrated can be asking for them.
 */
const SOLID_1_ONLY_SPECIFIERS = new Set([
  "solid-js/web",
  "solid-js/store",
  "@solidjs/web/server-functions/server",
]);

function isVendorImporter(
  importer: string | undefined,
  vendorDirs: string[],
  source: string,
): boolean {
  if (!importer) return SOLID_1_ONLY_SPECIFIERS.has(source);
  const normalized = importer.replaceAll("\\", "/");
  return vendorDirs.some((dir) => normalized.includes(dir));
}

export interface Solid1CompatShimOptions {
  /** See the `vendorPackages` block comment above. Required, non-empty. */
  vendorPackages: readonly string[];
  /**
   * Redirect bare `@solidjs/web` to `solid-2-aria-attributes.ts` for EVERY
   * importer, ours included. See the `alwaysShimmed` header below for what that
   * file corrects and why it is not vendor-gated.
   *
   * ⚠️ DEFAULTS TO `false`, AND THAT IS A SCOPE DECISION RATHER THAN A VERDICT
   * ON THE FIX. The fix is correct (see that file for both runtimes' source
   * side by side), but enabling it changes the rendered `aria-*` output of
   * EVERY importer, application code included — and that is a change no build,
   * typecheck or unit test in these projects can observe, because it is about
   * the attribute VALUE a correct-looking element ends up with. One of the five
   * consumers enables it today. Turning it on in another is a one-line change
   * that wants a rendered-output check alongside it; it is recommended, and it
   * is deliberately not done for you.
   */
  ariaAttributeFix?: boolean;
}

/**
 * ── ⛔ THROWS IF `@solidjs/vite-plugin` WOULD SEE OUR SPECIFIERS FIRST ──────────
 *
 * Adoption requirement 2 in the README — "put it FIRST in `plugins`" — was
 * documented and otherwise unenforced, and it is the one mis-wiring with NO
 * symptom at build time. Losing the specifier race disables the whole redirect
 * silently; it surfaces much later at runtime as `Cannot read properties of
 * undefined (reading 'effect')` with nothing rendered, which reads like an
 * application bug and names neither this layer nor the plugin order.
 *
 * ⚠️ `configResolved` RECEIVES THE PLUGIN LIST ALREADY SORTED, which is what makes
 * this checkable at all. Vite groups by `enforce` and preserves array order
 * within a group, so by this point the array IS the resolution order and our
 * index relative to Solid's is the answer — no need to model the sort.
 *
 * ⛔ THE MATCHED NAMES ARE MEASURED, NOT PATTERN-GUESSED. Read out of
 * `@solidjs/vite-plugin`'s own dist: it registers one plugin named exactly
 * `solid` plus a family of `solid:*` plugins (`solid:boundary-modules`,
 * `solid:server-functions/compiler`, `solid:diagnostics`, …). So the test is
 * `=== "solid"` or a `solid:` prefix.
 *
 * ⚠️ IT DELIBERATELY DOES NOT MATCH A BARE PREFIX LIKE `/^solid/`. That would hit
 * this very plugin (`solid-1-compat-shim`), `solid-devtools`, and any consumer's
 * own `solid-`-named plugin — a false throw here breaks every build that adopts
 * this layer, which is far worse than the silent failure it guards.
 */
function assertWinsTheSpecifierRace(
  plugins: readonly ({ name?: string } | null | undefined)[] | undefined,
): void {
  if (!plugins) return;
  const named = plugins.map((plugin) => (typeof plugin?.name === "string" ? plugin.name : ""));
  const self = named.indexOf("solid-1-compat-shim");
  // Absent from the list means some host built the plugin container differently;
  // there is nothing to compare against, and guessing is worse than not checking.
  if (self === -1) return;
  const claimsSolidSpecifiers = (name: string) => name === "solid" || name.startsWith("solid:");
  const ahead = named.slice(0, self).filter(claimsSolidSpecifiers);
  if (ahead.length === 0) return;
  throw new Error(
    [
      "[solid-1-compat-shim] lost the specifier race and would have been a silent no-op.",
      "",
      `  these @solidjs/vite-plugin plugins resolve before it: ${ahead.join(", ")}`,
      "",
      "  Move solid1CompatShim({ … }) EARLIER in `plugins` — it must come before the Solid",
      "  plugin, which registers its own enforce:\"pre\" resolveId hooks for the same specifiers.",
      "",
      "  Left unfixed this produces no build error at all. It appears at runtime as",
      '  "Cannot read properties of undefined (reading \'effect\')" with nothing rendered.',
    ].join("\n"),
  );
}

export function solid1CompatShim(options: Solid1CompatShimOptions): CompatShimPlugin {
  const { vendorPackages, ariaAttributeFix = false } = options;
  if (vendorPackages.length === 0) {
    throw new Error(
      "[solid-1-compat-shim] `vendorPackages` is empty. The redirect gate matches on a " +
        "/node_modules/<pkg>/ substring, so an empty list silently disables every redirect " +
        "and the build only fails later, elsewhere, naming node_modules/solid-js. Pass the " +
        "project's own list — see the block comment above the options type.",
    );
  }
  const shims = {
    "solid-js": fileURLToPath(new URL("./solid-1-compat.ts", import.meta.url)),
    "solid-js/web": fileURLToPath(new URL("./solid-1-compat-web.ts", import.meta.url)),
    "solid-js/store": fileURLToPath(new URL("./solid-1-compat-store.ts", import.meta.url)),
    "@solidjs/web/server-functions/server": fileURLToPath(
      new URL("./solid-1-compat-server-fns.ts", import.meta.url),
    ),
  } as const;
  /**
   * ⚠️ NOT A SOLID 1 SHIM, AND NOT VENDOR-GATED. `@solidjs/web` is redirected for
   * EVERY importer, ours included, because the file it points at fixes a
   * behaviour of Solid 2 itself rather than restoring a Solid 1 name: `aria-*` is
   * not an HTML boolean attribute, and Solid 2 treats it as one. Read
   * ./solid-2-aria-attributes.ts — it has both versions' source side by side
   * and the note that the DOM reference documents none of it.
   *
   * It is kept in a separate map from `shims` so the vendor gate below cannot be
   * applied to it by accident, and so the two concerns stay legible: one is a
   * compatibility bridge that should shrink to nothing as vendors ship Solid 2
   * releases, the other is a correction that lives until upstream fixes it.
   *
   * ⚠️ THE BARE SPECIFIER ONLY. `@solidjs/web/jsx-runtime` and
   * `@solidjs/web/server-functions/server` are deliberately absent: the first is
   * the compiler's own entry and must resolve to the real package, and the second
   * has its own Solid 1 shim in `shims` above.
   */
  //
  // ⚠️ GATED ON `ariaAttributeFix`, WHICH DEFAULTS OFF — see the option's own
  // docblock for why the default is a scope decision and not a verdict. The file
  // it points at stays in this directory either way: it is referenced by the
  // `@solidjs/web` entry in `solid-1-compat-virtual.d.ts`'s prose and it is the
  // same correction every one of these projects will eventually want.
  const alwaysShimmed: Record<string, string> = ariaAttributeFix
    ? { "@solidjs/web": fileURLToPath(new URL("./solid-2-aria-attributes.ts", import.meta.url)) }
    : {};
  const shimFiles = new Set([...Object.values(shims), ...Object.values(alwaysShimmed)]);
  // `/node_modules/<pkg>/` — the directory any file genuinely inside that
  // package's installed tree lives under, regardless of how deep
  // (dist/source/whatever) or which OS path separator Vite hands back.
  const vendorDirs = vendorPackages.map((pkg) => `/node_modules/${pkg}/`);

  /*
   * ── ⚠️ THE REAL PACKAGES ARE RESOLVED FROM THE CONSUMER'S ROOT, NEVER FROM
   *      THIS FILE ──────────────────────────────────────────────────────────
   *
   * This was `createRequire(import.meta.url)` while the file lived inside each
   * project, where that meant the same thing. From a SHARED location it does
   * not: `import.meta.url` is tLib, whose `shared/ts/node_modules` holds
   * **solid-js 1.9.12** — tLib's own UI and every t* resource are deliberately
   * still on Solid 1. A `require.resolve("solid-js")` from here would hand the
   * `virtual:solid-1-compat-real/*` bypass SOLID 1 as "the real Solid 2", which
   * is the one thing this whole layer exists to keep apart.
   *
   * ⛔ IT FAILS IN THE PLACE HARDEST TO READ. The bypass is only taken off
   * `require.resolve` under Vitest (see the `process.env.VITEST` branch below);
   * everywhere else `this.resolve` delegates to Vite and resolves against the
   * project. So `bun run build` stayed green and `bun run test` lost 40 of 290
   * test FILES at collection, reported as
   *   Error: Cannot find module '/@fs/…/solid-2-aria-attributes.ts'
   * — a message about the shim file, which exists and loads fine, rather than
   * about the dependency the shim then failed to find.
   *
   * `configResolved` below rebinds this to `config.root`. The initial value is
   * `process.cwd()`, which is correct for every consumer here (vite and vitest
   * both run from the project directory) and is only a fallback: it matters if
   * some host calls `resolveId` before `configResolved`.
   */
  let rootDir = process.cwd();
  let req = createRequire(path.join(rootDir, "noop.js"));
  const REAL_PREFIX = "virtual:solid-1-compat-real/";
  // <package name>: [dev client, dev server, prod client, prod server]
  // dist filenames, all siblings of the file `require.resolve` hands back by
  // default (always under that package's own `dist/`, one directory up from
  // whichever variant got picked). Which pair gets used is decided by actual
  // build mode (`isProduction` below) — see this file's header for why
  // hardcoding the dev pair unconditionally broke production builds.
  const POSTURE_SPLIT: Record<
    string,
    { dev: [client: string, server: string]; prod: [client: string, server: string] }
  > = {
    "solid-js": { dev: ["solid.dev.js", "server.dev.js"], prod: ["solid.js", "server.js"] },
    "@solidjs/web": { dev: ["web.dev.js", "server.dev.js"], prod: ["web.js", "server.js"] },
  };
  let isProduction = process.env.NODE_ENV === "production";

  return {
    name: "solid-1-compat-shim",
    enforce: "pre",
    configResolved(config) {
      isProduction = config.isProduction;
      // See the `req` comment above: the real packages belong to the CONSUMER.
      rootDir = config.root;
      req = createRequire(path.join(rootDir, "noop.js"));
      assertWinsTheSpecifierRace(config.plugins);
    },
    async resolveId(source, importer, options) {
      if (source.startsWith(REAL_PREFIX)) {
        const realSpecifier = source.slice(REAL_PREFIX.length);
        // ── ONE REACTIVE INSTANCE: ASK VITE, DON'T GUESS ───────────────────
        //
        // The `require.resolve` road below produces a bare absolute path.
        // That is the same module id Vite's own resolver produces in a
        // production build — but NOT in `bun run dev`, where Vite appends its
        // dep-optimizer browser hash to node_modules imports. Measured, on
        // the home page, by trapping `globalThis.Solid$$` (the flag
        // `solid-js/dist/solid.dev.js:1598` uses for its own
        // multiple-instances guard) with a get/set interceptor and printing
        // the stack of each access:
        //
        //   set  at /node_modules/solid-js/dist/solid.dev.js?v=0412508d:1598
        //   get  at /node_modules/solid-js/dist/solid.dev.js:1598
        //
        // One physical file, two module URLs, so the browser evaluated
        // `@solidjs/signals`' module-level state TWICE and the app ran two
        // independent reactive graphs: our `src/` and @tanstack/solid-router
        // on the `?v=` copy (Vite's resolver), every vendor package routed
        // through this shim on the unqueried copy (this hook). Solid's own
        // guard said so out loud — "You appear to have multiple instances of
        // Solid" fired on every dev page load.
        //
        // WHAT THAT COST. A vendor component's signals live in one graph
        // while the JSX bindings rendering it are effects in the other, so
        // reads never subscribe and writes never notify. It surfaced as ~313
        // reactivity diagnostics per home-page load — 246
        // STRICT_READ_UNTRACKED ("read directly in <Ark.Item>" / "<Show>" /
        // "<ResponsiveImage>"), 39 NO_OWNER_EFFECT, 26 NO_OWNER_CLEANUP —
        // which are all one fact reported from many scopes: the ambient
        // owner/observer a primitive looks for is a module-level variable,
        // and it was in the OTHER copy. The user-visible symptom was silent,
        // not an exception: clicking the FAQ accordion left
        // `aria-expanded="false"` and its content at height 0. `vp build` /
        // `vp preview` were fine, because without a dep optimizer both roads
        // name the one file — which is exactly what made this read as a
        // Solid 2 bug rather than a resolution bug.
        //
        // So delegate: `this.resolve` returns the id Vite would have given
        // any other importer, hash and all, which is the only way to be
        // right in both postures. It also subsumes POSTURE_SPLIT below —
        // Vite applies the real export conditions per environment, instead of
        // this hook hand-picking a dist filename from `options.ssr`.
        //
        // ⚠️ NOT UNDER VITEST. This file's header documents, at length, that
        // deferring resolution of these specifiers — `return null`, or
        // `this.resolve(..., { skipSelf: true })` — yields an EMPTY module
        // under Vitest's module runner specifically (`Object.keys(real)` is
        // `[]`), and that is why the virtual bypass exists at all. Vitest has
        // no dep optimizer and no browser hash, so the hand-resolved path is
        // already the single shared id there; the delegation is only needed
        // where a browser hash can appear. Keep both roads.
        if (!process.env.VITEST) {
          // ⚠️ THE IMPORTER PASSED HERE IS THE CONSUMER'S ROOT, NOT `importer`.
          //
          // `importer` is one of the shim files, which used to live inside the
          // project and now lives in tLib. Vite resolves relative to the
          // importer, so handing it the shim's own path resolves `solid-js`
          // against **tLib's** node_modules — i.e. solid-js 1.9.12, the Solid 1
          // every t* resource is still on. MEASURED on a consumer with no
          // `resolve.dedupe` to paper over it; the build died with eight
          //   [MISSING_EXPORT] "merge" is not exported by
          //   "../../../tLib/shared/ts/node_modules/solid-js/dist/solid.js"
          // naming Solid 2 names that only Solid 2 has. The message does say
          // which solid-js it found, which is the one thing that makes it
          // readable — do not lose that by catching and rethrowing here.
          //
          // Resolving from the root is also what we MEAN: the real package
          // belongs to the project being built, and that is the single instance
          // every other importer in the graph resolves to as well, which is the
          // whole point of the paragraph above.
          const delegated = await this.resolve(realSpecifier, path.join(rootDir, "noop.js"), {
            skipSelf: true,
          });
          if (delegated) return delegated;
        }
        // `require.resolve`/`path.join`/`path.dirname` all return OS-native
        // paths — backslash-separated on Windows. Vite/Rollup's OWN resolver
        // always normalizes resolved module IDs to forward slashes
        // internally (a documented, consistent convention specifically to
        // keep one physical file at one module ID). Handing Rollup a
        // backslash path here, for the SAME file `solid-js`/`@solidjs/web`
        // also resolve to normally elsewhere (src/, @tanstack/solid-router,
        // any non-vendor importer), makes Rollup treat it as a SECOND,
        // distinct module — confirmed live: the real
        // `globalThis.Solid$$`-guarded self-check in
        // `node_modules/solid-js/dist/solid.dev.js` (`if (!globalThis.Solid$$)
        // ... else console.warn("You appear to have multiple instances of
        // Solid...")`) fired from our own shim's bundled chunk, meaning
        // solid-js's module-level code — and with it, the ENTIRE reactive
        // core — was evaluated twice, once per module ID. Any component
        // whose signals were created under this duplicated instance (every
        // vendor component passing through this shim, which is most of the
        // page) is invisible to tracking contexts running under the OTHER
        // instance — including `@tanstack/solid-router`'s own store signals,
        // which explained why router data updated correctly but no
        // downstream re-render ever happened. Normalizing to forward
        // slashes before returning makes this resolution produce the
        // IDENTICAL module ID Vite's own resolver would, so Rollup
        // deduplicates it into the one real shared instance everyone else
        // already uses.
        const normalize = (p: string) => p.replaceAll("\\", "/");
        const resolved = normalize(req.resolve(realSpecifier));
        const split = POSTURE_SPLIT[realSpecifier];
        if (!split) return resolved;
        const [clientFile, serverFile] = isProduction ? split.prod : split.dev;
        const pkgRoot = path.dirname(path.dirname(resolved)); // <root>/dist/<file>.js -> <root>
        return normalize(path.join(pkgRoot, "dist", options?.ssr ? serverFile : clientFile));
      }
      // The unconditional correction first — see `alwaysShimmed`'s header. Its own
      // file is excluded by the `shimFiles` check below, which it shares with the
      // Solid 1 shims, so it can still import the real package through the
      // `virtual:solid-1-compat-real/*` bypass.
      const always = alwaysShimmed[source];
      if (always) return shimFiles.has(importer ?? "") ? null : always;

      const shimTarget = (shims as Record<string, string>)[source];
      if (!shimTarget) return null;
      // Our own shim files legitimately import these same specifiers (via
      // the virtual bypass above, which is excluded by the `startsWith`
      // check first) — this importer check only gates the REDIRECT, so a
      // shim file asking for one of these bare names directly (shouldn't
      // happen, but fail safe) is also left alone rather than redirected to
      // itself.
      if (shimFiles.has(importer ?? "")) return null;
      // ⚠️ THIS THROW IS THE MIGRATION'S ENFORCEMENT, AND IT HAS TO RUN BEFORE
      // THE VENDOR GATE OR IT NEVER RUNS AT ALL.
      //
      // It used to sit AFTER the `isVendorImporter` check below, phrased as
      // "imported from <importer> (under src/) was about to be redirected to
      // the compat shim". It could not fire, for the reason that phrasing
      // assumes away: reaching it required the importer to be inside a vendor
      // package AND to contain `/src/`. One of our own files fails the first
      // half — `isVendorImporter` returns false for it and the hook returns
      // `null` several lines earlier — so the branch was dead in the only
      // direction it was written to catch. The audit that found this also
      // confirmed the other direction is inert: five vendor packages here DO
      // ship a `src/` tree (`@tanstack/solid-start`, `-router`, `-form`,
      // `-store`, `-virtual`), but every one of them resolves through its
      // `exports` map to `dist/source/` or `dist/esm/`, never to `src/`, so
      // the branch would not have misfired either. Dead both ways.
      //
      // Positioned here it checks the thing it claims to: OUR importer asking
      // for a specifier Solid 2 does not have. Without it the request falls
      // through to the real `solid-js`, and the failure is Vite's — `"./web" is
      // not exported under the conditions [...] from package
      // node_modules/solid-js`, which names neither this plugin nor the rule
      // being broken. The build still fails, just unhelpfully; this makes it
      // fail with the reason and a pointer to migration.txt.
      //
      // ⚠️ IT IS GATED ON `SOLID_1_ONLY_SPECIFIERS`, NOT ON `shims`, AND THE
      // DIFFERENCE IS THE WHOLE CORRECTNESS OF IT. `shims` is keyed by four
      // specifiers, and one of them — bare `solid-js` — is a REAL Solid 2
      // package that every file under `src/` imports legitimately. Throwing for
      // the whole `shims` set took down `src/lib/vendor-solid-2.test.tsx` on
      // its `import { For, flush } from "solid-js"` with this very message,
      // which is as wrong as the dead branch it replaced: it says "Solid 2 has
      // no such specifier" about the one specifier Solid 2 definitely has.
      // Only the three names Solid 2's `exports` map genuinely dropped can ever
      // be an error from our own code.
      //
      // ⚠️ IT DOES NOT, AND CANNOT, CATCH A SOLID 1 *NAME* IMPORTED FROM BARE
      // `solid-js` — for that same reason, and because `resolveId` sees
      // specifiers, not named bindings. That half is enforced by
      // `src/lib/solid-2-idioms.test.ts`'s `SOLID_1_ONLY_NAMES` guard. The two
      // mechanisms are halves of one rule; neither is sufficient alone.
      const ourSrc = `${path.resolve(process.cwd(), "src").replaceAll("\\", "/")}/`;
      const normalizedImporter = (importer ?? "").replaceAll("\\", "/");
      if (SOLID_1_ONLY_SPECIFIERS.has(source) && normalizedImporter.startsWith(ourSrc)) {
        throw new Error(
          `[solid-1-compat-shim] "${source}" imported from "${importer}" (under our own src/). ` +
            `Solid 2 has no such specifier and the compat shim is vendor-only — src/ must import ` +
            `Solid 2 natively. The store and DOM APIs moved: "solid-js/store" -> bare "solid-js", ` +
            `"solid-js/web" -> "@solidjs/web". See assets/reference/solid/migration.txt.`,
        );
      }
      // ⚠️ KEEP THE DIAGNOSTIC. `SOLID1_SHIM_DEBUG=1 bun run build` prints every
      // specifier/importer pair this plugin declined, and it is the only thing
      // that locates the real asker when a Solid 1 specifier survives: the build
      // failure for one arrives from `@tanstack/solid-start`'s
      // import-protection plugin, blames `node_modules/solid-js`, and names the
      // importing .mdx or vendor file nowhere. One line of this output located
      // a project's own MDX emitter after 101 build errors had said nothing
      // about it.
      if (!isVendorImporter(importer, vendorDirs, source)) {
        // ⚠️ TWO SPELLINGS, BOTH SUPPORTED AND BOTH IN USE. Honouring one and
        // dropping the other would turn the only diagnostic that can locate a
        // missing vendor package into a flag that silently prints nothing in
        // the projects using the other name — indistinguishable from "there is
        // nothing to find". Add a third spelling only by adding it here too.
        if (process.env.SOLID1_SHIM_DEBUG || process.env.SOLID_COMPAT_DEBUG) {
          console.log(`[shim-miss] ${source} <- ${importer}`);
        }
        return null;
      }
      return shimTarget;
    },
  };
}
