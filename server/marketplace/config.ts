// Marketplace configuration — resolved from convars at first use.
//
// Convar name (`tmarketplace_base_url`) matches the marketplace API.md contract.
// Default points at production; override to `http://localhost:3000/marketplace`
// against a local `wrangler dev` worker for integration testing.

import { fGetConvar } from "./fivem";

export interface MarketplaceConfig {
  /** Base URL for the marketplace API (no trailing slash, no /api/v1 suffix). */
  baseUrl: string;
  /** Fully-resolved API prefix (`${baseUrl}/api/v1`). */
  apiBase: string;
  /** Max bundle size accepted for install, in bytes. Guards against zip bombs. */
  maxBundleBytes: number;
  /** Per-install timeout in milliseconds. */
  installTimeoutMs: number;
}

let cached: MarketplaceConfig | null = null;

export function resolveConfig(): MarketplaceConfig {
  if (cached) return cached;
  const raw = (
    fGetConvar("tmarketplace_base_url", "https://marketplace.timmygstudios.com") || ""
  ).trim();
  const baseUrl = raw.replace(/\/+$/, "");
  cached = {
    baseUrl,
    apiBase: `${baseUrl}/api/v1`,
    maxBundleBytes: 5 * 1024 * 1024, // 5 MB, same as website upload ceiling
    installTimeoutMs: 30_000,
  };
  return cached;
}
