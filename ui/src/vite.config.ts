import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import UnoCSS from "unocss/vite";
import Icons from "unplugin-icons/vite";
import solid from "vite-plugin-solid";
import { defineConfig, type Plugin } from "vite-plus";

function cleanOutDir(): Plugin {
  return {
    name: "clean-outdir",
    buildStart() {
      const outDir = resolve(__dirname, "..");
      for (const entry of readdirSync(outDir)) {
        if (entry === "src") continue;
        rmSync(resolve(outDir, entry), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  base: "./",
  build: {
    target: "esnext",
    outDir: "..",
    emptyOutDir: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1000,
  },
  plugins: [cleanOutDir(), Icons({ compiler: "solid" }), UnoCSS(), solid()],
});
