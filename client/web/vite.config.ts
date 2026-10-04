import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import UnoCSS from "unocss/vite";
import Icons from "unplugin-icons/vite";
import solid from "vite-plugin-solid";
import { defineConfig, type Plugin } from "vite-plus";

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
    // reading a context created in shared silently gets the context default. Invisible in
    // dev: vite-plugin-solid only dedupes solid-js when command === "dev".
    dedupe: ["solid-js", "@ark-ui/solid"],
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
  plugins: [cleanOutDir(), Icons({ compiler: "solid", autoInstall: false }), UnoCSS(), solid()],
}));
