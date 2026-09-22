import { t } from "./i18n";
import { sliderValueValid } from "./protocol";
import { plainText } from "./text";
import type { MenuItem, SearchEntry } from "./types";

export function sliderValue(item: MenuItem, draft: unknown): number {
  return sliderValueValid(item, draft) ? draft : (item.value as number);
}
export function stepSlider(item: MenuItem, draft: unknown, direction: number): number {
  return Math.max(
    item.min!,
    Math.min(item.max!, sliderValue(item, draft) + Math.sign(direction) * item.step!)
  );
}

export const VISIBLE_ROWS = 9;

// Presentation identities never cross the action bridge. Typed option values keep
// numeric and string choices distinct across reorders and refreshes.
export interface MenuEntry extends MenuItem {
  canonicalId: string;
  chosenValue?: string | number;
  // Only on the synthetic rows presenting a cross-menu search hit. Carrying the
  // hit is what lets activate() route the row to a navigation rather than an
  // action: it does not exist on this page, so there is nothing to dispatch to.
  hit?: SearchHit;
}
// Rows read through to the live item rather than copying it. A spread would make
// the caller's memo depend on every property of every row, so one toggle flipping
// -- or one tick of the 750ms refresh -- would re-render the whole list. Only
// structural fields are read eagerly, since those change which rows exist.
const DELEGATED = [
  "label",
  "description",
  "kind",
  "barColor",
  "rightLabel",
  "icon",
  "rightIcon",
  "danger",
  "range",
  "min",
  "max",
  "step",
  "value",
  "options",
  "menu",
  "display",
  "apply",
  "nextMenu",
  "disabled",
  "confirm",
  "vehicleStats",
  "weaponStats",
  "hidden",
  "groupLabel",
  "panel",
] as const;

function project(
  base: object,
  source: MenuItem,
  overrides: Partial<Record<(typeof DELEGATED)[number], () => unknown>> = {}
) {
  for (const [field, get] of Object.entries(overrides))
    Object.defineProperty(base, field, { enumerable: true, get });
  for (const field of DELEGATED) {
    if (field in base) continue;
    Object.defineProperty(base, field, { enumerable: true, get: () => source[field] });
  }
  return base as MenuEntry;
}

export function menuEntries(items: readonly MenuItem[]): MenuEntry[] {
  const rows: MenuEntry[] = [];
  for (const item of items) {
    if (item.hidden) continue;
    if (item.groupLabel) {
      rows.push({
        id: JSON.stringify([item.id, "group", null]),
        canonicalId: item.id,
        kind: "status",
        get label() {
          return item.groupLabel ?? "";
        },
      } as MenuEntry);
    }
    const listOptions =
      item.kind === "select" && item.display === "list" ? item.options : undefined;
    if (listOptions?.length) {
      for (let index = 0; index < listOptions.length; index++) {
        const at = () => item.options?.[index];
        rows.push(
          project(
            {
              id: JSON.stringify([item.id, listOptions[index]!.value]),
              canonicalId: item.id,
              chosenValue: listOptions[index]!.value,
            },
            item,
            {
              label: () => at()?.label ?? "",
              disabled: () => Boolean(item.disabled || at()?.disabled),
              rightLabel: () => at()?.rightLabel ?? item.rightLabel,
              icon: () => at()?.icon ?? item.icon,
              rightIcon: () => at()?.rightIcon ?? item.rightIcon,
              danger: () => at()?.danger ?? item.danger,
              vehicleStats: () => at()?.vehicleStats ?? item.vehicleStats,
              weaponStats: () => at()?.weaponStats ?? item.weaponStats,
            }
          )
        );
      }
    } else {
      rows.push(project({ id: JSON.stringify([item.id]), canonicalId: item.id }, item));
    }
  }
  return rows;
}

export function nearestAncestor(
  id: string,
  parents: ReadonlyMap<string, string | undefined>,
  available: readonly { id: string }[]
) {
  const visited = new Set<string>();
  let current: string | undefined = id;
  while (current && !visited.has(current)) {
    if (available.some((menu) => menu.id === current)) return current;
    visited.add(current);
    current = parents.get(current);
  }
  return available.find((menu) => menu.id === "main")?.id ?? available[0]?.id;
}

export function moveSelection(
  items: readonly MenuItem[],
  selected: string | undefined,
  direction: number
) {
  items = items.filter((item) => item.kind !== "status");
  if (!items.length) return undefined;
  const index = items.findIndex((item) => item.id === selected);
  const next =
    index < 0
      ? direction < 0
        ? items.length - 1
        : 0
      : (((index + direction) % items.length) + items.length) % items.length;
  return items[next]?.id;
}

export function windowStart(index: number, length: number, size = VISIBLE_ROWS) {
  return Math.max(0, Math.min(index - Math.floor(size / 2), length - size));
}

