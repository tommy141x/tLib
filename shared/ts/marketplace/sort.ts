/**
 * Ordering a catalogue that is already in memory — and, above all, knowing when
 * NOT to.
 *
 * The rule three files restated
 *
 * The server ranks the catalogue before it sends it. tRadio asks for that
 * ranking explicitly (`sort=downloads` in `server/lib/http.ts`, which the
 * backend reads as its type-interleaved order) so that the best layout and the
 * best theme reach the first screen instead of sitting behind every sound.
 *
 * A client-side re-sort silently undoes that. So every surface grew a sort key
 * that means "leave it alone", and each wrote its own comment explaining why:
 *
 *   - tRadio: `DEFAULT_SORT` / the `"recommended"` case in `filteredItems`
 *     (`server/web/src/admin/pages/PageMarketplace.tsx`)
 *   - tELS: the `if (sort === "recommended") return kept` early return in
 *     `visibleCards` (`client/web/src/store/marketplace-store.ts`)
 *
 * `SERVER_ORDER` is that rule, named once. `applySort` honours it, and honours
 * it for an unrecognised key too — see below.
 *
 * Generic over the item, by comparator table
 *
 * The two surfaces sort different shapes by different fields and offer
 * different key sets (tRadio six, tELS four). What is identical is the
 * machinery: pick a comparator, copy, sort, never mutate, and fall back to a
 * tie-breaker so the order does not reshuffle between refreshes. So the keys
 * stay each surface's business and the machinery lives here.
 *
 * Headless: no JSX, no class names, no Solid.
 */

/**
 * The sort key that means "the server already ordered this".
 *
 * Spelled the same way both surfaces already spelled it, because it is a
 * value a person selects and in tRadio's case a value persisted in a select.
 */
export const SERVER_ORDER = "recommended";

/** A two-argument comparator, as `Array.prototype.sort` wants it. */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * Order a list by one of a surface's own comparators.
 *
 * Returns the input UNCHANGED for `SERVER_ORDER`, and for any key with no
 * comparator. The second half is deliberate and is not defensive padding: a key
 * that arrives from a URL, a saved preference or a locale file can outlive the
 * comparator it was added for, and the useful failure mode there is "the
 * catalogue is in the server's order" rather than a thrown error that blanks
 * the grid or an arbitrary order nobody chose.
 *
 * Never mutates. Both call sites previously copied by hand before sorting;
 * one of them documented that it must, because the array it is handed is a
 * reactive store's own and sorting in place would mutate state outside a
 * setter. Copying here means no caller has to remember.
 */
export function applySort<T>(
  items: readonly T[],
  key: string,
  comparators: Readonly<Partial<Record<string, Comparator<T>>>>
): readonly T[] {
  if (key === SERVER_ORDER) return items;
  const comparator = comparators[key];
  if (!comparator) return items;
  return [...items].sort(comparator);
}

/**
 * Highest number first, treating a missing value as 0.
 *
 * The zero is the point, and tRadio's comment says why: `downloads` is
 * optional on the wire, and an item the API has no count for must sort as 0
 * rather than poisoning the comparison. `undefined - number` is `NaN`, a
 * comparator returning `NaN` is treated as "equal", and the result is an order
 * that is neither sorted nor stable — with nothing logged.
 */
export function byNumberDesc<T>(get: (item: T) => number | undefined | null): Comparator<T> {
  return (a, b) => numberOf(get(b)) - numberOf(get(a));
}

/** Lowest number first, same missing-value rule. */
export function byNumberAsc<T>(get: (item: T) => number | undefined | null): Comparator<T> {
  return (a, b) => numberOf(get(a)) - numberOf(get(b));
}

function numberOf(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A-Z by text, using `localeCompare`.
 *
 * `localeCompare` rather than `<`: the catalogue is full of names with accents
 * and digits, and codepoint order puts "Zebra" before "Ägis" and "Unit 10"
 * before "Unit 9".
 */
export function byTextAsc<T>(get: (item: T) => string | undefined | null): Comparator<T> {
  return (a, b) => textOf(get(a)).localeCompare(textOf(get(b)));
}

/** Z-A by text. */
export function byTextDesc<T>(get: (item: T) => string | undefined | null): Comparator<T> {
  return (a, b) => textOf(get(b)).localeCompare(textOf(get(a)));
}

function textOf(value: string | undefined | null): string {
  return typeof value === "string" ? value : "";
}

/**
 * Newest first, for an ISO 8601 timestamp.
 *
 * A string compare, not a `Date` parse — which is correct ONLY because ISO 8601
 * in a fixed offset sorts lexicographically, and is why both surfaces store
 * `createdAt` as the wire string rather than converting it. A mixed-offset or
 * non-ISO value would compare wrongly here and silently, so the field this is
 * pointed at has to be the wire's own `createdAt`.
 */
export function byNewestFirst<T>(get: (item: T) => string | undefined | null): Comparator<T> {
  return (a, b) => textOf(get(b)).localeCompare(textOf(get(a)));
}

/**
 * Items answering `true` first, the rest after, each group otherwise untouched.
 *
 * This is tRadio's "Installed first". Note what it does NOT do: it does not
 * order within either group, so the server's ranking survives inside each one.
 */
export function byFlagFirst<T>(flagged: (item: T) => boolean): Comparator<T> {
  return (a, b) => (flagged(b) ? 1 : 0) - (flagged(a) ? 1 : 0);
}

/**
 * Group by an explicit rank table — tRadio's "By type".
 *
 * An item whose key is absent from the table sorts after every ranked one
 * rather than before: a new item type showing up at the top of a grid because
 * nobody added it to a lookup is the more surprising failure.
 */
export function byRank<T>(
  rankOf: (item: T) => string,
  ranks: Readonly<Record<string, number>>
): Comparator<T> {
  return (a, b) =>
    (ranks[rankOf(a)] ?? Number.MAX_SAFE_INTEGER) - (ranks[rankOf(b)] ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Run comparators in order until one of them discriminates.
 *
 * This is what makes a sort STABLE ACROSS REFRESHES, which is a different
 * property from `Array.prototype.sort` being stable. tRadio's comment records
 * the case: ties on `downloads` fall back to name, so two items with the same
 * count keep the same relative order every time the catalogue is re-fetched
 * instead of reshuffling because the server returned them the other way round.
 */
export function thenBy<T>(...comparators: readonly Comparator<T>[]): Comparator<T> {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}
