/**
 * Packages whose Solid 1 specifiers must be rewritten for the in-game NUI bundle.
 *
 * ⚠️ NOT "packages this app depends on". A dependency that is already Solid 2
 * native does not belong here, and a TRANSITIVE one that still names the Solid 1
 * surface does — `@solid-primitives/props` is reached only through
 * `@ark-ui/solid`, and `@solid-primitives/refs` and
 * `@solid-primitives/transition-group` only through `solid-motionone`; nothing
 * in `src/` imports any of the three.
 *
 * ⛔ DO NOT COPY THIS LIST TO ANOTHER APP, AND DO NOT ADD TO IT BY GUESSING.
 * A spurious entry never matches — the plugin gates on a `/node_modules/<pkg>/`
 * substring — so it is dead weight that READS as a supported case, and nothing
 * ever tells you. A missing entry fails as `"./web" is not exported … from
 * package …/solid-js`, naming no importer at all; `SOLID1_SHIM_DEBUG=1` is the
 * only thing that finds the real asker.
 *
 * DERIVED BY MEASUREMENT against this app's own installed tree, 2026-10-04,
 * AFTER the Solid 2 pins were installed — measuring before the install is what
 * makes the difference, see the note on `@solid-primitives/*` below. A package
 * is kept only when a file that can RUN imports a specifier Solid 2 deleted
 * (`solid-js/web`, `solid-js/store`) or a NAME bare `solid-js` no longer
 * exports. Bare `solid-js` on its own is not a reason: the shim leaves that
 * specifier alone.
 *
 *   @ark-ui/solid                       solid-js/web, solid-js/store, Index,
 *                                       createUniqueId, mergeProps, on,
 *                                       onMount, splitProps        (66 files)
 *   @solid-primitives/props             mergeProps
 *   @solid-primitives/refs              solid-js/web, createComputed
 *   @solid-primitives/transition-group  solid-js/web, batch, createComputed
 *   @tanstack/solid-form                solid-js/web, createComputed,
 *                                       createUniqueId, mergeProps, onMount,
 *                                       splitProps                 (10 files)
 *   @tanstack/solid-store               solid-js/web
 *   @zag-js/solid                       mergeProps, onMount
 *   lucide-solid                        solid-js/web, splitProps  (3700 files)
 *   solid-motionone                     solid-js/web, batch, splitProps
 *
 * ── TWO EXCLUSIONS THAT ARE DELIBERATE ──────────────────────────────────────
 *
 * `@solid-primitives/keyed` and `@solid-primitives/utils` BOTH measured as hits
 * before the upgrade and neither is here, because the pins in `package.json`
 * move them to `3.0.0-next.2` / `7.0.0-next.4`, which are Solid 2 native. The
 * `utils` one matters beyond tidiness: `keyed@3` imports `INTERNAL_OPTIONS`
 * from it, and putting it behind the shim is what produces `"equalFn" is not
 * exported by … solid-1-compat.ts` — an error naming the shim, three packages
 * from its cause. Measure AFTER installing, never before.
 *
 * `babel-preset-solid`, `solid-refresh` and `vite-plugin-solid` all measured as
 * hits too and are all BUILD tooling, reachable only through
 * `vite-plugin-solid`, which this app no longer uses. Nothing they contain can
 * reach the bundle, so shimming them would be the "dead weight that reads as a
 * supported case" above.
 *
 * Keep it in its own module rather than inline: `optimizeDeps.exclude` has to
 * hold the same set by construction.
 */
export const VENDOR_PACKAGES = [
  "@ark-ui/solid",
  "@solid-primitives/props",
  "@solid-primitives/refs",
  "@solid-primitives/transition-group",
  "@tanstack/solid-form",
  "@tanstack/solid-store",
  "@zag-js/solid",
  "lucide-solid",
  "solid-motionone",
] as const;
