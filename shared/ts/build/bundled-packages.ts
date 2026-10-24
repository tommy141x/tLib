/**
 * Every npm package compiled into a staged server bundle is named in the notices.
 *
 * The NUI side of each resource is already measured from the bundler's sourcemaps, and
 * that measurement is written down by hand into THIRD-PARTY-NOTICES.md. The server side
 * never was, and the gap had teeth: tDetector's notices said in so many words that
 * `server/dist/bundle.js` "contains no third-party code", while `bun build` had been
 * compiling `adm-zip` into it the whole time. Nothing in tDetector's own manifest
 * declares adm-zip — it arrives through tLib's marketplace installer, out of tLib's
 * `node_modules` — so reading the repo could only ever produce the wrong answer, and the
 * sentence stayed false through three releases.
 *
 * So this reads the BUILT FILE. Bun and Rolldown both leave a `// <path>/node_modules/
 * <pkg>/<file>` banner above each module they inline, which is the only artifact in the
 * output that names its origin.
 *
 * SERVER BUNDLES ONLY, deliberately. The NUI bundles are obfuscated in place on the
 * staged tree, and obfuscation strips comments — pointing this at one would find zero
 * packages and report a clean pass on a file full of them. `scanned` is returned so a
 * caller can assert it looked at something.
 */

import { existsSync, readFileSync } from "node:fs";

/** `// ../tLib/node_modules/adm-zip/util/constants.js` -> `adm-zip`. Scopes included. */
const MODULE_BANNER = /\/\/\s*\S*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

export interface BundledPackages {
  /** Package names found, deduplicated and sorted. */
  packages: string[];
  /** Files actually read. Zero means the gate measured nothing. */
  scanned: string[];
}

export function bundledPackages(files: string[]): BundledPackages {
  const packages = new Set<string>();
  const scanned: string[] = [];

  for (const file of files) {
    if (!existsSync(file)) continue;
    scanned.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(MODULE_BANNER)) packages.add(match[1]);
  }

  return { packages: [...packages].sort(), scanned };
}

/**
 * Throws unless every package found is named somewhere in `noticesText`.
 *
 * Substring matching, not a parse: the notices are prose with a summary table and a
 * licence block per package, and any of those mentioning the name is the thing being
 * asked about. A false pass needs the name to appear while its licence does not, which
 * is a different failure from the one this exists to catch.
 */
export function assertBundledPackagesNamed(
  files: string[],
  noticesText: string,
  label = "server bundle"
): BundledPackages {
  const found = bundledPackages(files);

  if (found.scanned.length === 0) {
    throw new Error(
      `bundled-packages: none of the ${files.length} ${label} path(s) exist. ` +
        "A gate that reads nothing passes everything — fix the paths."
    );
  }

  const unnamed = found.packages.filter((pkg) => !noticesText.includes(pkg));
  if (unnamed.length > 0) {
    throw new Error(
      `THIRD-PARTY-NOTICES.md does not name ${unnamed.length} package(s) compiled into the ` +
        `${label}: ${unnamed.join(", ")}.\n` +
        "  They are in the file a customer receives, so their licences bind this archive."
    );
  }

  return found;
}