// Reads everything the row puts on screen, not just its label, or a page could
// show the word the player typed and still filter the row away. List-display rows
// are excluded from the option sweep: each of their options is already its own row
// delegating the same array, so sweeping here costs one pass per row per keystroke
// on a 917-row page.
export function filterItems<T extends MenuItem>(items: readonly T[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  // Against what the row reads as, not what the wire sent: on a translated client
  // the player types the words on their own screen. One field at a time, so
  // nothing is translated twice and a query cannot match across a field boundary.
  const matches = (text: string | undefined) =>
    plainText(t(text)).toLocaleLowerCase().includes(needle);
  return items.filter(
    (item) =>
      matches(item.label) ||
      matches(item.description) ||
      matches(item.rightLabel) ||
      matches(item.groupLabel) ||
      (item.display !== "list" && Boolean(item.options?.some((option) => matches(option.label))))
  );
}

// Recursive search. filterItems above only sees the page the player is standing
// on, because a snapshot carries items for one menu; the catalog index closes that
// gap, so searching from a page searches everything beneath it too. Results
// navigate rather than dispatch -- validAction pins a request to the page on
// screen, so a row elsewhere cannot be actioned from here anyway.
//
// Every string carried out is raw, as the wire sent it. FormattedText runs t()
// over whatever it is handed, so a pre-translated hit would be looked up twice.
// Matching still happens against the translated form.
export interface SearchHit {
  menuId: string;
  itemId: string;
  /** Row label. */
  label: string;
  /** The field that actually matched, when it was not the label. */
  matched?: string;
  /** Menu titles from the searched page down to the row's own page. */
  path: readonly string[];
}

interface Titled {
  id: string;
  title: string;
  parent?: string;
}

// One lowercased, translated haystack per row, built once per index and locale.
// Translating ~51,000 option labels costs orders of magnitude more than scanning
// them, so per keystroke the feature is unusable and per locale it is free.
export interface PreparedIndex {
  entries: readonly SearchEntry[];
  haystacks: readonly string[];
  locale: string;
}

// A row's fields are joined so matching is one indexOf rather than one per field,
// separated by a character the player cannot type so a query still cannot match
// across the boundary. Written as an escape, not a literal: a raw NUL is invisible
// in an editor and makes ripgrep treat the file as binary.
const FIELD_BREAK = "\0";

function searchable(entry: SearchEntry): string[] {
  const parts = [entry.l, entry.d, entry.r, entry.g, ...(entry.o ?? [])];
  return parts.filter((part): part is string => part !== undefined);
}

export function prepareIndex(entries: readonly SearchEntry[], localeTag: string): PreparedIndex {
  const haystacks: string[] = new Array(entries.length);
  for (let index = 0; index < entries.length; index++) {
    haystacks[index] = searchable(entries[index]!)
      .map((part) => plainText(t(part)))
      .join(FIELD_BREAK)
      .toLocaleLowerCase();
  }
  return { entries, haystacks, locale: localeTag };
}

// Every menu reachable downward from `scope`, excluding the scope itself, whose
// rows filterItems already covers locally. Titles are carried raw and unjoined, so
// the caller decides how to translate and punctuate the trail.
export function descendantMenus(
  scope: string,
  menus: readonly Titled[]
): Map<string, readonly string[]> {
  const children = new Map<string, Titled[]>();
  for (const menu of menus) {
    if (menu.parent === undefined || menu.id === scope) continue;
    const siblings = children.get(menu.parent);
    if (siblings) siblings.push(menu);
    else children.set(menu.parent, [menu]);
  }
  // Breadth-first: shortest route wins, and a link cycle cannot run forever.
  const paths = new Map<string, readonly string[]>();
  const queue: { menu: Titled; path: readonly string[] }[] = (children.get(scope) ?? []).map(
    (menu) => ({ menu, path: [] })
  );
  while (queue.length) {
    const { menu, path } = queue.shift()!;
    if (paths.has(menu.id)) continue;
    const full = [...path, menu.title];
    paths.set(menu.id, full);
    for (const child of children.get(menu.id) ?? []) queue.push({ menu: child, path: full });
  }
  return paths;
}

// 51,000 option labels can match a single letter, and a list nobody scrolls to the
// end of is no more useful than its first screenful.
export const SEARCH_LIMIT = 40;

export function searchCatalog(
  prepared: PreparedIndex | undefined,
  query: string,
  scope: string,
  menus: readonly Titled[],
  limit = SEARCH_LIMIT
): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!prepared || !needle) return [];
  const paths = descendantMenus(scope, menus);
  if (!paths.size) return [];
  const hits: SearchHit[] = [];
  const { entries, haystacks } = prepared;
  for (let index = 0; index < entries.length && hits.length < limit; index++) {
    const entry = entries[index]!;
    const path = paths.get(entry.m);
    if (path === undefined || !haystacks[index]!.includes(needle)) continue;
    // Only matched rows pay for this, which is why finding the field is cheap here
    // and would not have been above.
    const matched = plainText(t(entry.l)).toLocaleLowerCase().includes(needle)
      ? undefined
      : searchable(entry)
          .slice(1)
          .find((part) => plainText(t(part)).toLocaleLowerCase().includes(needle));
    hits.push({ menuId: entry.m, itemId: entry.i, label: entry.l, matched, path });
  }
  return hits;
}

export function selectedOptionValue(item: MenuItem, draft: string | number | undefined) {
  const options = item.options ?? [];
  return (
    options.find((option) => option.value === draft)?.value ??
    options.find((option) => option.value === item.value)?.value
  );
}

export function optionValue(item: MenuItem, draft: string | number | undefined) {
  return selectedOptionValue(item, draft) ?? item.options?.[0]?.value;
}
