/**
 * What a marketplace card IS — one definition, for every surface that draws one.
 *
 * ── The brief, in the owner's words ─────────────────────────────────────────
 *
 *   *"The browser in tRadio does not match tWeb's browser… This is something
 *   where it should've had to have been done to one marketplace item card /
 *   setup and then shared across all."*
 *
 * A previous pass extracted the headless *behaviour* — `sort.ts`, `filter.ts`,
 * `install-machine.ts` — and deferred the card itself to a "Phase 3" that never
 * happened. Every parity complaint traces to that deferral, so this is the file
 * that was missing. Surveyed 2026-10-07 there were **four** independent cards:
 *
 *   surface                                       card
 *   ───────────────────────────────────────────   ────────────────────────────────
 *   tLib NUI browser                              shared `ui/ItemCard.tsx`
 *   tRadio admin panel                            its OWN `MarketplaceCard`  ← (*)
 *   tWeb                                          its OWN `item-card.tsx`
 *   tELS NUI                                      its OWN `ItemCard.tsx`
 *
 * (*) and this is the one the complaint is about. It was asserted to share
 * `ItemCard.tsx`; it does not and never did — `PageMarketplace.tsx` declares
 * `MarketplaceCard` at line 1036 and imports no card at all. Everything the
 * owner reported missing there follows directly:
 *
 *   · **no like button** — that card renders no likes of any kind. The data was
 *     present the whole time: the panel normalises through `toCanonicalItem`,
 *     which carries `likes` and `liked`, and then drew neither.
 *   · **no download counts** — it had its own `Show when={downloads > 0}`, and a
 *     freshly-imported catalogue is `downloads: 0` for everything, so the gate
 *     hid the count on every single item. The shared card prints `0 installs`,
 *     which is why the owner saw counts on one surface and not the other.
 *   · **"I didn't ask for a rating system"** — confirmed, there is none anywhere.
 *     Likes only. (The greps that suggested one were `start`/`padStart`.)
 *
 * ── Where the boundary is, and why it is here ───────────────────────────────
 *
 * Shared: the field set, the order, the copy, the stats, the like affordance,
 * the install state (via `./install-machine`). NOT shared: class names, tokens,
 * icon packs. The owner settled that explicitly — *"It's okay for the styling of
 * it to not be shared between wind3 and wind4, but the logic … should be."*
 *
 * So this module returns a DESCRIPTION of a card and never JSX. A card that is
 * identical in structure, field set and wording and differs only in theme
 * satisfies the ask; three independent implementations do not. And a headless
 * description is the only form that can cross the real barrier: tWeb is
 * presetWind4 + `lucide-solid`, the NUI surfaces are presetWind3 +
 * `unplugin-icons` + `--nui-*` under CEF 103, which has no `oklch()` and no
 * `color-mix()`. Importing one styled component into both would break a working
 * surface to satisfy a slogan.
 *
 * ── The token/label split, which is deliberate ──────────────────────────────
 *
 * Every function here returns TOKENS and VALUES, never a finished sentence.
 * `CARD_COPY` is the default English, used by surfaces that are English-only
 * (every string in `ui/` is a literal). A localising host — tRadio's panel runs
 * everything through `t()` — maps the token itself and must NOT import
 * `CARD_COPY`. This is the identical split `install-machine.ts` already makes
 * between `installAction` and `INSTALL_ACTION_LABEL`, and for the identical
 * reason: returning a sentence from here forces a localising host to either
 * accept English or go back to deriving its own, which is how the duplication
 * started the first time.
 */

import type { MarketplaceItem } from "./item";

/**
 * The facts a card shows, in the order it shows them.
 *
 * ⚠️ This being an ordered array is the point. Three cards showed overlapping
 * subsets of these in three orders, so "does my card match" was not a question
 * anybody could answer. Now it is: render this array.
 */
export type CardStatKey = "downloads" | "likes" | "size";

export interface CardStat {
  key: CardStatKey;
  /**
   * The number, already resolved. `size` is in bytes and wants `formatBytes`;
   * the other two are counts and want the host's number formatting.
   */
  value: number;
}

