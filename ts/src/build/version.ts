/**
 * Version extraction and synchronization utilities.
 * Reads version from fxmanifest.lua and syncs it to other files.
 */

import * as fs from "node:fs";

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
      console.warn(`  ⚠️  Pattern not found in ${filePath}`);
      return;
    }
    const current = match[1];
    const clean = version.replace(/^v/i, "");
    if (current === clean) {
      console.log(`  ✅ ${filePath} already matches: ${clean}`);
      return;
    }
    content = content.replace(pattern, match[0].replace(current, clean));
    await fs.promises.writeFile(filePath, content, "utf8");
    console.log(`  🔄 ${filePath}: ${current} → ${clean}`);
  } catch (error) {
    console.warn(`  ⚠️  Could not sync version to ${filePath}: ${error}`);
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
      console.log(`  🔄 ${filePath}: ${match[2]} → ${semver}`);
    } else if (match) {
      console.log(`  ✅ ${filePath} already matches: ${semver}`);
    }
  } catch (error) {
    console.warn(`  ⚠️  Could not sync version to ${filePath}: ${error}`);
  }
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
      console.log(`  🔄 ${filePath}: ${old} → ${semver}`);
    } else {
      console.log(`  ✅ ${filePath} already matches: ${semver}`);
    }
  } catch (error) {
    console.warn(`  ⚠️  Could not sync version to ${filePath}: ${error}`);
  }
}
