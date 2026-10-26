import type { InspectionRequest, InspectionSummary } from "./inspection";

/**
 * Re-exported, never redeclared. A second declaration of the wire shape fails
 * silently — reading `creator_name` off a camelCase object yields `undefined`,
 * not an error — and the symptom is a card falling through to the placeholder
 * tile with nothing logged.
 */
export type { MarketplaceItem } from "../item.ts";

export interface InstalledSound {
  filename: string;
  slug: string;
}

/**
 * The payload a host hands the browser when it opens or feeds it. A host scopes
 * the catalogue with `resource` and picks a tab with `initialTab`; there is no
 * per-type filter, and one would need a control to express it.
 */
export interface OpenData {
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
  /**
   * Which tab to open on. Defaults to "uis".
   *
   * Anything else is clamped back to "uis" by the browser, because this value
   * crosses NUI from a host and the Lua side does not constrain it.
   */
  initialTab?: "uis" | "sounds" | "installed";
  /** Name of the global update function the preview iframe should call (e.g. "__tdetLayoutUpdate"). */
  previewFn?: string;
  /** Dummy state to feed into the preview update function so the UI renders non-empty. */
  previewState?: Record<string, unknown>;
  /**
   * Where this host serves tRadio's offline dispatch panel (`preview.html`), so a
   * `theme` item can be previewed on the product instead of as a swatch strip.
   *
   * A URL and not a flag, and supplied by the CONSUMER rather than derived here:
   * tLib has no business naming tRadio, and the file is reachable only because
   * tRadio's own `fxmanifest.lua` publishes it. A consumer that sells no themes
   * sends nothing and its cards fall back exactly as before.
   */
  panelPreviewUrl?: string;
}

/** Declared in `../install-machine` beside the predicates that read it. */
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
