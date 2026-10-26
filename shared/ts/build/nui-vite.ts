import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The non-plugin half of a FiveM NUI Vite config — resolve, base, build, optimizeDeps, dev
 * port. tDetector, tRadar and tUnit had three identical ~110-line copies of this (differing
 * only in dev port), each a place for a silent failure to survive a fix.
 *
 * `plugins` deliberately stays in the consumer's config: importing `@solidjs/vite-plugin`,
 * `unocss/vite` or `unplugin-icons/vite` from here would resolve out of
 * `tLib/shared/ts/node_modules`, compiling the bundle with tLib's Solid/UnoCSS instead of its
 * own — the same hazard `dedupe` below exists to prevent, introduced by this module itself.
 * `server.port` is a parameter since two resources' dev servers are routinely up at once.
 */
export interface NuiBundleOptions {
  /** The bundle's own `__dirname`. Aliases and the tLib path resolve from it. */
  root: string;
  /** Dev-server port. Unique per resource; they run concurrently. */
  port: number;
  /**
   * The Solid-1-era packages the compat shim pre-bundles. Passed in, not read here, since
   * the list is the consumer's (`client/web/vite/solid-compat-vendors.ts`) and differs per
   * bundle. Spread into `optimizeDeps.exclude`: esbuild must not pre-bundle these, since the
   * shim rewrites their JSX and esbuild would bake the un-rewritten form into the dep cache.
   */
  vendorPackages: readonly string[];
  /** Extra path aliases, merged after the two every bundle has. */
  alias?: Record<string, string>;
}

/**
 * The resource's own version, for the `resourceVersion` dimension every diagnostics event
 * carries. Read off `package.json` (which `fxmanifest.lua`'s `version` tracks) rather than
 * retyped into each bundle, since a hand-maintained copy goes stale with the only symptom
 * being a dashboard misattributing a fault. `readFileSync`, not a JSON import, since an
 * import would get resolved and inlined by the bundler for one field; this runs in the Vite
 * config (Node), so there's no bundle to pollute. Never throws — "unknown" is a printable
 * fallback that `versionSlug` accepts.
 *
 * @param root the bundle's own `__dirname` (i.e. `<resource>/client/web`)
 */
export function resourceVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function nuiBundleOptions(options: NuiBundleOptions) {
  const { root, port, vendorPackages, alias } = options;
  return {
    resolve: {
      alias: {
        "@": resolve(root, "src"),
        "@tlib/shared": resolve(root, "../../../tLib/shared/ts"),
        ...alias,
      },

      /**
       * Load-bearing, do not tidy away. `@tlib/shared` points into another repo with its own
       * `node_modules/solid-js` (bun auto-installs peerDependencies), so without this the
       * bundle carries two Solid runtimes — two `createContext` registries, so a shared
       * component silently reads the context DEFAULT instead of the provider's value, no
       * error. Matching versions don't help; two directories is sufficient. Also covers
       * `@solidjs/web` (Solid 2's DOM runtime + JSX namespace, imported directly by tLib's
       * shared components) and `three`, a peer dependency with the same two-instance failure:
       * two `THREE.Object3D` prototypes, so an `instanceof` across the seam fails silently.
       */
      dedupe: ["solid-js", "@solidjs/web", "@ark-ui/solid", "three"],
    },

    /** Relative paths — FiveM NUI serves from the resource filesystem, not a web origin. */
    base: "./",

    build: {
      target: "es2020",

      /**
       * Stated separately from `target` since the constraint is a browser version, which an
       * `esNNNN` target doesn't express. Measured on tRadio's 5-media-query NUI bundle:
       * `target: "esnext"` without this rewrote all 5 to the Level 4 range form
       * `(width>=NNNpx)` (Chrome 104 — CEF 103 drops the whole query); with it they stayed
       * legacy `min-width`. Also strips prefixes CEF never needs (-1 `-moz-`, -7 `-webkit-`,
       * -4.7% bytes on that bundle).
       */
      cssTarget: "chrome103",

      outDir: "../ui",
      emptyOutDir: true,
      sourcemap: false,

      // Never inline an asset as a data URI: NUI can't fetch a `data:` URL for a chunk, and
      // there's nothing to gain anyway since the bundle is already served off the local
      // filesystem, with no round trip for a data URI to save.
      assetsInlineLimit: 0,

      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1000,
    },

    optimizeDeps: {
      /**
       * `solid-js`/`@solidjs/web` deliberately absent — `@solidjs/vite-plugin` puts them in
       * the client's `optimizeDeps.include` instead, where pre-bundling is wanted. What
       * matters is only that the compat shim's `virtual:solid-1-compat-real/*` bypass lands
       * on the same module id as a plain `solid-js` import, which the plugin's `resolveId`
       * guarantees. Vite matches by prefix, so a bare package name covers its subpaths.
       */
      exclude: [...vendorPackages],
    },

    server: {
      port,
    },

    /**
     * A consumer setting its own `define` replaces this one, since these options are
     * spread — it must spread this key too (`{ ...nuiBundleOptions(...).define, __MINE__:
     * ... }`) or `__RESOURCE_VERSION__` silently vanishes and every diagnostics event is
     * attributed to "unknown". Read with a `typeof` guard at the point of use — a bare
     * reference to an absent `define` is a ReferenceError at module scope.
     */
    define: {
      __RESOURCE_VERSION__: JSON.stringify(resourceVersion(root)),
    },
  };
}
