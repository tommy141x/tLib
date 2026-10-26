import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import solidPlugin from "@solidjs/vite-plugin";
import UnoCSS from "unocss/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig, type Plugin } from "vite-plus";
// Imported BY PATH, not through an alias: a vite config is loaded before
// `resolve.alias` exists, so an alias cannot name it.
import { solid1CompatShim } from "../../shared/ts/solid-compat/solid-1-compat-plugin";
import { VENDOR_PACKAGES } from "./vite/solid-compat-vendors";

// Writes to client/ui (fxmanifest's ui_page) — the only dir this plugin may delete.
// Named explicitly rather than derived: when this file lived at ui/src/, deleting
// `resolve(__dirname, "..")` minus "src" was correct; after the move to client/web/
// the same relative logic resolved to client/ and deleted every client-side Lua file.
const OUT_DIR = resolve(__dirname, "../ui");

function cleanOutDir(): Plugin {
  return {
    name: "clean-outdir",
    apply: "build",
    buildStart() {
      if (!existsSync(OUT_DIR)) return;
      if (!existsSync(resolve(OUT_DIR, "index.html")) && readdirSync(OUT_DIR).length > 0) {
        throw new Error(
          `clean-outdir: refusing to empty ${OUT_DIR} - it has content but no index.html, ` +
            "so it does not look like build output."
        );
      }
      for (const entry of readdirSync(OUT_DIR)) {
        rmSync(resolve(OUT_DIR, entry), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  define: {
    __MENU_PREVIEW__:
      command === "serve" && process.env.TLIB_MENU_PREVIEW
        ? JSON.stringify(JSON.parse(readFileSync(process.env.TLIB_MENU_PREVIEW, "utf8")))
        : "undefined",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // tLib reaches its own shared/ts by the same specifier every other resource uses.
      // It used to be the one tree doing it with relative paths, which meant a file moved
      // between client/web and shared/ts needed its importers rewritten here and nowhere
      // else, and made shared code look like tLib-internal code at the import site.
      "@tlib/shared": resolve(__dirname, "../../shared/ts"),
    },
    // shared/ts has its own solid-js (bun auto-installs peerDependencies); without dedupe
    // the alias above ships two runtime copies, and a component here reading a context
    // created in shared silently gets the default — no error. @solidjs/web is included
    // for the same reason: Solid 2 moved the DOM runtime there and shared/ts has its own
    // copy of that too.
    dedupe: ["solid-js", "@solidjs/web", "@ark-ui/solid"],
  },
  base: "./",
  build: {
    // Not `esnext`: this bundle only runs in CEF 103, and esnext lets esbuild upgrade
    // CSS syntax on the way out — `@media (min-width: 1024px)` becomes the Level 4 range
    // form `(width>=1024px)` (Chrome 104+), which CEF can't parse and serialises to
    // `@media not all`, never matching. Measured before this line existed:
    // client/ui/assets/*.css had 14 range-form queries and 0 min-width ones — every
    // responsive rule was dead in game while looking correct in a browser (same fault
    // tRadio's server/web hit). `cssTarget` is separate from `target` because Vite
    // doesn't default one from the other, and this is a browser-version constraint an
    // `esNNNN` target can't express.
    target: "es2020",
    cssTarget: "chrome103",
    // Stated, not inherited: a sourcemap embeds sourcesContent (every module's original
    // text), shipping this whole tree inside client/ui, a published FiveM resource.
    // cef-output-contract.ts never checks for .map files, so nothing else would catch it.
    // Measured across vite-plus 1.1.0 -> 1.4.0: 0 .map files before and after here, but a
    // sibling SSR project went 0 -> 299 under dist/server/assets — hence pinning rather
    // than trusting the next release's default.
    sourcemap: false,
    outDir: OUT_DIR,
    emptyOutDir: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1000,
  },
  // `solid1CompatShim` MUST BE FIRST — enforced: it throws at `configResolved` if a
  // plugin named `solid`/`solid:*` precedes it, since it has to win the specifier race
  // against `@solidjs/vite-plugin`'s own `enforce: "pre"` resolveId hooks. Losing that
  // race disables the redirect with no build error — it surfaces at runtime as `Cannot
  // read properties of undefined (reading 'effect')` and a blank panel. `cleanOutDir()`
  // only has a `buildStart` hook, so its position among the rest doesn't matter.
  plugins: [
    solid1CompatShim({ vendorPackages: [...VENDOR_PACKAGES] }),
    cleanOutDir(),
    Icons({ compiler: "solid", autoInstall: false }),
    UnoCSS(),
    solidPlugin(),
  ],

  // Vite's dependency optimizer runs before the plugin pipeline, in a reduced container
  // the shim isn't part of — anything pre-bundled here escapes the redirect and produces
  // a module id the `virtual:` bypass can't name, the two-reactive-runtimes hazard the
  // shim exists to prevent (matched by prefix, so a bare name covers subpaths). Same set
  // the shim is given, plus solid-js/@solidjs/web so the real runtime isn't pre-bundled
  // into a second copy beside what the shim hands the vendors.
  optimizeDeps: {
    exclude: ["solid-js", "@solidjs/web", ...VENDOR_PACKAGES],
  },
}));
