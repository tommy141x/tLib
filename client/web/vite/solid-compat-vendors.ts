/**
 * Packages whose Solid 1 specifiers must be rewritten for the in-game NUI bundle.
 * Not "this app's dependencies" — a package already Solid 2 native doesn't belong;
 * a TRANSITIVE one still naming the Solid 1 surface does (e.g. @solid-primitives/props,
 * reached only through @ark-ui/solid). Derived by measuring this app's installed tree
 * AFTER the Solid 2 pins were installed (2026-10-04) — measuring before gives false
 * positives. A spurious entry never matches (the plugin gates on a `/node_modules/<pkg>/`
 * substring) and reads as supported with nothing to tell you; a missing one fails as
 * `"./web" is not exported … from package …/solid-js`, naming no importer —
 * `SOLID1_SHIM_DEBUG=1` finds the real asker. Do not copy this list to another app or
 * add to it by guessing.
 *
 *   @ark-ui/solid            solid-js/web, solid-js/store, Index, createUniqueId,
 *                            mergeProps, on, onMount, splitProps      (66 files)
 *   @solid-primitives/props  mergeProps
 *   @tanstack/solid-form     solid-js/web, createComputed, createUniqueId,
 *                            mergeProps, onMount, splitProps          (10 files)
 *   @tanstack/solid-store    solid-js/web
 *   @zag-js/solid            mergeProps, onMount
 *   lucide-solid             solid-js/web, splitProps                (3700 files)
 *
 * Deliberately excluded: @solid-primitives/keyed and @solid-primitives/utils, both hit
 * before the upgrade, both moved to Solid-2-native pins (3.0.0-next.2 / 7.0.0-next.4).
 * `utils` matters beyond tidiness — keyed@3 imports INTERNAL_OPTIONS from it, and
 * shimming it produces `"equalFn" is not exported by … solid-1-compat.ts`, an error
 * naming the shim three packages from its cause. Also excluded: babel-preset-solid,
 * solid-refresh, vite-plugin-solid — build tooling reachable only through
 * vite-plugin-solid, which this app no longer uses.
 *
 * Kept in its own module because `optimizeDeps.exclude` (vite.config.ts) needs the
 * same set.
 */
export const VENDOR_PACKAGES = [
  "@ark-ui/solid",
  "@solid-primitives/props",
  "@tanstack/solid-form",
  "@tanstack/solid-store",
  "@zag-js/solid",
  "lucide-solid",
] as const;
