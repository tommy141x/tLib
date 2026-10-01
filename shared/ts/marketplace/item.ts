/**
 * The ONE canonical marketplace item shape, and the ONE normaliser onto it.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WIRE     `CatalogueItem`    camelCase   what /api/v2/marketplace sends  │
 * │  INTERNAL `MarketplaceItem`  snake_case  what every consumer reads       │
 * │  BRIDGE   `toCanonicalItem`  wire -> internal, and nothing else does it  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Stated here rather than left to be inferred from a comment in a consuming
 * tree: the two spellings are not a style inconsistency to be tidied away, they
 * are two different layers, and collapsing them in the wrong direction silently
 * empties cards (see below).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * There were two internal shapes for the same backend concept, and a mismatch
 * between them is silent: reading `creator_name` off a camelCase object yields
 * `undefined`, not an error. tRadio has already paid for that once — its store
 * records that while the two disagreed, "sound cards never rendered a player and
 * theme cards never rendered their swatches, both falling through to the
 * placeholder tile instead". Nothing failed; the UI just quietly lost fields.
 *
 * The wire is camelCase (v2, `/api/v2/marketplace`). The internal shape is
 * snake_case, because that is what the shared UI components in
 * `shared/ts/marketplace/ui/` are typed against and what every in-game consumer
 * already reads. Converging on it is one change (tRadio) rather than two.
 * The translation is this file and nowhere else.
 *
 * `toCanonicalItem` was `toItem`, a private function inside
 * `server/lib/marketplace/browse.ts`. Being private is precisely why tRadio
 * could not use it and grew its own shape instead — the normaliser existed, it
 * just was not reachable. Do not re-inline it.
 *
 * ── The rule that is easy to break ──────────────────────────────────────────
 *
 * Optional fields are OMITTED, never set to `undefined`. Every card checks
 * presence, so the distinction is load-bearing: a `preview_url` present on a UI
 * item makes it claim to be playable, and an empty `preview_colors` renders a
 * blank swatch row instead of the placeholder tile. `{...(x ? {k: x} : {})}` is
 * the spelling that preserves this; `{k: x}` is not.
 */

/**
 * A catalogue item, exactly as v2 projects it. Mirrors `toV2Item` in the
 * backend's `src/lib/marketplace/v2.ts`. Every optional field below is optional
 * *there* too, and conditional on `type`: `previewWaveform` and `previewUrl` are
 * sound-only, `previewColors` and `thumbnail` are theme-only.
 *
 * ── Why the WIRE type lives here and not in `catalogue.ts` ──────────────────
 *
 * This module must stay free of Node imports. It is reached from the NUI type
 * graph (`ui/types.ts` -> here), and `catalogue.ts` pulls in `node:crypto` and
 * holds the marketplace credential. When this file imported the type from
 * there, the browser typecheck followed the edge and failed on
 * `Cannot find module 'node:crypto'`.
 *
 * So the dependency is inverted deliberately: the pure shape+translation module
 * owns both shapes, and the transport imports from it. `import type` is erased
 * at runtime, so the credential was never at risk of reaching the client
 * bundle — but the type graph is reason enough, and an inverted dependency here
 * is what keeps it that way.
 */
export interface CatalogueItem {
  id: string;
  slug: string;
  type: string;
  resource: string;
  name: string;
  description: string;
  creatorName: string;
  /** Pinned to "1" by both backends — there is no version history yet. */
  currentVersion: string;
  sizeBytes: number;
  downloads: number;
  createdAt: string;
  /** Sound only. Peak data the card draws a waveform from. */
  previewWaveform?: number[];
  /** Theme only. Swatches for the card. */
  previewColors?: string[];
  /**
   * Theme only. ABSOLUTE, and the backend says why in the same words: the
   * consumer may be an in-game NUI frame, where a site-relative
   * `/api/storage/…` resolves against the GAME's origin and fetches nothing.
   */
  thumbnail?: string;
  /**
   * Sound only, absolute for the same reason. The listen-before-install URL —
   * the raw storage object, NOT `/download`, which counts an install per hit.
   *
   * ⚠️ This is what an `<audio src>` points at. It must not be fetched from a
   * browser: an element load is exempt from CORS and a `fetch` is not.
   */
  previewUrl?: string;
}

export interface MarketplaceItem {
  id: string;
  slug: string;
  type: string;
  resource: string;
  name: string;
  description: string;
  creator_name: string;
  /**
   * Pinned to "1" upstream because there is no version history in the schema.
   * Carried through rather than invented here, so the day versioning lands this
   * file needs no change.
   */
  current_version: string;
  size_bytes: number;
  downloads: number;
  created_at: string;
  /** Sound only. Peak data the card draws a waveform from. */
  preview_waveform?: number[];
  /** Theme only. Swatches for the card. */
  preview_colors?: string[];
  /**
   * Sound only. ABSOLUTE, and both contracts say why in the same words: the
   * consumer may be an in-game NUI frame, where a site-relative
   * `/api/storage/…` resolves against the GAME's origin and fetches nothing.
   *
   * ⚠️ This is what an `<audio src>` points at. It must NOT be fetched. An
   * element load is exempt from CORS; a `fetch` is not, and the host sends no
   * `Access-Control-Allow-Origin` on these routes. That exemption is the entire
   * reason the field is carried as a URL rather than as bytes — and it is also
   * why adding a `crossOrigin` attribute would BREAK playback, by opting the
   * element into a check it currently escapes.
   */
  preview_url?: string;
  /** Theme only. Absolute, for the same reason. */
  thumbnail?: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** camelCase v2 wire item -> the canonical snake_case shape every consumer reads. */
export function toCanonicalItem(raw: CatalogueItem): MarketplaceItem {
  return {
    id: raw.id,
    slug: raw.slug,
    type: raw.type,
    resource: raw.resource,
    name: raw.name,
    description: raw.description,
    creator_name: raw.creatorName,
    current_version: raw.currentVersion,
    size_bytes: num(raw.sizeBytes),
    downloads: num(raw.downloads),
    created_at: raw.createdAt,
    ...(raw.previewWaveform ? { preview_waveform: raw.previewWaveform } : {}),
    ...(raw.previewColors ? { preview_colors: raw.previewColors } : {}),
    ...(raw.previewUrl ? { preview_url: raw.previewUrl } : {}),
    ...(raw.thumbnail ? { thumbnail: raw.thumbnail } : {}),
  };
}
