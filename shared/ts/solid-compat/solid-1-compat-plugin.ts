/**
 * The compatibility layer's only entry point: a Vite `resolveId` plugin that
 * lets vendor packages built for Solid 1 run on Solid 2 without patching them.
 *
 * README.md is the reference for adoption, `vendorPackages`, what each shim
 * corrects, and the measurement behind every resolution rule below.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The exact subset of Vite's plugin interface this file implements. Importing
 * `Plugin` instead resolves against tLib's `vite`, and the consumer's own `tsc`
 * then gives up with TS2321 at its `defineConfig` call, naming neither this file
 * nor either package. Widening any member to the real type brings that back.
 */
interface CompatShimPlugin {
  name: string;
  enforce: "pre";
  /** `plugins` is read only to check order, so the narrowest shape that allows it. */
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
 * Specifiers Solid 2 dropped from its `exports` map, so a request for one can
 * only have come from Solid 1 code. This is what answers a request with NO
 * importer, which the vendor path test cannot judge. Bare `solid-js` is
 * deliberately absent: it is a real Solid 2 package.
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
  /** Required, non-empty. See README.md for what belongs on it and how to derive one. */
  vendorPackages: readonly string[];
  /**
   * Redirect bare `@solidjs/web` to `solid-2-aria-attributes.ts` for every
   * importer, ours included. Defaults off because enabling it changes rendered
   * output that no build, typecheck or unit test here can observe. See README.md.
   */
  ariaAttributeFix?: boolean;
}

/**
 * Throws if any `@solidjs/vite-plugin` plugin would see our specifiers first --
 * the one mis-wiring with no symptom at build time. `configResolved` receives
 * the plugin list already sorted, so the array IS the resolution order. The
 * names come from that plugin's own dist rather than a `/^solid/` prefix, which
 * would hit this plugin and `solid-devtools` too.
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
   * A separate map from `shims` so the vendor gate below cannot reach it by
   * accident: this one corrects Solid 2 itself rather than restoring a Solid 1
   * name, so it applies to every importer. The BARE specifier only --
   * `@solidjs/web/jsx-runtime` is the compiler's own entry and must resolve to
   * the real package, and `/server-functions/server` has its own shim above.
   */
  const alwaysShimmed: Record<string, string> = ariaAttributeFix
    ? { "@solidjs/web": fileURLToPath(new URL("./solid-2-aria-attributes.ts", import.meta.url)) }
    : {};
  const shimFiles = new Set([...Object.values(shims), ...Object.values(alwaysShimmed)]);
  // Matches any file inside that package's tree, however deep.
  const vendorDirs = vendorPackages.map((pkg) => `/node_modules/${pkg}/`);

  // Resolved against the CONSUMER's root, never `import.meta.url`, which is tLib
  // and still on Solid 1. `configResolved` rebinds both to `config.root`;
  // `process.cwd()` is only a fallback for a host that resolves before then.
  let rootDir = process.cwd();
  let req = createRequire(path.join(rootDir, "noop.js"));
  const REAL_PREFIX = "virtual:solid-1-compat-real/";
  // Siblings of whatever `require.resolve` picks by default. Both the
  // client/server and the dev/production axis are load-bearing; see README.md.
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
        // Delegate where a dep-optimizer browser hash can appear, so this
        // returns the SAME module id Vite gives every other importer: the road
        // below yields a bare path, and one file under two ids is two reactive
        // graphs with no exception anywhere. Not under Vitest, where deferring
        // resolution yields an empty module. Keep both roads.
        if (!process.env.VITEST) {
          // The importer is the consumer's ROOT, not `importer`: Vite resolves
          // relative to the importer, and a shim file's own path resolves
          // `solid-js` against tLib's Solid 1. Do not catch and rethrow the
          // MISSING_EXPORT that mis-resolution produces -- naming which
          // `solid-js` it found is the only readable part of it.
          const delegated = await this.resolve(realSpecifier, path.join(rootDir, "noop.js"), {
            skipSelf: true,
          });
          if (delegated) return delegated;
        }
        // Node's path functions return backslashes on Windows while Rollup
        // normalizes module ids to forward slashes, so an unnormalized path is a
        // SECOND module for the same file and the reactive core evaluates twice.
        const normalize = (p: string) => p.replaceAll("\\", "/");
        const resolved = normalize(req.resolve(realSpecifier));
        const split = POSTURE_SPLIT[realSpecifier];
        if (!split) return resolved;
        const [clientFile, serverFile] = isProduction ? split.prod : split.dev;
        const pkgRoot = path.dirname(path.dirname(resolved)); // <root>/dist/<file>.js -> <root>
        return normalize(path.join(pkgRoot, "dist", options?.ssr ? serverFile : clientFile));
      }
      // The unconditional correction first. Its own file is in `shimFiles`, so
      // it can still reach the real package through the virtual bypass.
      const always = alwaysShimmed[source];
      if (always) return shimFiles.has(importer ?? "") ? null : always;

      const shimTarget = (shims as Record<string, string>)[source];
      if (!shimTarget) return null;
      // Only the REDIRECT is gated on the importer, so a shim file asking for a
      // bare name directly is left alone rather than redirected to itself.
      if (shimFiles.has(importer ?? "")) return null;
      // Runs BEFORE the vendor gate or it never runs, and is gated on
      // `SOLID_1_ONLY_SPECIFIERS` rather than `shims`, which includes bare
      // `solid-js`. Both are load-bearing; see README.md.
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
      // Keep the diagnostic: the build failure for a surviving Solid 1
      // specifier blames `node_modules/solid-js` and names no importer.
      if (!isVendorImporter(importer, vendorDirs, source)) {
        // Both spellings are in use. Honouring one makes the flag print
        // nothing in the projects using the other.
        if (process.env.SOLID1_SHIM_DEBUG || process.env.SOLID_COMPAT_DEBUG) {
          console.log(`[shim-miss] ${source} <- ${importer}`);
        }
        return null;
      }
      return shimTarget;
    },
  };
}
