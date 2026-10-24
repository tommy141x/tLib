// Every font in a staged release ships the licence that covers it.
//
// Runs on the STAGED TREE, last, because the two checks that preceded it both
// watched the wrong object and a release still went out uncovered. tRadio's
// `copyFontLicences` copies out of a resource's OWN font directory, so it cannot
// see Hanken Grotesk arriving from `tLib/shared/css/fonts/`; its test asserted
// over `client/ui/assets` in the working tree, which is build output and not the
// artifact. tRadio stages by extension allowlist, `.txt` is not in it, and font
// licences were not pinned by name the way codec2's and blip25's are. Measured
// 2026-10-18: `tRadio.zip` held 15 .woff2 and 0 licence files. Reading the bytes
// that are about to be zipped is what makes that impossible rather than unlikely.
//
// It reads `.otf`/`.ttf` and not just `.woff2`, since 2026-10-23. The comment
// here used to argue the layout faces were settled as "free for commercial use".
// Their own OpenType name tables disproved it: `CreatoDisplay.otf` (7 layouts) is
// SIL OFL -- nameID 14 `http://scripts.sil.org/OFL`, nameID 0 `Copyright (c) 2021
// by Anugrah Pasau`; `Charmset.ttf` is CC BY-SA 3.0 per nameID 13/14, where
// attribution is a condition; `Mustica.otf` carries no grant at all. Hence
// `LICEN[CS]E-<Family>.txt` beside `OFL-<Family>.txt` -- a non-OFL face needs
// somewhere to put non-OFL terms that the stager can still copy.
//
// It throws rather than warns because OFL 1.1 condition 2 binds a font that is
// bundled or sold, which is what this zip is, and a warning is a compliance
// defect that scrolls past in a build log. `copyFontLicences` warns deliberately:
// it runs on every UI build, where failing would be worse. This runs only at
// package time.

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// `.woff2` is what Vite emits; the rest are what a layout or a vendored face
// ships as. Identical obligation, so the scan must not tell them apart.
const FONT_EXTENSIONS = [".woff2", ".woff", ".otf", ".ttf"];

/** Every font file under `dir`, recursively, as absolute paths. */
function fontsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...fontsUnder(full));
    else {
      const lower = entry.toLowerCase();
      if (FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) out.push(full);
    }
  }
  return out;
}

/**
 * `OFL-CreatoDisplay.txt`, `LICENSE-Charmset.txt`, `LICENCE-Charmset.txt`.
 *
 * A bare `LICENSE.txt` deliberately does not match: the `-<Family>` part is what
 * attributes a licence to a face rather than to a directory.
 */
const LICENCE_FILE = /^(?:OFL|LICEN[CS]E)-.+\.txt$/i;

/**
 * `OFL-JetBrainsMono.txt` -> `jetbrainsmono`. Letters only, so the licence
 * spelling and the filename spelling need not agree on hyphens or case.
 */
