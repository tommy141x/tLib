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
  /**
   * How many distinct people have liked this item.
   *
   * ── ⚠️ OPTIONAL, AND THE OMISSION MEANS SOMETHING DIFFERENT FROM ZERO ─────
   *
   * The backend ALWAYS sends this — v2's `toV2Item` emits it unconditionally,
   * including as `0`. So an absent `likes` does not mean "nobody liked it", it
   * means **this host does not have likes**: a self-hosted marketplace running
   * an older build, or a `tmarketplace_base_url` pointed somewhere else.
   *
   * That is exactly why it is optional here rather than defaulted to `0` on
   * arrival. `ItemCard` renders nothing at all when it is absent, and a real
   * `0 likes` when it is present and zero. Defaulting would turn "we do not
   * know" into a confident, wrong number on every card — and because the number
   * is social proof, the wrong direction is the one that reads as "nobody wants
   * this".
   *
   * ⚠️ Therefore `num()` must NOT be applied to it the way it is to `downloads`.
   * `num()` maps a missing value to 0, which is precisely the collapse above.
   */
  likes?: number;
  /**
   * Has the player this request was made FOR liked it.
   *
   * ⚠️ PRESENT ONLY WHEN THE CALLER ASSERTED AN IDENTITY. v2 omits the key
   * entirely for a browse with no `X-FiveM-Identity` header, because `false`
   * would otherwise be indistinguishable from "we did not ask" — and a card that
   * drew an empty heart on something the player liked yesterday would invite a
   * second like that the server then refuses.
   *
   * So: absent ⇒ the card shows a count and NO affordance ("never a control that
   * cannot succeed"). Present ⇒ the card shows a working heart in that state.
   */
  liked?: boolean;
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
  /**
   * How many distinct people have liked this item.
   *
   * ⚠️ OPTIONAL, and absence means "this host does not have likes" rather than
   * "zero likes" — the full argument is on `CatalogueItem.likes` above and is the
   * reason `toCanonicalItem` carries it conditionally instead of through `num()`.
   * `ItemCard` checks presence, so getting this wrong prints a confident `0` on
   * every card against an older host.
   */
  likes?: number;
  /**
   * Has the player this request was made for liked it.
   *
   * ⚠️ ABSENT means "we did not ask" and is NOT `false`. A card with no `liked`
   * renders a count and no button; see `CatalogueItem.liked`.
   */
  liked?: boolean;
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
    /**
     * ⚠️ `typeof === "number"` AND NOT `num()`, which is the whole point.
     *
     * `num()` turns a missing value into `0`, and `0` is a MEANINGFUL like count
     * — so running these two through it would make a host that has never heard
     * of likes indistinguishable from an item nobody has liked. Every card
     * checks presence, so that collapse would print a confident "0 likes" on
     * everything in the catalogue against an older or self-hosted backend.
     *
     * This is the same rule the file header states for `preview_url` and
     * `preview_colors`, applied to a field where it is easier to get wrong
     * because the fallback looks harmless.
     */
    ...(typeof raw.likes === "number" && Number.isFinite(raw.likes)
      ? { likes: raw.likes }
      : {}),
    // ⚠️ `=== true` is not enough here: a real `false` must survive, because
    // `false` means "you have not liked this" and absence means "we did not
    // ask". The two render differently — a working empty heart versus no heart
    // at all — so this is a presence check and not a truthiness one.
    ...(typeof raw.liked === "boolean" ? { liked: raw.liked } : {}),
    ...(raw.previewWaveform ? { preview_waveform: raw.previewWaveform } : {}),
    ...(raw.previewColors ? { preview_colors: raw.previewColors } : {}),
    ...(raw.previewUrl ? { preview_url: raw.previewUrl } : {}),
    ...(raw.thumbnail ? { thumbnail: raw.thumbnail } : {}),
  };
}
