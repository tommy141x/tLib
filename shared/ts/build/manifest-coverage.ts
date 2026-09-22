/**
 * Every path fxmanifest.lua names is actually staged into the release.
 *
 * The release include list in a resource's scripts/prod.ts is an allowlist, and
 * `stageFiles` already throws when a listed path has stopped existing. It
 * cannot catch the other direction: a script added to the manifest and never
 * added to the include list. That failure is silent at build time and fatal at
 * load time -- FiveM reports a missing client_scripts entry to the player, not
 * to whoever cut the release. tAFK shipped two of its eleven client scripts
 * missing this way.
 *
 * This reads the manifest and asserts the reverse direction: for each path the
 * manifest loads or streams, some entry in the include list covers it.
 */

const SCRIPT_BLOCKS = ["shared_scripts", "client_scripts", "server_scripts", "files"];
const STRING = /['"]([^'"]+)['"]/g;

/**
 * Lua line comments removed, quotes respected.
 *
 * These manifests carry long explanatory comments between their entries, and
 * those comments quote things: tAFK's `files` block quotes the error message a
 * missing entry produces. Extracting strings without stripping comments first
 * reported `no usable beat data` as an unstaged release path.
 */
export function stripLuaComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === "-" && line[i + 1] === "-") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** The entries of a `name { ... }` block, or null when the block is absent. */
function readBlock(manifest: string, name: string): string[] | null {
  const open = manifest.indexOf(`${name} {`);
  if (open === -1) return null;
  const close = manifest.indexOf("}", open);
  if (close === -1) throw new Error(`fxmanifest.lua: ${name} block is never closed`);
  const body = manifest.slice(open + name.length + 2, close);
  return [...body.matchAll(STRING)].map((m) => m[1]);
}

/**
 * The part of a manifest path that must exist on disk. `client/ui/**` and
 * `layouts/**\/*.*` are directory globs; the directory is what has to be
 * staged. A bare path is itself.
 */
export function stagedPrefix(entry: string): string {
  const star = entry.indexOf("*");
  if (star === -1) return entry;
  const dir = entry.slice(0, star).replace(/\/+$/, "");
  return dir;
}

function isCovered(entry: string, include: string[]): boolean {
  const target = stagedPrefix(entry);
  if (target === "") return true; // A glob rooted at the resource itself.
  return include.some((item) => target === item || target.startsWith(`${item}/`));
}

export interface ManifestCoverage {
  /** Manifest paths with no entry in the include list covering them. */
  missing: string[];
  /** How many manifest paths were examined; zero means the parse failed. */
  checked: number;
}

export function manifestCoverage(source: string, include: string[]): ManifestCoverage {
  const manifestSource = stripLuaComments(source);
  const entries: string[] = [];

  for (const block of SCRIPT_BLOCKS) {
    for (const entry of readBlock(manifestSource, block) ?? []) {
      // `@tLib/imports.lua` is another resource's file, loaded by FiveM from
      // that resource. Nothing for this release to stage.
      if (entry.startsWith("@")) continue;
      entries.push(entry);
    }
  }

  const uiPage = manifestSource.match(/^\s*ui_page\s+['"]([^'"]+)['"]/m);
  if (uiPage) entries.push(uiPage[1]);

  for (const dataFile of manifestSource.matchAll(
    /^\s*data_file\s+['"][^'"]+['"]\s+['"]([^'"]+)['"]/gm
  )) {
    entries.push(dataFile[1]);
  }

  return {
    missing: [...new Set(entries.filter((entry) => !isCovered(entry, include)))],
    checked: entries.length,
  };
}

/**
 * The manifest paths that are not present in a staged release tree.
 *
 * The list-based check above suits a release whose contents are an explicit
 * include list. tRadio's is not: `scripts/runtime-staging.ts` decides file by
 * file with a predicate, so there is no list to compare against -- but there is
 * a finished tree, and checking that is strictly stronger. It catches a path
 * the policy rejected for a reason nobody anticipated, which a list comparison
 * cannot see.
 */
export function manifestCoverageOnDisk(
  source: string,
  distDir: string,
  exists: (path: string) => boolean
): ManifestCoverage {
  // An empty include list covers nothing, so `missing` is every declared path.
  const { missing: declared, checked } = manifestCoverage(source, []);
  return {
    missing: declared.filter((entry) => !exists(`${distDir}/${stagedPrefix(entry)}`)),
    checked,
  };
}

export function assertManifestOnDisk(
  source: string,
  distDir: string,
  exists: (path: string) => boolean
) {
  const { missing, checked } = manifestCoverageOnDisk(source, distDir, exists);
  if (checked === 0) {
    throw new Error(
      "fxmanifest.lua declares no loadable paths; the coverage check cannot be trusted"
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `fxmanifest.lua names ${missing.length} path(s) missing from the staged release:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        "\nThe staging policy in scripts/runtime-staging.ts rejected them."
    );
  }
  console.log(`  manifest coverage: ${checked} declared path(s), all present in the staged tree`);
}

export function assertManifestStaged(manifestSource: string, include: string[]) {
  const { missing, checked } = manifestCoverage(manifestSource, include);
  if (checked === 0) {
    // A manifest with nothing to load is not a manifest -- the parse broke, and
    // reporting "all covered" would make this check worse than not having it.
    throw new Error(
      "fxmanifest.lua declares no loadable paths; the coverage check cannot be trusted"
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `fxmanifest.lua names ${missing.length} path(s) the release does not stage:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        "\nAdd them to the include list in scripts/prod.ts."
    );
  }
  console.log(`  manifest coverage: ${checked} declared path(s), all staged`);
}