/**
 * The stats row, in order, omitting only what this host genuinely does not know.
 *
 * ⚠️ `downloads` IS ALWAYS PRESENT, INCLUDING AT ZERO, and that is the fix for
 * the reported missing counts. `downloads` is non-optional on `MarketplaceItem`
 * and `toCanonicalItem` runs it through `num()`, so the value is always a real
 * number — there is no "we do not know" state to represent. A `> 0` gate
 * therefore does not hide an unknown, it hides a known zero, which on a newly
 * imported catalogue is every item in it.
 *
 * ⚠️ `likes` is omitted on PRESENCE, not truthiness — `likes !== undefined`,
 * because `0` is a real like count and `undefined` means *this host does not
 * have likes* (an older or self-hosted backend). `item.ts` carries the full
 * argument. `Show when={item.likes}` would hide the count on everything nobody
 * has liked yet, i.e. most of a new catalogue, which is the same mistake as the
 * downloads gate pointing the other way.
 */
export function cardStats(item: MarketplaceItem): readonly CardStat[] {
  const stats: CardStat[] = [{ key: "downloads", value: item.downloads }];
  if (item.likes !== undefined) stats.push({ key: "likes", value: item.likes });
  if (item.size_bytes > 0) stats.push({ key: "size", value: item.size_bytes });
  return stats;
}

/**
 * Whether the like control is a button, a plain count, or absent.
 *
 * ── ⚠️ "No like button" is CORRECT right now, and must not be "fixed" ───────
 *
 * The deployed backend returns no `likes` and no `liked` field at all — the
 * likes code is committed in tWeb but not deployed. So `"none"` is the honest
 * answer and the card hiding the heart is the card working. Guessing a state
 * here would draw an empty heart on something the player may have liked
 * yesterday, inviting a press the server then refuses.
 *
 * Both conditions are required for `"button"`:
 *   · `canAct` — the surface can establish WHO is asking. A web preview, a staff
 *     tool, or a panel reached before the server answered cannot.
 *   · `liked !== undefined` — the wire told us this player's state. v2 omits
 *     `liked` precisely when no identity was asserted, so an absent flag IS
 *     "we cannot act for anybody here".
 *
 * "Never a control that cannot succeed" is the rule this implements.
 */
export type LikeAffordance = "button" | "count" | "none";

export function likeAffordance(item: MarketplaceItem, canAct: boolean): LikeAffordance {
  if (item.likes === undefined) return "none";
  return canAct && item.liked !== undefined ? "button" : "count";
}

/**
 * The next `liked` state a press is asking FOR.
 *
 * ⚠️ The NEXT state rather than a bare "toggle", so the handler is idempotent on
 * retry. That matters because the round trip is NUI -> Lua -> game server -> HTTP
 * and can time out with the write already committed; a caller that retries after
 * a timeout must not be able to invert anything.
 */
export function nextLikedState(item: MarketplaceItem): boolean {
  return !item.liked;
}

/**
 * The identity block — name, byline, version — as values rather than as a string.
 *
 * `version` is separated from `creator` instead of being pre-joined with a `·`
 * because the three surfaces place them differently (one line in the NUI card,
 * two lines in the panel) and joining here would force one of them to split a
 * string back apart.
 */
export interface CardIdentity {
  name: string;
  creator: string;
  /** Omitted when the catalogue has no version for this item. */
  version?: string;
  /** Omitted when there is no description — a card must not draw an empty line. */
  description?: string;
}

export function cardIdentity(item: MarketplaceItem): CardIdentity {
  return {
    name: item.name,
    creator: item.creator_name,
    ...(item.current_version ? { version: item.current_version } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

/**
 * Default English copy for each stat.
 *
 * ⚠️ "installs" and not "downloads", matching what `ui/ItemCard.tsx` has always
 * rendered. The wire field is `downloads` because that is what the backend
 * counts, but to a server owner the number means "this many servers run it", and
 * the two surfaces must not word one number two ways. A localising host maps
 * `CardStatKey` through its own catalogue instead and does not import this.
 */
export const CARD_COPY: Record<CardStatKey, (value: string) => string> = {
  downloads: (v) => `${v} installs`,
  likes: (v) => v,
  size: (v) => v,
};
