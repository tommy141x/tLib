// icons.ts — Lucide icons for the hub index.
//
// The set is generated into icons.json by scripts/build-icons.ts, with the
// presentation attributes hoisted out of every element (see that script). It is
// loaded from disk on first use rather than imported, so a server that never
// renders the hub never pays for it, and the 300KB stays out of the bundle.
//
// An icon body is only ever looked up by a validated name from OUR OWN file —
// a registering resource supplies the name, never the markup. That is what
// makes it safe to emit unescaped into the page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fGetCurrentResourceName, fGetResourcePath } from "./fivem";

let cache: Record<string, string> | null = null;

/**
 * Where icons.json lives.
 *
 * Under FXServer the bundle is evaluated by a custom loader, so `__dirname` is
 * not a real directory and joining against it finds nothing — the resource root
 * has to be asked for. Outside the game (tests, the smoke script) those globals
 * do not exist and `__dirname` IS this directory, which is where the generator
 * writes the file. Both paths are tried, in that order.
 */
function candidatePaths(): string[] {
  const paths: string[] = [];
  try {
    const root = fGetResourcePath?.(fGetCurrentResourceName());
    if (root) paths.push(join(root, "server", "http", "icons.json"));
  } catch {
    // Not running under FXServer.
  }
  paths.push(join(__dirname, "icons.json"));
  return paths;
}

/** Lucide's grid. Every icon in the set is drawn for this viewBox. */
export const ICON_VIEWBOX = "0 0 24 24";

/**
 * Shown when a resource names an icon that does not exist, so a typo costs the
 * card its icon rather than the whole hub a render.
 */
export const FALLBACK_ICON = "circle-help";

function load(): Record<string, string> {
  if (cache) return cache;
  for (const p of candidatePaths()) {
    try {
      cache = JSON.parse(readFileSync(p, "utf8"));
      return cache as Record<string, string>;
    } catch {
      // Try the next candidate.
    }
  }
  // A missing data file must not take the hub down — it degrades to no icons.
  cache = {};
  return cache;
}

/**
 * A name is usable if the set has it. Names are kebab-case ASCII; anything else
 * cannot match and is rejected before it reaches the lookup.
 */
export function isKnownIcon(name: unknown): name is string {
  if (typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name)) return false;
  return Object.hasOwn(load(), name);
}

/**
 * The SVG body for a name, or the fallback's. Returns "" only when the data
 * file could not be read at all.
 */
export function iconBody(name: string | undefined): string {
  const set = load();
  if (name && Object.hasOwn(set, name)) return set[name];
  return set[FALLBACK_ICON] ?? "";
}

/** Test seam — drops the cached set so a test can observe a reload. */
export function resetIconCache(): void {
  cache = null;
}
