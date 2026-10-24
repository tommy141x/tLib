/**
 * `--font-sans` and `--font-mono` are declared exactly once, in theme-tokens.css.
 *
 * THE BUG THIS EXISTS FOR WAS INVISIBLE AND SHIPPED FOR MONTHS. Both tokens were
 * declared in TWO unlayered `:root` blocks — theme-tokens.css and fonts.css — so neither
 * one won on specificity and the cascade fell back to `@import` ORDER. Measured in the
 * built CSS of the estate on 2026-10-24: tELS, tRadio and tUnit shipped Inter while tLib,
 * tRadar, tDetector, tAFK, tChat, tBlips and tSpawn shipped Hanken Grotesk. Three products
 * and seven products, side by side on one server, in different typefaces. Swapping two
 * adjacent import lines in tUnit changed its face with no error and no test.
 *
 * The second half was worse because it degraded rather than differed: `--font-mono` was
 * declared ONLY in fonts.css, so the five bundles importing theme-tokens.css without it
 * read `var(--font-mono)` twice from surface.css with nothing behind it. An undeclared
 * custom property makes `font-family` invalid at computed-value time, so the whole
 * declaration is dropped — `.section-label` and `.prop-input` silently inherited the sans
 * face. The same shared text field rendered mono in tELS and sans in tRadio.
 *
 * Neither failure produces a warning anywhere. The only way to catch it is to count.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED_CSS = join(import.meta.dir, "..", "..", "shared", "css");
const APP_CSS = join(import.meta.dir, "..", "..", "client", "web", "src");

/** Every `--font-sans:` / `--font-mono:` declaration, by file. Comments do not count. */
function declarationsIn(dir: string): Array<{ file: string; token: string }> {
  const found: Array<{ file: string; token: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "fonts") continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".css")) continue;
      // Strip /* … */ so the warnings in these files, which necessarily quote the token
      // names they are warning about, are not counted as declarations.
      const source = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of source.matchAll(/(--font-(?:sans|mono))\s*:/g)) {
        found.push({ file: entry.name, token: match[1] });
      }
    }
  };
  walk(dir);
  return found;
}

describe("font tokens", () => {
  test("each is declared exactly once, and only in theme-tokens.css", () => {
    const all = [...declarationsIn(SHARED_CSS), ...declarationsIn(APP_CSS)];

    for (const token of ["--font-sans", "--font-mono"]) {
      const sites = all.filter((d) => d.token === token);
      expect(
        sites.map((s) => s.file),
        `${token} must be declared once; a second unlayered declaration hands the ` +
          `choice of typeface to @import order`
      ).toEqual(["theme-tokens.css"]);
    }
  });

  test("surface.css reads --font-mono, so the token cannot be dropped", () => {
    // The reason --font-mono is non-optional: two shared recipes read it. If this ever
    // stops being true the token could move, but while it holds, any sheet that imports
    // surface.css without theme-tokens.css renders those two classes in the wrong face.
    const surface = readFileSync(join(SHARED_CSS, "surface.css"), "utf8");
    expect(surface).toContain("var(--font-mono)");
  });
});
