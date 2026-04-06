import { resolve } from "node:path";
import UnoCSS from "unocss/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";

export default defineConfig({
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
	base: "./",
	build: {
		target: "esnext",
		outDir: "../build",
		emptyOutDir: true,
		modulePreload: { polyfill: false },
		chunkSizeWarningLimit: 1000,
	},
	plugins: [Icons({ compiler: "solid" }), UnoCSS(), solid()],
});