function licenceKey(file: string): string {
  return basename(file)
    .replace(/^(?:OFL|LICEN[CS]E)-/i, "")
    .replace(/\.txt$/i, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * `hanken-grotesk-latin-CaVRRdDk.woff2` -> `hankengroteskLatincavrrddk`-ish.
 *
 * Digits go too, so `inter-100-900-latin` still starts with `inter`. Matching is
 * a PREFIX test rather than `includes`, because a short family name like `inter`
 * would otherwise match any file containing those five letters.
 */
function fontKey(file: string): string {
  return basename(file)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export interface FontLicenceResult {
  /** Licence files copied in, as paths relative to nothing in particular — for logging. */
  copied: string[];
  /** Families that already had their licence beside them. */
  satisfied: string[];
}

/**
 * Which staged fonts have no licence available to them. READS ONLY.
 *
 * Split from `stageFontLicences` so a gate can ask the question without
 * answering it. The stager copies, so a test that called it would REPAIR the tree
 * it was checking and report success — a gate that cannot fail, and a test
 * writing into the artifact.
 *
 * Exported so there is exactly ONE matcher in the estate. tRadio's release test
 * had a second, deriving the family as the first hyphen-separated token, so
 * `hanken-grotesk-latin.woff2` yielded `hanken`, matched no licence, and needed a
 * hand-kept alias table to paper over it.
 *
 * @returns basenames of staged fonts with no licence beside them and none
 *          available to copy. Empty means covered.
 */
export function uncoveredFonts(distDir: string, licenceDirs: string[]): string[] {
  const available = availableLicences(licenceDirs);
  const uncovered: string[] = [];
  for (const font of fontsUnder(distDir)) {
    if (coverageFor(font, available) === null) uncovered.push(basename(font));
  }
  return [...new Set(uncovered)];
}

/** `OFL-*.txt` by normalised family, earlier directories winning. */
function availableLicences(licenceDirs: string[]): Map<string, string> {
  const available = new Map<string, string>();
  // The resource's own copy of a licence must win over tLib's, so a resource
  // pinning an older version of a face ships the text that matches it.
  for (const dir of licenceDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!LICENCE_FILE.test(entry)) continue;
      const key = licenceKey(entry);
      if (!available.has(key)) available.set(key, join(dir, entry));
    }
  }
  return available;
}

/** Whether an `OFL-*.txt` in the font's own directory matches its family. */
function licenceBesideFont(font: string): boolean {
  const here = dirname(font);
  const key = fontKey(font);
  if (!existsSync(here)) return false;
  return readdirSync(here).some(
    (entry) => LICENCE_FILE.test(entry) && key.startsWith(licenceKey(entry))
  );
}

/**
 * How this font is covered: `"satisfied"` if a licence already sits beside it,
 * the source path of the licence to copy, or `null` for uncovered.
 */
function coverageFor(font: string, available: Map<string, string>): "satisfied" | string | null {
  const here = dirname(font);

  // A `LICENSES.md` beside the faces covers the ones it NAMES, and only those.
  //
  // It used to cover everything in the directory, which made the gate answer a
  // question nobody asked: the file's existence, not the face's coverage. Drop a
  // fourth face into tUnit's `web/fonts/` -- the directory this exemption was written
  // for, where three faces are documented together -- and the archive shipped it
  // undocumented with the gate green, because a sibling file happened to exist.
  //
  // Matched on the file name, because that is how the document is organised: each
  // face gets a `## \`condensed.woff2\` -- Barlow Condensed 900` heading. A face the
  // index does not mention falls through to the normal search for a licence of its
  // own, which is exactly what should happen to a face nobody documented.
  const index = join(here, "LICENSES.md");
  if (existsSync(index) && readFileSync(index, "utf8").includes(basename(font))) {
    return "satisfied";
  }

  // A licence already beside the font covers it whether or not the family is also
  // in a source directory. The stager never needed this — it only asked "what
  // should I copy here" — but the gate asks whether what a customer receives is
  // covered, and a face vendored straight into a resource's output with its
  // licence is covered.
  if (licenceBesideFont(font)) return "satisfied";

  const key = fontKey(font);
  const match = [...available.entries()]
    .filter(([family]) => key.startsWith(family))
    // Longest family first, so `jetbrainsmono` is preferred over a hypothetical
    // `jetbrains` rather than chosen by map order.
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (match === undefined) return null;
  return existsSync(join(here, basename(match[1]))) ? "satisfied" : match[1];
}

export interface StageFontLicenceOptions {
  /**
   * Fail if the staged tree contains no fonts at all.
   *
   * Off by default because tAdmin, tAI, tBoost, tChirp, tCinematic, tDB and tMenu
   * legitimately ship zero fonts (counted 2026-10-23) through the same
   * `buildResource`. On for a resource KNOWN to ship them, where "examined
   * nothing, found nothing wrong" is the failure this file exists because of:
   * tRadio stages 24 font files, so zero means the scan lost its subject.
   */
  requireFonts?: boolean;
}

/**
 * Put a licence beside every staged font, or throw naming what is uncovered.
 *
 * @param distDir     The staged tree about to be zipped.
 * @param licenceDirs Where to look for licences, most specific first: the
 *                    resource's own font source, then tLib's.
 *
 * A directory that already holds a `LICENSES.md` is taken as covering the fonts
 * in it and left alone. That is tUnit's `web/fonts/`, where three display faces
 * are documented together with their copyright lines and links — a better
 * artifact than three more OFL dumps, and not one to break.
 */
export function stageFontLicences(
  distDir: string,
  licenceDirs: string[],
  options: StageFontLicenceOptions = {}
): FontLicenceResult {
  const available = availableLicences(licenceDirs);

  const copied: string[] = [];
  const satisfied: string[] = [];
  const uncovered: string[] = [];

  const fonts = fontsUnder(distDir);
  if (options.requireFonts === true && fonts.length === 0) {
    throw new Error(
      `No fonts found under ${distDir}, but this resource is declared to ship them. ` +
        "The scan measured nothing, so its silence proves nothing. Either the staged " +
        `tree is wrong or the extensions it looks for (${FONT_EXTENSIONS.join(", ")}) ` +
        "no longer cover what the build emits."
    );
  }

  for (const font of fonts) {
    const coverage = coverageFor(font, available);
    if (coverage === null) {
      uncovered.push(basename(font));
    } else if (coverage === "satisfied") {
      satisfied.push(basename(font));
    } else {
      const dest = join(dirname(font), basename(coverage));
      copyFileSync(coverage, dest);
      copied.push(`${basename(dest)} -> ${dirname(font)}`);
    }
  }

  if (uncovered.length > 0) {
    throw new Error(
      "These staged fonts have no licence to ship beside them:\n" +
        [...new Set(uncovered)].map((f) => `  ${f}`).join("\n") +
        "\n\nOFL 1.1 condition 2, and CC BY-SA 3.0 section 4(a), both require the notice " +
        "and licence to accompany the font software when it is bundled or sold, and this " +
        "zip is sold. Add the family's `OFL-<Family>.txt` or `LICENSE-<Family>.txt` to " +
        "one of:\n" +
        licenceDirs.map((d) => `  ${d}`).join("\n") +
        "\nor, for a directory of faces documented together, a `LICENSES.md` beside them." +
        "\n\nFIRST read the face's own OpenType name table -- nameID 0, 13 and 14 -- not its " +
        "download page. If it carries no grant at all (nameID 13 merely repeating the " +
        "copyright line, no nameID 14) then no licence file can honestly be written for it, " +
        "and this is a DECISION rather than a missing file: either proof of a purchased " +
        "licence filed beside the font, or replace the face. Do NOT write a notice from " +
        "memory. tRadio's `Mustica.otf` was exactly this case and was resolved on " +
        "2026-10-23 by replacing it with an OFL-licensed face."
    );
  }

  return { copied, satisfied };
}
