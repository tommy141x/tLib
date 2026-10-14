/**
 * Narrowing a catalogue that is already in memory: a search term, a facet, and
 * the counts the facet chips show.
 *
 * Why this is shared
 *
 * Two surfaces browse the same catalogue by filtering a list they already hold,
 * and both had written this by hand:
 *
 *   - tELS: `visibleCards` in `client/web/src/store/marketplace-store.ts`
 *   - tRadio: the `counts` / `searched` / `filteredItems` memos in
 *     `server/web/src/admin/pages/PageMarketplace.tsx`
 *
 * They had already diverged on what a search searches: tELS matched the TITLE
 * only, tRadio matched name and description. That is settled here in favour of
 * both — a dispatch theme or a light pattern is usually looked for by what it
 * does, and the description is the only field carrying that. `searchableText`
 * is the seam, so a surface decides which of its own fields are searchable
 * without reimplementing the matching.
 *
 * Generic over the item, by accessor
 *
 * The two surfaces do not share an item type — tELS holds a `CardView` keyed by
 * `kind`, tRadio holds a `MarketplaceItem` keyed by `type` — and they never
 * will, because one of them merges a second catalogue in. So the facet is
 * reached through a function rather than a field name. That is what lets the
 * logic be shared without forcing one surface's shape onto the other.
 *
 * Headless: no JSX, no class names, no Solid. Safe in CEF 103, in tRadio's Node
 * bundle, and in a Workers build.
 */

/**
 * The sentinel facet value meaning "do not narrow by facet".
 *
 * A literal rather than `null`/`undefined` because it is also a chip the user
 * can press and a value that round-trips through a URL, and because both
 * surfaces had independently chosen the same spelling.
 */
export const ALL_FACETS = "all";

/** Either a real facet value or the "no narrowing" sentinel. */
export type FacetSelection<F extends string> = F | typeof ALL_FACETS;

/**
 * Fold a raw input value into the form `matchesSearchTerm` compares against.
 *
 * Exported because callers need to ask "is a search active?" — the empty string
 * is the only honest answer to that, and recomputing `.trim().toLowerCase()` at
 * each call site is how one of them ends up testing the raw value instead.
 */
export function normaliseSearchTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether any of an item's searchable fields contains the term.
 *
 * An empty term matches EVERYTHING, rather than nothing. That is the
 * difference between a search box at rest and a search box that has hidden the
 * whole catalogue, and getting it the wrong way round empties the grid on first
 * paint.
 *
 * `null` and `undefined` fields are skipped rather than coerced: `String(null)`
 * is `"null"`, which would make a search for "null" match every item with a
 * missing description.
 *
 * The term is expected to be normalised already — pass it through
 * `normaliseSearchTerm` once per keystroke, not once per item.
 */
export function matchesSearchTerm(
  searchableText: readonly (string | null | undefined)[],
  term: string
): boolean {
  if (term === "") return true;
  for (const field of searchableText) {
    if (typeof field === "string" && field.toLowerCase().includes(term)) return true;
  }
  return false;
}

/**
 * Narrow by facet. The `all` sentinel returns the input UNCHANGED.
 *
 * Unchanged, not copied: these run inside reactive memos on every keystroke,
 * and the common case is no narrowing at all.
 */
export function applyFacet<T, F extends string>(
  items: readonly T[],
  facet: FacetSelection<F>,
  facetOf: (item: T) => F
): readonly T[] {
  if (facet === ALL_FACETS) return items;
  return items.filter((item) => facetOf(item) === facet);
}

/** A count per facet, plus `all`. */
export type FacetCounts<F extends string> = Record<FacetSelection<F>, number>;

/**
 * Count the items in each facet.
 *
 * Every facet in `facets` gets a key, including the ones with no items. A
 * chip whose count is absent renders as blank or `undefined` rather than as
 * `(0)`, and "no themes" is information the reader wants — it is the difference
 * between "there are none" and "the chip is broken".
 *
 * Count the list you are about to SHOW, not the raw catalogue. tRadio's
 * panel takes the counts after the search and before the facet narrowing, so a
 * chip cannot claim "Themes (7)" over a grid showing none of them — the count
 * would be the one number on screen the search did not apply to. Pass the
 * searched list here, not the full one.
 */
export function facetCounts<T, F extends string>(
  items: readonly T[],
  facets: readonly F[],
  facetOf: (item: T) => F
): FacetCounts<F> {
  const counts = { [ALL_FACETS]: items.length } as FacetCounts<F>;
  for (const facet of facets) counts[facet] = 0;
  for (const item of items) {
    const facet = facetOf(item);
    // Guarded rather than incremented blind: an item whose facet is not in
    // `facets` must not create an eighth key nobody renders, and must not be
    // counted into a facet it is not in. It still counts in `all`, which is
    // correct — it is in the catalogue.
    if (facet in counts) counts[facet] += 1;
  }
  return counts;
}
