import {
  defineConfig,
  presetAttributify,
  presetTypography,
  presetWind3,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";

// No presetWebFonts. It is the only thing in this config that emits @font-face,
// and every face it emitted was a fonts.gstatic.com URL: a NUI page runs inside
// the game client, which has no route to the internet, so each one was a request
// that could only fail and then fall back to a system face. The faces this UI
// actually uses are self-hosted next to the bundle -- see the @font-face for
// Hanken Grotesk in src/global.css, which Vite fingerprints and rewrites to a
// relative URL so it resolves under nui://.
//
// The utilities are unaffected: `font-sans` and `font-mono` are generated from
// theme.fontFamily below, which the preset never supplied.
export default defineConfig({
  presets: [presetWind3(), presetAttributify(), presetTypography()],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  rules: [
    [
      "bg-background",
      {
        "background-color": "hsl(var(--background) / var(--background-opacity, 1))",
        "backdrop-filter": "var(--backdrop-blur, none) var(--backdrop-saturate, none)",
        "-webkit-backdrop-filter": "var(--backdrop-blur, none) var(--backdrop-saturate, none)",
      },
    ],
  ],
  theme: {
    colors: {
      border: "hsl(var(--border))",
      input: "hsl(var(--input))",
      ring: "hsl(var(--ring))",
      background: "hsl(var(--background))",
      foreground: "hsl(var(--foreground))",
      primary: {
        DEFAULT: "hsl(var(--primary))",
        foreground: "hsl(var(--primary-foreground))",
      },
      secondary: {
        DEFAULT: "hsl(var(--secondary))",
        foreground: "hsl(var(--secondary-foreground))",
      },
      destructive: {
        DEFAULT: "hsl(var(--destructive))",
        foreground: "hsl(var(--destructive-foreground))",
      },
      muted: {
        DEFAULT: "hsl(var(--muted))",
        foreground: "hsl(var(--muted-foreground))",
      },
      accent: {
        DEFAULT: "hsl(var(--accent))",
        foreground: "hsl(var(--accent-foreground))",
      },
      popover: {
        DEFAULT: "hsl(var(--popover))",
        foreground: "hsl(var(--popover-foreground))",
      },
      card: {
        DEFAULT: "hsl(var(--card))",
        foreground: "hsl(var(--card-foreground))",
      },
    },
    borderRadius: {
      lg: "var(--radius)",
      md: "calc(var(--radius) - 2px)",
      sm: "calc(var(--radius) - 4px)",
    },
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
