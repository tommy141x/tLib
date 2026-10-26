import * as unocss from "unocss";
import { defineConfig } from "unocss";
import { tPreset } from "../../shared/ts/build/uno-preset.ts";

// presetWind3 via `target: "nui"` is a constraint, not lag — see the dialect note
// in shared/ts/build/uno-preset.ts for the measurement and why no presetWebFonts
// is used in this stack.
export default defineConfig({
  presets: tPreset({ target: "nui", unocss }),
  theme: {
    // Only faces shipped or present on the client: Inter/JetBrains Mono were dropped
    // with presetWebFonts (Google-fetch always misses in game). --font-sans is Hanken
    // Grotesk; mono is the client OS's own stack. `.prop-input` once hard-coded a
    // literal font list instead of this token, so mono text could render in two
    // different faces side by side.
    fontFamily: {
      sans: ["var(--font-sans)", "sans-serif"],
      mono: ["var(--font-mono)", "monospace"],
    },
  },
  safelist: ["sr-only", "not-sr-only"],
});
