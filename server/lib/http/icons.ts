// Lucide icons for the hub index, generated into icons.json by
// scripts/build-icons.ts. Read from disk on first use rather than imported, so
// a server that never renders the hub keeps the 300KB out of its bundle.
//
// A body is only ever looked up by a validated name from our own file — a
// registering resource supplies the name, never the markup — which is what
// makes it safe to emit unescaped into the page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fGetCurrentResourceName, fLoadResourceFile } from "./fivem";

let cache: Record<string, string> | null = null;

/**
 * Where the generator writes it, relative to the resource root. One constant,
 * because `scripts/prod.ts` has to ship exactly this path and
 * `tests/unit/http-icons.test.ts` asserts that it does.
 */
export const ICONS_RESOURCE_PATH = "server/lib/http/icons.json";

/**
 * Read the icon set under FXServer via `LoadResourceFile`, not a filesystem
 * path: `__dirname` is resolved by the bundler at build time, so a bundle
 * built on Windows and run on Linux would ask the Linux host for the build
 * machine's absolute Windows path and get an `fs.read` permission error.
 * `LoadResourceFile` takes a resource-relative path the runtime resolves
 * itself, so there is no absolute path to bake or separator to get wrong.
 */
function loadViaFivem(): string | null {
  try {
    return fLoadResourceFile?.(fGetCurrentResourceName(), ICONS_RESOURCE_PATH) ?? null;
  } catch {
    return null; // Not running under FXServer.
  }
}

/** Every icon in the set is drawn for this viewBox. */
export const ICON_VIEWBOX = "0 0 24 24";

/** A typo costs the card its icon rather than the whole hub a render. */
export const FALLBACK_ICON = "circle-help";

function load(): Record<string, string> {
  if (cache) return cache;

  const text = loadViaFivem();
  if (text) {
    try {
      cache = JSON.parse(text);
      return cache as Record<string, string>;
    } catch {
      // Present but unparseable: fall through rather than take the hub down.
    }
  }

  // Outside the game -- tests, scripts/build-icons.ts, anything run by bun
  // directly -- there is no runtime to ask and `__dirname` IS this directory.
  // Correct there for the same reason it is wrong under FXServer: nothing has
  // bundled it, so it is a real path on the machine doing the reading.
  try {
    cache = JSON.parse(readFileSync(join(__dirname, "icons.json"), "utf8"));
    return cache as Record<string, string>;
  } catch {}

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
