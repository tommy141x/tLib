/**
 * What a marketplace card IS, as a description rather than as JSX — the field
 * set, the order, the stats, the like affordance. See ../README.md.
 */

import type { MarketplaceItem } from "./item";

/** The facts a card shows, in the order it shows them. The order is the contract. */
export type CardStatKey = "downloads" | "likes" | "size";

export interface CardStat {
  key: CardStatKey;
  /** Already resolved. `size` is bytes and wants `formatBytes`; the rest are counts. */
  value: number;
}

/**
 * The stats row, omitting only what this host genuinely does not know.
 *
 * `downloads` is always present, including at zero — a `> 0` gate hides a known
 * zero, which on a new catalogue is every item. `likes` is omitted on presence
 * and not truthiness. See ../README.md.
 */
export function cardStats(item: MarketplaceItem): readonly CardStat[] {
  return cardStatsOf(item);
}

/**
 * The counts a stats row needs, narrowed to a structural contract so a host whose
 * item is not a `MarketplaceItem` can use it — tELS merges two catalogues into one
 * `CardView`. `MarketplaceItem` satisfies it structurally, so `cardStats`
 * delegates rather than reimplementing. See ../README.md.
 */
export interface CardCounts {
  /** Non-optional: there is no "we do not know" state to represent. */
  downloads: number;
  /** Absent means THIS HOST HAS NO LIKES. `0` means nobody has liked it yet. */
  likes?: number;
  /** Absent or `0` means no size is known; neither draws a chip. */
  size_bytes?: number;
}

export function cardStatsOf(counts: CardCounts): readonly CardStat[] {
  const stats: CardStat[] = [{ key: "downloads", value: counts.downloads }];
  if (counts.likes !== undefined) stats.push({ key: "likes", value: counts.likes });
  // `?? 0` and not a presence check: unlike `likes`, a size nobody measured and a
  // size of zero bytes read the same, and `0B` is noise either way.
  if ((counts.size_bytes ?? 0) > 0) stats.push({ key: "size", value: counts.size_bytes as number });
  return stats;
}

/**
 * Whether the like control is a button, a plain count, or absent.
 *
 * `"none"` is the honest answer against a host that sends no `likes`, and the card
 * hiding the heart is the card working — do not "fix" it. `"button"` needs both
 * `canAct` and a `liked` the wire actually sent. See ../README.md.
 */
export type LikeAffordance = "button" | "count" | "none";

export function likeAffordance(item: MarketplaceItem, canAct: boolean): LikeAffordance {
  if (item.likes === undefined) return "none";
  return canAct && item.liked !== undefined ? "button" : "count";
}

/**
 * The next `liked` state a press is asking for, rather than a bare toggle: the
 * round trip can time out with the write already committed, so a retry must not
 * be able to invert anything.
 */
export function nextLikedState(item: MarketplaceItem): boolean {
  return !item.liked;
}

/**
 * The identity block as values rather than as a string. `version` stays separate
 * from `creator` because the surfaces place them differently, and pre-joining
 * forces one of them to split it back apart.
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
 * Default English copy for each stat. "installs" and not "downloads": the wire
 * field is what the backend counts, but to a server owner it means "this many
 * servers run it". A localising host maps `CardStatKey` itself and must not import
 * this.
 */
export const CARD_COPY: Record<CardStatKey, (value: string) => string> = {
  downloads: (v) => `${v} installs`,
  likes: (v) => v,
  size: (v) => v,
};
