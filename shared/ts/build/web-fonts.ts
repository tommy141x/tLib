/**
 * Self-host a bundle's web fonts instead of fetching them from Google at runtime.
 *
 * `presetWebFonts` (and a hand-written `@import` for fonts.googleapis.com) emits an
 * `@font-face` per weight per subset whose `src` is a fonts.gstatic.com URL. That is a
 * third-party request made from inside the game, and it is wrong in every place a NUI
 * bundle runs:
 *
 * - In game. The NUI is CEF served from the resource's own origin. A customer's server
 *   or a player's network may not reach fonts.gstatic.com, and when it does not the UI
 *   silently falls back to a system face mid-render rather than failing visibly.
 * - In an offline preview or gallery shot. Those are rendered headless, often with no
 *   network at all, so the screenshots disagree with the game.
 * - On a marketplace page embedding the preview, where an off-origin request is usually
 *   a property the page is not allowed to have.
 *
 * This downloads the subsets a bundle actually needs and emits a `fonts.css` carrying
 * Google's own `unicode-range` declarations verbatim — so the browser still fetches only
 * the subset a page needs, it just fetches it from the resource.
 *
 * The generated CSS is committed. This runs on demand, not as part of a build: a build
 * that reaches the network fails in CI and on a customer's machine.
 *
 * Licensing is the caller's problem to state, not this function's to assume. Pass
 * `license` and it goes in the generated header; the actual license file still has to be
 * placed next to the woff2 files by whoever chose the family.
 */
import fs from "node:fs";
import path from "node:path";

/** One family to fetch, as Google's CSS2 API names it. */
export interface WebFontFamily {
  /** The CSS `font-family` name, e.g. "JetBrains Mono". */
  family: string;
  /** The `family=` value of a fonts.googleapis.com/css2 URL, e.g. "Inter:wght@400;500". */
  query: string;
  /** Filename prefix for this family's woff2 files, e.g. "jetbrains-mono". */
  slug: string;
}

export interface SelfHostWebFontsOptions {
  families: WebFontFamily[];
  /** Absolute directory the woff2 files are written to. Created if absent. */
  outFonts: string;
  /** Absolute path of the generated CSS. */
  outCss: string;
  /**
   * URL prefix used for `src:` inside the generated CSS, relative to `outCss`.
   * Defaults to the real relative path from `outCss` to `outFonts`, which is right
   * whenever both live in the same source tree.
   */
  hrefPrefix?: string;
  /**
   * Subsets to keep. Defaults to latin plus latin-ext: the FiveM market is heavily
   * European, and without latin-ext a Polish or Turkish string falls back to a system
   * font in the middle of a sentence.
   */
  subsets?: string[];
  /** Licence line for the generated header, e.g. "SIL Open Font License 1.1". */
  license?: string;
  /** Command that regenerates this file, quoted in the header. */
  regenerateWith?: string;
  /** Extra prose appended to the generated header, for repo-specific reasons. */
  note?: string;
  log?: (message: string) => void;
}

export interface SelfHostWebFontsResult {
  faces: number;
  bytes: number;
  files: string[];
}

// Google serves a different (and much smaller) stylesheet to clients it does not
// believe support woff2, so the UA is not decoration.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Google emits `/* subset *\/` immediately before each `@font-face` it labels. */
const FACE_RE = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]+\})/g;

function buildHeader(opts: SelfHostWebFontsOptions): string {
  const lines = [
    "/* ---------------------------------------------------------------------------",
    "   Fonts — self-hosted, generated. Do not hand-edit.",
    "",
  ];
  if (opts.regenerateWith) {
    lines.push(`   Regenerate with: ${opts.regenerateWith}`, "");
  }
  lines.push(
    "   Not fetched from Google at runtime: this bundle renders inside the game's",
    "   NUI (CEF, on the resource's own origin) and in offline previews, and a",
    "   fonts.gstatic.com request fails silently in both — the UI drops to a system",
    "   face rather than showing an error.",
    "",
    "   The unicode-range values are Google's own, kept verbatim so the browser still",
    "   downloads only the subset a page needs rather than every face.",
  );
  if (opts.license) {
    lines.push(
      "",
      `   Fonts are ${opts.license}. Redistribution is permitted; the license file`,
      "   must travel with the woff2 files — see the license alongside them.",
    );
  }
  if (opts.note) {
    lines.push("", ...opts.note.trimEnd().split("\n").map((l) => `   ${l}`.trimEnd()));
  }
  lines.push("   --------------------------------------------------------------------------- */", "");
  return `${lines.join("\n")}\n`;
}

export async function selfHostWebFonts(
  opts: SelfHostWebFontsOptions,
): Promise<SelfHostWebFontsResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const want = new Set(opts.subsets ?? ["latin", "latin-ext"]);
  // POSIX separators: this string goes into a URL, not onto the filesystem, and on
  // Windows path.relative hands back backslashes that a browser reads as escapes.
  const href = (opts.hrefPrefix ?? path.relative(path.dirname(opts.outCss), opts.outFonts)).replace(
    /\\/g,
    "/",
  );

  fs.mkdirSync(opts.outFonts, { recursive: true });

  const blocks: string[] = [];
  const files: string[] = [];
  let bytes = 0;

  for (const { family, query, slug } of opts.families) {
    const res = await fetch(
      `https://fonts.googleapis.com/css2?family=${query}&display=swap`,
      { headers: { "User-Agent": UA } },
    );
    if (!res.ok) throw new Error(`${family}: Google returned ${res.status} for "${query}"`);
    const css = await res.text();

    let kept = 0;
    for (const [, subset, block] of css.matchAll(FACE_RE)) {
      if (!want.has(subset)) continue;

      const url = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
      const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1].trim();
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1].replace(/\s+/g, " ").trim();
      if (!url || !weight || !range) throw new Error(`could not parse a ${family} ${subset} block`);

      // Variable faces declare a range ("100 800"); static ones a single number.
      const name = `${slug}-${weight.replace(/\s+/g, "-")}-${subset}.woff2`;
      const face = await fetch(url, { headers: { "User-Agent": UA } });
      if (!face.ok) throw new Error(`${name}: ${face.status} fetching ${url}`);
      const buf = Buffer.from(await face.arrayBuffer());
      fs.writeFileSync(path.join(opts.outFonts, name), buf);
      bytes += buf.length;
      files.push(name);
      log(`  ${name.padEnd(42)} ${(buf.length / 1024).toFixed(1)} kB`);

      blocks.push(
        [
          `/* ${family} ${weight} — ${subset} */`,
          "@font-face {",
          `  font-family: "${family}";`,
          "  font-style: normal;",
          `  font-weight: ${weight};`,
          "  font-display: swap;",
          `  src: url("${href}/${name}") format("woff2");`,
          `  unicode-range: ${range};`,
          "}",
        ].join("\n"),
      );
      kept++;
    }
    if (kept === 0) throw new Error(`${family}: no faces matched subsets ${[...want].join(", ")}`);
    log(`${family}: ${kept} faces\n`);
  }

  fs.mkdirSync(path.dirname(opts.outCss), { recursive: true });
  fs.writeFileSync(opts.outCss, `${buildHeader(opts)}${blocks.join("\n\n")}\n`);
  log(`css -> ${opts.outCss} (${blocks.length} faces, ${(bytes / 1024).toFixed(0)} kB)`);

  return { faces: blocks.length, bytes, files };
}
