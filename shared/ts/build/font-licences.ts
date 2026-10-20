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
// the release" and must not be read as that. tRadio's layouts ship
// `CreatoDisplay.otf` (seven copies), `Mustica.otf` and `Charmset.ttf`, and
// this gate is green on all three.
//
// That is settled rather than overlooked: asked on 2026-10-18, the owner
// confirmed Creato Display is licensed free for commercial use, and the other
// two on the same footing. They are not OFL families, so no `OFL-<Family>.txt`
// could ever satisfy them, and widening the scan would turn a licensing
// question into an unbuildable release without answering anything.
//
// So do not "fix" this by making the scan read `.otf`/`.ttf`. If a face is ever
// added whose terms DO need to travel with it, the `LICENSES.md` branch below
// already covers that case — document it beside the fonts the way tUnit's
// `web/fonts/LICENSES.md` does, and it is satisfied without touching the scan.
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
/**
 * Which staged fonts have no licence available to them. READS ONLY.
 *
 * Split out of `stageFontLicences` so a release gate can ask the question
 * without answering it. The stager copies, so a test that called it would
 * REPAIR the tree it was checking: a missing licence gets copied in by the act
 * of testing and the run reports success. That is a gate that cannot fail, and
 * it would also be a test writing into the artifact.
 *
 * Exported so there is exactly one matcher in the estate. tRadio had a second
 * one -- its release test re-derived the family as the first hyphen-separated
 * token, so `hanken-grotesk-latin.woff2` yielded `hanken`, matched no licence,
 * and needed a hand-kept alias table to paper over it. Every alias in such a
 * table is a family this normalisation already handles; the table only exists
 * because the derivation was wrong. A caller that wants to assert on the
 * shipped files should walk them with this, not re-implement it.
 *
 * @returns basenames of staged woff2 files with no licence beside them and
 *          none available to copy. Empty means covered.
 */
export function uncoveredFonts(distDir: string, licenceDirs: string[]): string[] {
  const available = availableLicences(licenceDirs);
  const uncovered: string[] = [];
  for (const font of woff2Under(distDir)) {
    if (coverageFor(font, available) === null) uncovered.push(basename(font));
  }
  return [...new Set(uncovered)];
}

/** `OFL-*.txt` by normalised family, earlier directories winning. */
function availableLicences(licenceDirs: string[]): Map<string, string> {
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
  return available;
}

/** Whether an `OFL-*.txt` in the font's own directory matches its family. */
function licenceBesideFont(font: string): boolean {
  const here = dirname(font);
  const key = fontKey(font);
  if (!existsSync(here)) return false;
  return readdirSync(here).some(
    (entry) => /^OFL-.*\.txt$/i.test(entry) && key.startsWith(licenceKey(entry))
  );
}

/**
 * How this font is covered: `"satisfied"` if a licence already sits beside it,
 * the source path of the licence to copy, or `null` for uncovered.
 */
function coverageFor(font: string, available: Map<string, string>): "satisfied" | string | null {
  const here = dirname(font);
  if (existsSync(join(here, "LICENSES.md"))) return "satisfied";

  // A licence ALREADY beside the font covers it, whether or not the family is
  // also in a source directory. The stager never needed this -- it only ever
  // asked "what should I copy here" -- but the gate asks a different question:
  // is what a customer receives covered. A face vendored straight into a
  // resource's output, with its licence, is covered and must not be reported
  // as a violation because tLib happens not to carry that family.
  if (licenceBesideFont(font)) return "satisfied";

  const key = fontKey(font);
  const match = [...available.entries()]
    .filter(([family]) => key.startsWith(family))
    // Longest family first, so `jetbrainsmono` is preferred over a
    // hypothetical `jetbrains` rather than chosen by map order.
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (match === undefined) return null;
  return existsSync(join(here, basename(match[1]))) ? "satisfied" : match[1];
}

export function stageFontLicences(distDir: string, licenceDirs: string[]): FontLicenceResult {
  const available = availableLicences(licenceDirs);

  const copied: string[] = [];
  const satisfied: string[] = [];
  const uncovered: string[] = [];

  for (const font of woff2Under(distDir)) {
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
        "\n\nOFL 1.1 condition 2 requires the notice and licence to accompany the font " +
        "software when it is bundled or sold, and this zip is sold. Add the family's " +
        "`OFL-<Family>.txt` to one of:\n" +
        licenceDirs.map((d) => `  ${d}`).join("\n") +
        "\nor, for a directory of faces documented together, a `LICENSES.md` beside them."
    );
  }

  return { copied, satisfied };
}
