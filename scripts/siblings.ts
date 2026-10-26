/**
 * Which sibling resources are checked out beside tLib.
 *
 * Several gates in this directory are estate-wide, so a standalone MIT clone of
 * tLib would make them either die (`found 0 sibling resource(s)`) or pass over
 * nothing. Zero siblings is therefore its own case, distinct from "fewer than
 * expected": a gate reads it as "does not apply here" and exits 0 saying so,
 * while any non-zero count keeps its existing floors, which exist to catch the
 * some-but-too-few broken-discovery case.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Sibling resource directory names, sorted. A resource is a directory beside
 * tLib named `t<Capital>...` that has an `fxmanifest.lua` — the manifest is
 * what distinguishes a resource from a notes folder or a stray checkout.
 */
export function siblingResources(tlibRoot: string): string[] {
  const siblings = resolve(tlibRoot, "..");
  if (!existsSync(siblings)) return [];
  return readdirSync(siblings, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^t[A-Z]/.test(e.name) && e.name !== "tLib")
    .map((e) => e.name)
    .filter((name) => existsSync(join(siblings, name, "fxmanifest.lua")))
    .sort();
}

/** True when nothing but tLib is checked out — a standalone public clone. */
export function isStandaloneClone(tlibRoot: string): boolean {
  return siblingResources(tlibRoot).length === 0;
}
