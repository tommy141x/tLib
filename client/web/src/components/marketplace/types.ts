import type { InspectionRequest, InspectionSummary } from "./inspection";

export interface MarketplaceItem {
  id: string;
  slug: string;
  type: string;
  name: string;
  description: string;
  creator_name: string;
  current_version: string;
  size_bytes: number;
  downloads: number;
  created_at: string;
  preview_waveform?: number[] | null;
}

export interface InstalledSound {
  filename: string;
  slug: string;
}

export interface OpenData {
  type?: string;
  /** Marketplace site base URL (no /api/v1 suffix). */
  baseUrl: string;
  /** Slugs already installed on this server — shown with a delete button at open time. */
  installedSlugs?: string[];
  /** All installed layout names (including built-ins), for the Installed tab. */
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

export type InstallState =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "uninstalling" }
  | { state: "installed" }
  | { state: "done"; ok: boolean; error?: string };

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
