/**
 * One `server/LICENSE.txt` per release, instead of a litter of legal files at the root.
 *
 * A resource root is the first thing an operator sees when they extract the zip, and it
 * was carrying up to four documents that none of them ever need to open: the licence,
 * the third-party notices, and in two cases a standalone Apache or OFL text. They are
 * merged into a single file now, under `server/`, chosen by the owner.
 *
 * The REPO keeps the documents separate -- they are edited by different things at
 * different times, and `LICENSE`/`LICENSE.md` at a repo root is what GitHub reads to
 * label a public repository. Only the ARCHIVE is merged. That is the whole reason this
 * runs at staging time rather than a file being moved on disk.
 *
 * Nothing legal is lost by the move. MIT, Apache-2.0 and OFL 1.1 each bind the copy you
 * distribute and require the notice to travel INSIDE it; none of the three says where.
 * What they do require is that it be findable, which is why this writes one obviously
 * named file rather than hiding the texts in a dotfolder.
 *
 * The per-font licences are NOT part of this. They stay beside the faces they cover, in
 * `client/ui/assets/` and `web/fonts/`, because "a licence next to every staged font" is
 * the invariant `stageFontLicences` proves on every build -- pooling them here would
 * leave the gate unable to say which face any given text covers.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LicenceSource {
  /** Section heading in the merged file. */
  title: string;
  /** Path relative to the resource root. */
  file: string;
}

export interface LicenceBundleSpec {
  /** Resource root, where the source documents live. */
  root: string;
  /** The staged tree about to be zipped. */
  dist: string;
  /** Resource name, for the header. */
  name: string;
  /** In order. The first is the one a buyer is looking for. */
  sources: LicenceSource[];
  /** Where it lands in the staged tree. Defaults to `server/LICENSE.txt`. */
  out?: string;
}

export interface LicenceBundleResult {
  /** Path written, relative to the staged tree. */
  out: string;
  bytes: number;
  sections: string[];
}

const RULE = "=".repeat(78);

export function mergeLicenceFiles(spec: LicenceBundleSpec): LicenceBundleResult {
  const outRel = spec.out ?? "server/LICENSE.txt";

  if (spec.sources.length === 0) {
    // A merge of nothing writes a header and reports success, which is the shape of
    // "green while measuring nothing" this estate keeps paying for.
    throw new Error(`${spec.name}: mergeLicenceFiles was given no sources`);
  }

  const parts: string[] = [];
  const sections: string[] = [];

  for (const source of spec.sources) {
    const full = join(spec.root, source.file);
    if (!existsSync(full) || statSync(full).size === 0) {
      throw new Error(
        `${spec.name}: ${source.file} is missing or empty, so the release would ship ` +
          "without it. This file is a licence condition, not documentation."
      );
    }
    parts.push(readFileSync(full, "utf8").trimEnd());
    sections.push(source.title);
  }

  const contents = sections.map((title, i) => `  ${i + 1}. ${title}`).join("\n");
  const header = [
    `${spec.name} — licence, notices and attribution`,
    RULE,
    "",
    "Everything that legally travels with this copy of the resource is in this one file,",
    "rather than scattered across the resource root:",
    "",
    contents,
    "",
    "Typeface licences are the exception and are NOT here: each one sits beside the font",
    "it covers, so the two cannot be separated by someone moving a directory.",
    "",
  ].join("\n");

  const body = parts
    .map((text, i) => [RULE, `${i + 1}. ${sections[i]}`, RULE, "", text, ""].join("\n"))
    .join("\n");

  const merged = `${header}\n${body}`;

  const outPath = join(spec.dist, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, merged);

  // The loose copies must not ALSO be in the release. An include list that still names
  // them would leave the root exactly as noisy as before while this file claims to have
  // tidied it -- and the two copies would then drift.
  for (const source of spec.sources) {
    const stray = join(spec.dist, source.file);
    if (existsSync(stray)) {
      rmSync(stray);
      throw new Error(
        `${spec.name}: ${source.file} was staged into the release as well as merged. ` +
          "Remove it from the include list in scripts/prod.ts."
      );
    }
  }

  return { out: outRel, bytes: merged.length, sections };
}
