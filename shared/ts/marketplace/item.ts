/**
 * The one canonical marketplace item shape, and the one normaliser onto it:
 * camelCase `CatalogueItem` on the wire, snake_case `MarketplaceItem` internally,
 * `toCanonicalItem` the only bridge. Two layers, not a style inconsistency to be
 * tidied away — a mismatch is silent, because reading `creator_name` off a
 * camelCase object yields `undefined` rather than an error. See ../README.md.
 *
 * Optional fields are OMITTED, never set to `undefined`: every card checks
 * presence. `{...(x ? {k: x} : {})}` preserves that; `{k: x}` does not.
 */

/**
 * A catalogue item, exactly as v2 projects it. Every optional field is optional
 * there too, and conditional on `type`: `previewWaveform` and `previewUrl` are
 * sound-only, `previewColors` and `thumbnail` are theme-only.
 *
 * The wire type lives here and not in `catalogue.ts` because this module must stay
 * free of Node imports — it is reached from the NUI type graph, and `catalogue.ts`
 * pulls in `node:crypto`. The dependency is inverted deliberately.
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
  /**
   * How many distinct people have liked this item. The backend always sends it,
   * including as `0`, so absence means the HOST has no likes rather than zero —
   * and `num()` must not be applied to it the way it is to `downloads`.
   */
  likes?: number;
  /**
   * Has the player this request was made for liked it. Present only when the
   * caller asserted an identity; absent is NOT `false`, and a card with no
   * `liked` renders a count and no button. See ../README.md.
   */
  liked?: boolean;
  createdAt: string;
  /** Sound only. Peak data the card draws a waveform from. */
  previewWaveform?: number[];
  /** Theme only. Swatches for the card. */
  previewColors?: string[];
  /**
   * Theme only. Absolute: the consumer may be an in-game NUI frame, where a
   * site-relative `/api/storage/…` resolves against the game's origin.
   */
  thumbnail?: string;
  /**
   * Sound only, absolute for the same reason. The listen-before-install URL — the
   * raw storage object, NOT `/download`, which counts an install per hit. An
   * `<audio src>` may point at it; a `fetch` is CORS-blocked where a load is not.
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
  /** Pinned to "1" upstream; carried through rather than invented here. */
  current_version: string;
  size_bytes: number;
  downloads: number;
  /**
   * How many distinct people have liked this item. Absence means the host has no
   * likes rather than zero, which is why `toCanonicalItem` carries it
   * conditionally instead of through `num()`. See `CatalogueItem.likes`.
   */
  likes?: number;
  /** Absent means "we did not ask" and is NOT `false`. See `CatalogueItem.liked`. */
  liked?: boolean;
  created_at: string;
  /** Sound only. Peak data the card draws a waveform from. */
  preview_waveform?: number[];
  /** Theme only. Swatches for the card. */
  preview_colors?: string[];
  /**
   * Sound only, absolute. What an `<audio src>` points at — it must NOT be
   * fetched: an element load is exempt from CORS and a `fetch` is not, and adding
   * a `crossOrigin` attribute BREAKS playback by opting into a check the element
   * currently escapes. See ../README.md.
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
    // `typeof === "number"` and NOT `num()`: `num()` maps missing to `0`, and `0`
    // is a meaningful like count, so that collapse prints a confident "0 likes"
    // on every card against a host that has no likes at all.
    ...(typeof raw.likes === "number" && Number.isFinite(raw.likes) ? { likes: raw.likes } : {}),
    // A presence check and not `=== true`: a real `false` means "you have not
    // liked this" and absence means "we did not ask", and they render differently.
    ...(typeof raw.liked === "boolean" ? { liked: raw.liked } : {}),
    ...(raw.previewWaveform ? { preview_waveform: raw.previewWaveform } : {}),
    ...(raw.previewColors ? { preview_colors: raw.previewColors } : {}),
    ...(raw.previewUrl ? { preview_url: raw.previewUrl } : {}),
    ...(raw.thumbnail ? { thumbnail: raw.thumbnail } : {}),
  };
}
