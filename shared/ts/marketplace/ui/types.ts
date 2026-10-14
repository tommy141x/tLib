import type { InspectionRequest, InspectionSummary } from "./inspection";

/**
 * Re-exported, NOT redeclared.
 *
 * This file used to carry its own copy of the interface, which made four
 * definitions of one backend concept across the codebase (here,
 * `server/lib/marketplace/api.ts`, `server/lib/marketplace/browse.ts`, and
 * tRadio's admin store). A mismatch between any two of them is silent — reading
 * `creator_name` off a camelCase object yields `undefined`, not an error — and
 * tRadio's store records what that cost: sound cards stopped rendering a player
 * and theme cards stopped rendering their swatches, both falling through to the
 * placeholder tile with nothing logged.
 *
 * The copies also drifted in ways that mattered. This one was missing
 * `preview_colors` entirely, so theme swatches were dropped on the way into the
 * panel even though the wire carried them.
 */
export type { MarketplaceItem } from "../item.ts";

export interface InstalledSound {
  filename: string;
  slug: string;
}

export interface OpenData {
  type?: string;
  /** Marketplace site base URL (no /api/v1 suffix). */
  baseUrl: string;
  /**
   * MARKETPLACE SLUGS already installed on this server — shown with a delete
   * button at open time.
   *
   * SLUGS, not local names, and the distinction is the reported bug.
   * `shared/imports/marketplace/client.lua` used to put layout FOLDER NAMES in
   * here as well; a folder is `QRX-720` and the slug is `tradio-qrx-720`, so the
   * seed built from this list could only miss and every shipped layout offered
   * an Install for something already on disk. Layouts are answered from
   * `installedLayouts` instead, through `../local-name`, and this field now
   * carries sounds only — whose records we write ourselves from the catalogue
   * slug, so there is no second naming to reconcile.
   */
  installedSlugs?: string[];
  /** All installed layout DIRECTORY NAMES (including built-ins), for the Installed tab. */
  installedLayouts?: string[];
  /** All installed sounds (including built-ins), for the Installed tab. */
  installedSounds?: InstalledSound[];
  /** Filter results to a specific resource name. */
  resource?: string;
  /** Which tab to open on. Defaults to "uis". */
  initialTab?: "uis" | "sounds";
  /** Name of the global update function the preview iframe should call (e.g. "__tdetLayoutUpdate"). */
  previewFn?: string;
  /** Dummy state to feed into the preview update function so the UI renders non-empty. */
  previewState?: Record<string, unknown>;
}

/**
 * Re-exported, NOT redeclared — same rule as `MarketplaceItem` above.
 *
 * The union moved to `../install-machine` along with the three predicates every
 * surface was deriving from it by hand. It is re-exported here because the
 * components next door import their types from this file and because
 * `./index.tsx` is the package's public surface; the declaration lives in one
 * place.
 */
export type { InstallState } from "../install-machine.ts";

export type InspectionState = {
  request: InspectionRequest;
  name: string;
} & ({ state: "loading" } | { state: "ready"; summary: InspectionSummary } | { state: "error" });

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

export function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
