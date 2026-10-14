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

// The build writes to client/ui (fxmanifest's ui_page), and that directory is
// the only thing this plugin may ever delete from.
//
// It used to clean `resolve(__dirname, "..")` minus an entry named "src". That was
// right when this file lived at ui/src/, where ".." was ui/ and held only build
// output. After the move to client/web/, the same line resolved to client/ and
// deleted every client-side Lua file on the next build. Name the directory; never
// derive it from where this file happens to sit.
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
    // shared/ts has its own solid-js (bun auto-installs peerDependencies), so without this
    // the alias above puts two copies of the runtime in the bundle and any component here
    // reading a context created in shared silently gets the context default — no error, no
    // warning. `@solidjs/web` joins the list for exactly the same reason `solid-js` was on
    // it: Solid 2 moved the DOM runtime there, and shared/ts carries its own copy of that
    // too, so leaving it off would give this bundle two DOM runtimes instead of two cores.
    dedupe: ["solid-js", "@solidjs/web", "@ark-ui/solid"],
  },
  base: "./",
  build: {
    // Not `esnext`. This bundle only ever runs in the game's NUI, and CEF is Chrome 103.
    // `esnext` tells esbuild every feature is available, so it is free to *upgrade* syntax
    // on the way out — and the CSS is where it bites: `@media (min-width: 1024px)` is
    // rewritten to the Media Queries Level 4 range form `@media (width>=1024px)`, which is
    // Chrome 104. CEF cannot parse it, so it serialises the whole query to `@media not all`
    // — a condition that never matches.
    //
    // Measured on the shipped bundle before this line existed: `client/ui/assets/*.css` had
    // 14 range-form queries and zero `min-width` ones, i.e. every responsive rule in the
    // menu and every NUI panel was dead in game while looking correct in a browser. Same
    // fault tRadio's `server/web` hit and fixed; this tree had it too and nobody had looked.
    //
    // `cssTarget` is stated separately from `target` because Vite only defaults one to the
    // other, and the constraint here is a *browser* version, which an `esNNNN` target does
    // not express.
    target: "es2020",
    cssTarget: "chrome103",
    outDir: OUT_DIR,
    emptyOutDir: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1000,
  },
  // `solid1CompatShim` MUST BE FIRST, and it is enforced rather than only
  // documented — the plugin throws at `configResolved` if any plugin named
  // `solid` or `solid:*` precedes it. It carries `enforce: "pre"` and has to win
  // the specifier race against `@solidjs/vite-plugin`'s own `enforce: "pre"`
  // resolveId hooks for the same specifiers. Losing that race disables the whole
  // redirect with NO build error; it appears at runtime as `Cannot read
  // properties of undefined (reading 'effect')` and a blank panel.
  //
  // `cleanOutDir()` follows it rather than leading, which it no longer may: it
  // only has a `buildStart` hook, so its position among the others does not
  // affect what it deletes.
  plugins: [
    solid1CompatShim({ vendorPackages: [...VENDOR_PACKAGES] }),
    cleanOutDir(),
    Icons({ compiler: "solid", autoInstall: false }),
    UnoCSS(),
    solidPlugin(),
  ],

  // Vite's dependency optimizer runs BEFORE the plugin pipeline, in a reduced
  // plugin container the shim is not part of. Anything it pre-bundles escapes
  // the redirect entirely and produces a module id the `virtual:` bypass can
  // never name — which is the two-reactive-runtimes hazard the shim exists to
  // prevent. Vite matches these by prefix, so a bare name covers its subpaths.
  //
  // The set is the same one the shim is given, by construction. `solid-js` and
  // `@solidjs/web` are on it as well so the real runtime is never pre-bundled
  // into a second copy beside the one the shim hands the vendors.
  optimizeDeps: {
    exclude: ["solid-js", "@solidjs/web", ...VENDOR_PACKAGES],
  },
}));
