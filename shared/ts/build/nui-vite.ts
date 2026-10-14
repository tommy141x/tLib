import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The non-plugin half of a FiveM NUI Vite config — resolve, base, build,
 * optimizeDeps, dev port.
 *
 * tDetector, tRadar and tUnit had three copies of this that were IDENTICAL
 * except for the dev-server port, under ~110 lines of identical reasoning
 * apiece. Every setting below is load-bearing in a way whose failure is silent,
 * so three copies meant three places for a silent failure to survive a fix.
 * The notes are here rather than in each config because this is now the one
 * place they describe.
 *
 * What is NOT here, and why
 *
 * `plugins` stays in the consumer's config, and that is deliberate rather than
 * unfinished. A plugin array means importing `@solidjs/vite-plugin`,
 * `unocss/vite` and `unplugin-icons/vite`; imported from here they would
 * resolve out of `tLib/shared/ts/node_modules`, so the bundle would be compiled
 * by tLib's resolved Solid compiler and tLib's UnoCSS rather than its own. That
 * is the same class of hazard as the `dedupe` list below exists to prevent, and
 * it would be introduced by the very module meant to prevent it. Plugins are
 * instances; only settings are shared.
 *
 * `server.port` is a parameter because the ports must differ — two resources'
 * dev servers are routinely up at once.
 */
export interface NuiBundleOptions {
  /** The bundle's own `__dirname`. Aliases and the tLib path resolve from it. */
  root: string;
  /** Dev-server port. Unique per resource; they run concurrently. */
  port: number;
  /**
   * The Solid-1-era packages the compat shim pre-bundles.
   *
   * Passed in rather than read from here because the list is the consumer's
   * (`client/web/vite/solid-compat-vendors.ts`) and differs between bundles.
   * It is spread into `optimizeDeps.exclude`: these packages must NOT be
   * pre-bundled by esbuild, because the shim rewrites their JSX and esbuild
   * would have already baked the un-rewritten form into the dep cache.
   */
  vendorPackages: readonly string[];
  /** Extra path aliases, merged after the two every bundle has. */
  alias?: Record<string, string>;
}

/**
 * The resource's own version, for the `resourceVersion` dimension that every
 * diagnostics event carries (`shared/ts/telemetry/collect.ts`).
 *
 * Read off the resource's `package.json` — which `fxmanifest.lua`'s `version`
 * tracks — rather than retyped into each bundle, because a hand-maintained third
 * copy goes stale and the only symptom is a dashboard attributing a fault to the
 * wrong release.
 *
 * `readFileSync` and NOT a JSON `import`: an import would be resolved and
 * inlined by the bundler, and the only field wanted is `version`. This runs in
 * the Vite config, which is Node, so there is no bundle to pollute.
 *
 * Never throws. A build must not fail because a version string could not be
 * read, and "unknown" is a printable answer — `versionSlug` accepts it.
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
       * Load-bearing, and MUST NOT be tidied away. `@tlib/shared` above points
       * into another repo which has its own `node_modules/solid-js` (bun
       * auto-installs peerDependencies), so without this the bundle carries TWO
       * copies of the Solid runtime. Two copies means two `createContext`
       * registries: a shared component reading a context created in shared
       * silently gets the context DEFAULT instead of the provider's value — no
       * error, no warning. It only breaks in `build`: `vite-plugin-solid`
       * deduped solid-js when `command === 'dev'` and not otherwise, so the dev
       * server was self-consistent and only the shipped NUI was wrong. Matching
       * versions do not save you; two directories is sufficient. That plugin is
       * gone, but the hazard is the resolver's rather than the plugin's, so the
       * dedupe stays — and it also names `@solidjs/web`, which in Solid 2 is
       * where the DOM runtime and the single JSX namespace live, and which
       * tLib's shared components import directly.
       *
       * `three` is here for the same reason, and is not speculative:
       * `@tlib/shared` declares it as a PEER dependency, so bun has already
       * installed a copy under `tLib/shared/ts/node_modules` alongside the
       * bundle's own. Two three instances means two `THREE.Object3D` prototypes
       * and two WebGLRenderer registries: an `instanceof` check across the seam
       * fails and a control from the shared editor silently refuses to attach.
       * Same failure mode as solid-js, same fix.
       */
      dedupe: ["solid-js", "@solidjs/web", "@ark-ui/solid", "three"],
    },

    /** Relative paths — FiveM NUI serves from the resource filesystem, not a web origin. */
    base: "./",

    build: {
      target: "es2020",

      /**
       * Stated separately from `target`, because the constraint is a BROWSER
       * version and an `esNNNN` target does not express one. Measured on
       * tRadio's NUI bundle, which has 5 responsive @media blocks: at `target:
       * "es2020"` adding this changes no media query, but at `target: "esnext"`
       * WITHOUT it all 5 were rewritten to the Media Queries Level 4 range form
       * `(width>=NNNpx)` — Chrome 104, so CEF 103 drops the whole query — and
       * WITH it they stayed legacy `min-width`. So this is what keeps the CSS
       * correct across any future change to `target`. It also strips the
       * prefixes CEF never needs (-1 `-moz-`, -7 `-webkit-`, -4.7% bytes on
       * that bundle).
       */
      cssTarget: "chrome103",

      outDir: "../ui",
      emptyOutDir: true,
      sourcemap: false,

      /**
       * Never inline an asset as a data URI. NUI cannot fetch a `data:` URL for
       * a chunk, and an inlined asset has nothing to gain here anyway: the
       * bundle is served off the local resource filesystem already, so the
       * round-trip a data URI saves on the web does not exist.
       */
      assetsInlineLimit: 0,

      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1000,
    },

    optimizeDeps: {
      /**
       * `solid-js` and `@solidjs/web` are deliberately NOT on this list.
       * web-next excludes them in its SSR environment and warns explicitly
       * against copying that to the client: `@solidjs/vite-plugin` puts them in
       * the CLIENT `optimizeDeps.include`, and on the client that pre-bundling
       * is wanted. What matters is only that the compat shim's
       * `virtual:solid-1-compat-real/*` bypass lands on the SAME module id as
       * everyone else's plain `solid-js` import, which the plugin's `resolveId`
       * guarantees by delegating to Vite's own resolver.
       *
       * Vite matches these by prefix, so a bare package name covers its subpaths.
       */
      exclude: [...vendorPackages],
    },

    server: {
      port,
    },

    /**
     * A CONSUMER THAT SETS ITS OWN `define` REPLACES THIS ONE, because these
     * options are spread. If a bundle needs more defines it must spread this key
     * too — `define: { ...nuiBundleOptions(...).define, __MINE__: ... }` — or
     * `__RESOURCE_VERSION__` silently disappears and every diagnostics event
     * from that bundle is attributed to version "unknown".
     *
     * Read with a `typeof` guard at the point of use (see each resource's
     * `src/lib/diagnostics.ts`): a bare reference to an absent `define` is a
     * ReferenceError at module scope, which would take the bundle down to report
     * a version string.
     */
    define: {
      __RESOURCE_VERSION__: JSON.stringify(resourceVersion(root)),
    },
  };
}
