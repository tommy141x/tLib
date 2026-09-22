// Lucide icons for the hub index, generated into icons.json by
// scripts/build-icons.ts. Read from disk on first use rather than imported, so
// a server that never renders the hub keeps the 300KB out of its bundle.
//
// A body is only ever looked up by a validated name from our own file — a
// registering resource supplies the name, never the markup — which is what
// makes it safe to emit unescaped into the page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fGetCurrentResourceName, fGetResourcePath } from "./fivem";

let cache: Record<string, string> | null = null;

/**
 * Under FXServer the bundle runs through a custom loader, so `__dirname` is not
 * a real directory and the resource root has to be asked for instead. Outside
 * the game those globals are absent and `__dirname` IS this directory, where
 * the generator writes the file.
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

/** Every icon in the set is drawn for this viewBox. */
export const ICON_VIEWBOX = "0 0 24 24";

/** A typo costs the card its icon rather than the whole hub a render. */
export const FALLBACK_ICON = "circle-help";

function load(): Record<string, string> {
  if (cache) return cache;
  for (const p of candidatePaths()) {
    try {
      cache = JSON.parse(readFileSync(p, "utf8"));
      return cache as Record<string, string>;
    } catch {}
  }
  // A missing data file degrades the hub to no icons rather than no render.
  cache = {};
  return cache;
}

/** Names are kebab-case ASCII; anything else is rejected before the lookup. */
export function isKnownIcon(name: unknown): name is string {
  if (typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name)) return false;
  return Object.hasOwn(load(), name);
}

/** The SVG body for a name, the fallback's, or "" if the set failed to load. */
export function iconBody(name: string | undefined): string {
  const set = load();
  if (name && Object.hasOwn(set, name)) return set[name];
  return set[FALLBACK_ICON] ?? "";
}
