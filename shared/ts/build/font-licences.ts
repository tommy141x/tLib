// Every webfont in a staged release ships the licence that covers it.
//
// ── Why this runs on the STAGED TREE and not on the build output ───────────
//
// tRadio already had a licence copier and a test for it, and the release still
// went out without the files. Both halves were looking at the wrong object:
//
//   · `copyFontLicences` copies `OFL-*.txt` out of a resource's OWN font
//     directory into its build output. Correct, and blind to a font that comes
//     from somewhere else -- `tLib/shared/css/fonts/` now supplies Hanken
//     Grotesk to seven resources, and its licence sits in tLib where no
//     consumer's copier looks.
//   · `scripts/font-licences.test.ts` asserts the invariant over
//     `client/ui/assets` in the WORKING TREE. That is the build output, not the
//     artifact. tRadio's packager stages by extension allowlist, `.txt` is not
//     in it, and licences are not pinned by name the way the codec2 and blip25
//     ones are -- so every OFL file was dropped on the way into the zip while
//     the gate stayed green.
//
// Measured 2026-10-18: `tRadio.zip` contained 15 .woff2 and 0 licence files.
//
// Running last, over the staged tree, is what makes those two failures
// impossible rather than unlikely: it reads the bytes that are about to be
// zipped, and it writes the licence in beside the font after any extension
// filter has already had its say.
//
// ⛔ IT SEES `.woff2` AND NOTHING ELSE, which is narrower than "every font in
// the release" and must not be read as that. Measured 2026-10-18: tRadio's
// layouts ship `CreatoDisplay.otf` (seven copies), `Mustica.otf` and
// `Charmset.ttf`, all commercial retail faces, none with a licence in the zip —
// and this gate is green on that tree. The scope is deliberate: those are not
// OFL families, so there is no `OFL-<Family>.txt` that would ever satisfy them,
// and widening the scan would only convert "unlicensed" into "unbuildable"
// without answering the question of what licence is actually held. That
// question is the owner's to answer; when it is, either the files go and this
// stays as it is, or they stay and the terms get documented beside them the way
// tUnit's `LICENSES.md` does — at which point the `LICENSES.md` branch below
// already covers them and the scan can widen.
//
// ── Why it throws ──────────────────────────────────────────────────────────
//
// OFL 1.1 condition 2 requires the notice and licence to accompany the font
// software when it is bundled or sold, which is exactly what a paid FiveM
// resource does. A warning here would be a compliance defect that scrolls past
// in a build log. `copyFontLicences` warns rather than fails ON PURPOSE because
// it runs on every UI build; this runs only at package time, which is the place
// its own comment already named as "where absence should be fatal".

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Every `.woff2` under `dir`, recursively, as absolute paths. */
function woff2Under(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...woff2Under(full));
    else if (entry.toLowerCase().endsWith(".woff2")) out.push(full);
  }
  return out;
}

/**
 * `OFL-JetBrainsMono.txt` -> `jetbrainsmono`.
 *
 * Letters only, so the licence spelling and the filename spelling do not have to
 * agree on hyphens or case: `OFL-HankenGrotesk.txt` and
 * `hanken-grotesk-latin-CaVRRdDk.woff2` both reduce to a comparable `hanken…`.
 */
function licenceKey(file: string): string {
  return basename(file)
    .replace(/^OFL-/i, "")
    .replace(/\.txt$/i, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * `hanken-grotesk-latin-CaVRRdDk.woff2` -> `hankengroteskLatincavrrddk`-ish.
 *
 * Digits go as well as punctuation, so `inter-100-900-latin` reduces to
 * `interlatin…` and still starts with `inter`. The comparison below is a PREFIX
 * match rather than `includes`, because a short family name like `inter` would
 * otherwise match any file that happens to contain those five letters.
 */
function fontKey(file: string): string {
  return basename(file).toLowerCase().replace(/[^a-z]/g, "");
}

export interface FontLicenceResult {
  /** Licence files copied in, as paths relative to nothing in particular — for logging. */
  copied: string[];
  /** Families that already had their licence beside them. */
  satisfied: string[];
}

/**
 * Put a licence beside every staged webfont, or throw naming what is uncovered.
 *
 * @param distDir     The staged tree about to be zipped.
 * @param licenceDirs Directories to look for `OFL-*.txt` in, most specific
 *                    first: the resource's own font source, then tLib's.
 *
 * A directory that already contains a `LICENSES.md` is taken as covering the
 * fonts in it and is left alone. That is tUnit's `web/fonts/`, where three
 * display faces are documented together with their copyright lines and links --
 * a better artifact than three more OFL dumps, and not one to break.
 */
export function stageFontLicences(distDir: string, licenceDirs: string[]): FontLicenceResult {
  const available = new Map<string, string>();
  // Later directories must not shadow earlier ones: the resource's own copy of a
  // licence wins over tLib's, so a resource pinning an older version of a face
  // ships the text that matches it.
  for (const dir of licenceDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!/^OFL-.*\.txt$/i.test(entry)) continue;
      const key = licenceKey(entry);
      if (!available.has(key)) available.set(key, join(dir, entry));
    }
  }

  const copied: string[] = [];
  const satisfied: string[] = [];
  const uncovered: string[] = [];

  for (const font of woff2Under(distDir)) {
    const here = dirname(font);
    if (existsSync(join(here, "LICENSES.md"))) {
      satisfied.push(basename(font));
      continue;
    }
    const key = fontKey(font);
    const match = [...available.entries()]
      .filter(([family]) => key.startsWith(family))
      // Longest family first, so `jetbrainsmono` is preferred over a
      // hypothetical `jetbrains` rather than chosen by map order.
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (match === undefined) {
      uncovered.push(basename(font));
      continue;
    }
    const dest = join(here, basename(match[1]));
    if (existsSync(dest)) {
      satisfied.push(basename(font));
      continue;
    }
    copyFileSync(match[1], dest);
    copied.push(`${basename(dest)} -> ${here}`);
  }

  if (uncovered.length > 0) {
    throw new Error(
      "These staged fonts have no licence to ship beside them:\n" +
        [...new Set(uncovered)].map((f) => `  ${f}`).join("\n") +
        "\n\nOFL 1.1 condition 2 requires the notice and licence to accompany the font " +
        "software when it is bundled or sold, and this zip is sold. Add the family's " +
        "`OFL-<Family>.txt` to one of:\n" +
        licenceDirs.map((d) => `  ${d}`).join("\n") +
        "\nor, for a directory of faces documented together, a `LICENSES.md` beside them."
    );
  }

  return { copied, satisfied };
}
