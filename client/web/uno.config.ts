import * as unocss from "unocss";
import { defineConfig } from "unocss";
import { tPreset } from "../../shared/ts/build/uno-preset.ts";

// presetWind3 via `target: "nui"`, and that is a constraint rather than lag.
// The dialect note in shared/ts/build/uno-preset.ts has the measurement, along
// with why there is no presetWebFonts anywhere in this stack.
export default defineConfig({
  presets: tPreset({ target: "nui", unocss }),
  theme: {
    // Only faces that are either shipped or present on the machine. Inter and
    // JetBrains Mono were named here while presetWebFonts fetched them from
    // Google; with the fetch gone, naming them would just be a lookup that
    // always misses on a game client. --font-sans is the shipped Hanken
    // Grotesk, and the mono stack is what a Windows or Linux client already has.
    fontFamily: {
      sans: ["var(--font-sans)", "sans-serif"],
      mono: ["Consolas", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
    },
  },
  safelist: ["sr-only", "not-sr-only"],
});
