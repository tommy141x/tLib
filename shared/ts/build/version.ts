/**
 * Version extraction and synchronization utilities.
 * Reads version from fxmanifest.lua and syncs it to other files.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Extract the version string from fxmanifest.lua (e.g. "v4.4" → "4.4").
 */
export async function getManifestVersion(
  manifestPath = "./fxmanifest.lua"
): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(manifestPath, "utf8");
    const match = content.match(/^version\s+['"]v?([^'"]+)['"]/im);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a version like "4.4" or "3" to semver "x.x.x".
 * "v4.4" → "4.4.0", "v3" → "3.0.0", "4.4.1" → "4.4.1"
 */
export function toSemver(version: string): string {
  const clean = version.replace(/^v/i, "");
  const parts = clean.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

/**
 * Sync a version into a TypeScript file by replacing a const pattern.
 * Example pattern: /export const PANEL_VERSION = ["']([^"']+)["']/
 */
export async function syncVersionToTsConst(
  filePath: string,
  pattern: RegExp,
  version: string
): Promise<void> {
  try {
    let content = await fs.promises.readFile(filePath, "utf8");
    const match = content.match(pattern);
    if (!match) {
      console.warn(`  Pattern not found in ${filePath}`);
      return;
    }
    const current = match[1];
    const clean = version.replace(/^v/i, "");
    if (current === clean) {
      console.log(`  ${filePath} already matches: ${clean}`);
      return;
    }
    content = content.replace(pattern, match[0].replace(current, clean));
    await fs.promises.writeFile(filePath, content, "utf8");
    console.log(`  ${filePath}: ${current} → ${clean}`);
  } catch (error) {
    console.warn(`  Could not sync version to ${filePath}: ${error}`);
  }
}

/**
 * Sync a semver version into a Cargo.toml file.
 */
export async function syncVersionToCargoToml(filePath: string, version: string): Promise<void> {
  try {
    let content = await fs.promises.readFile(filePath, "utf8");
    const pattern = /^(version\s*=\s*")([^"]+)(")/m;
    const match = content.match(pattern);
    const semver = toSemver(version);
    if (match && match[2] !== semver) {
      content = content.replace(pattern, `$1${semver}$3`);
      await fs.promises.writeFile(filePath, content, "utf8");
      console.log(`  ${filePath}: ${match[2]} → ${semver}`);
    } else if (match) {
      console.log(`  ${filePath} already matches: ${semver}`);
    }
  } catch (error) {
    console.warn(`  Could not sync version to ${filePath}: ${error}`);
  }
}

/**
 * A generated copy of the canonical version that must be kept in step with
 * fxmanifest.lua.
 *
 * `json` and `cargo` targets hold semver ("6.4.0"); `tsConst` holds the cleaned
 * manifest string ("6.4"), because that is what the value is rendered as.
 */
export type VersionTarget =
  | { kind: "json"; file: string; field?: string }
  | { kind: "cargo"; file: string }
  | { kind: "tsConst"; file: string; pattern: RegExp };

/**
 * What every target currently says, and what it should say.
 *
 * Exported so a release gate can assert the same set `syncVersions()` writes,
 * and the two can never disagree about which files count as a version target.
 */
export async function readBackVersions(
  targets: VersionTarget[],
  root = "."
): Promise<{ file: string; expected: string; actual: string | null }[]> {
  const at = (file: string) => path.join(root, file);
  const version = await getManifestVersion(at("fxmanifest.lua"));
  if (!version) throw new Error(`Could not extract version from ${at("fxmanifest.lua")}`);
  const clean = version.replace(/^v/i, "");
  const semver = toSemver(version);

  const read = async (file: string) => fs.promises.readFile(at(file), "utf8").catch(() => null);

  return Promise.all(
    targets.map(async (target) => {
      const text = await read(target.file);
      if (target.kind === "tsConst") {
        return {
          file: target.file,
          expected: clean,
          actual: text?.match(target.pattern)?.[1] ?? null,
        };
      }
      if (target.kind === "cargo") {
        return {
          file: target.file,
          expected: semver,
          actual: text?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null,
        };
      }
      let actual: string | null = null;
      if (text !== null) {
        try {
          const value = (JSON.parse(text) as Record<string, unknown>)[target.field ?? "version"];
          actual = typeof value === "string" ? value : null;
        } catch {
          actual = null;
        }
      }
      return { file: target.file, expected: semver, actual };
    })
  );
}

/**
 * Fan the canonical version out from fxmanifest.lua to every target, then prove
 * it landed.
 *
 * The read-back is the point. Every `syncVersionTo*` helper below catches its own
 * error and `console.warn`s, so calling them proves nothing: a missing file, an
 * unparseable JSON or a renamed const all return quietly, after which a build
 * prints "versions synced". A sync that did nothing reported success, and the
 * first person to see it was a customer looking at a permanent
 * "Panel v6.4 ≠ Server v7.0" banner on a correct install. So targets are read
 * back and compared here, and a miss throws.
 *
 * Returns the cleaned manifest version.
 */
export async function syncVersions(targets: VersionTarget[], root = "."): Promise<string> {
  const at = (file: string) => path.join(root, file);
  const version = await getManifestVersion(at("fxmanifest.lua"));
  if (!version) {
    throw new Error(`Could not extract version from ${at("fxmanifest.lua")}`);
  }

  for (const target of targets) {
    if (target.kind === "tsConst") {
      await syncVersionToTsConst(at(target.file), target.pattern, version);
    } else if (target.kind === "cargo") {
      await syncVersionToCargoToml(at(target.file), version);
    } else {
      await syncVersionToJson(at(target.file), target.field ?? "version", version);
    }
  }

  for (const { file, expected, actual } of await readBackVersions(targets, root)) {
    throwIfMissed(file, expected, actual, version);
  }

  const clean = version.replace(/^v/i, "");
  console.log(`  versions verified at ${clean} (${toSemver(version)})`);
  return clean;
}

/** The single phrasing of a sync miss, so the gate and the build report it identically. */
export function throwIfMissed(
  file: string,
  expected: string,
  actual: string | null,
  manifestVersion: string
): void {
  if (actual === expected) return;
  throw new Error(
    `Version sync missed ${file}: it holds ${actual ?? "no version at all"}, ` +
      `fxmanifest.lua says ${manifestVersion}`
  );
}

/**
 * Sync a semver version into a JSON file field.
 */
export async function syncVersionToJson(
  filePath: string,
  field: string,
  version: string
): Promise<void> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const json = JSON.parse(content);
    const semver = toSemver(version);
    if (json[field] !== semver) {
      const old = json[field];
      json[field] = semver;
      await fs.promises.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      console.log(`  ${filePath}: ${old} → ${semver}`);
    } else {
      console.log(`  ${filePath} already matches: ${semver}`);
    }
  } catch (error) {
    console.warn(`  Could not sync version to ${filePath}: ${error}`);
  }
}
