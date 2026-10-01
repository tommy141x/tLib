// Marketplace configuration — resolved from convars on every call.
//
// Convar name (`tmarketplace_base_url`) matches the marketplace API.md contract.
// Default points at production; override to `http://localhost:3000/marketplace`
// against a local `wrangler dev` worker for integration testing. That one convar
// also redirects community configs and the product version check — see
// docs/content/convars.mdx.
//
// The base URL, its default and its normalisation come from
// shared/ts/marketplace/catalogue.ts, which is the single TypeScript definition;
// the Lua VMs read the matching one in shared/sh_api.lua. This file used to hold
// its own copy of the literal.

import { marketplaceBaseUrl } from "../../../shared/ts/marketplace/catalogue";

export interface MarketplaceConfig {
  /** Base URL for the marketplace API (no trailing slash, no /api/v1 suffix). */
  baseUrl: string;
  /** Fully-resolved API prefix (`${baseUrl}/api/v1`). */
  apiBase: string;
  /**
   * The v2 prefix (`${baseUrl}/api/v2/marketplace`), used by `browse.ts`.
   *
   * v1 is frozen, not deprecated: the install and download paths below still
   * speak it, and so do deployed copies of this resource that will never be
   * updated. v2 exists alongside it and is what a caller that can hold the
   * resource secret should use — it carries `theme`, takes `resource`, and
   * answers with a real error envelope.
   */
  apiBaseV2: string;
  /** Max bundle size accepted for install, in bytes. Guards against zip bombs. */
  maxBundleBytes: number;
  /** Per-install timeout in milliseconds. */
  installTimeoutMs: number;
}

/**
 * Marketplace config, recomputed on every call.
 *
 * NOT memoised, deliberately. It used to cache into a module-scope `cached` at
 * first use, which meant changing `tmarketplace_base_url` mid-session silently
 * did nothing here while tRadio's client bridge — which always re-read per call
 * — followed it immediately. Someone iterating against a local dev server got
 * half the traffic on each host with no indication why. The work is two template
 * strings and a convar read; there is nothing here worth caching.
 */
export function resolveConfig(): MarketplaceConfig {
  const baseUrl = marketplaceBaseUrl();
  return {
    baseUrl,
    apiBase: `${baseUrl}/api/v1`,
    apiBaseV2: `${baseUrl}/api/v2/marketplace`,
    maxBundleBytes: 5 * 1024 * 1024, // 5 MB, same as website upload ceiling
    installTimeoutMs: 30_000,
  };
}
