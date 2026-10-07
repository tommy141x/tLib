import { describe, expect, test } from "bun:test";
import {
  applySort,
  byFlagFirst,
  byNewestFirst,
  byNumberAsc,
  byNumberDesc,
  byRank,
  byTextAsc,
  byTextDesc,
  SERVER_ORDER,
  thenBy,
} from "../../shared/ts/marketplace/sort";

interface Item {
  name: string;
  downloads?: number | null;
  createdAt?: string;
  type?: string;
  installed?: boolean;
}

const item = (over: Partial<Item> = {}): Item => ({ name: "x", ...over });

describe("applySort", () => {
  const items: readonly Item[] = [item({ name: "b" }), item({ name: "a" })];
  const comparators = { name: byTextAsc<Item>((i) => i.name) };

  test("the server's order is returned UNCHANGED, not merely unsorted", () => {
    // Identity, not a copy: this runs in a memo on every keystroke and the
    // common case does no work. It is also the rule three surfaces restated —
    // re-sorting here silently undoes the backend's type-interleaved ranking.
    const out = applySort(items, SERVER_ORDER, comparators);
    expect(out).toBe(items);
  });

  test("an unrecognised key falls back to the server's order rather than throwing", () => {
    // A key can outlive its comparator (a saved preference, a URL). The useful
    // failure is "the catalogue is in the server's order", not a blank grid.
    const out = applySort(items, "no-such-key", comparators);
    expect(out).toBe(items);
  });

  test("a recognised key sorts", () => {
    expect(applySort(items, "name", comparators).map((i) => i.name)).toEqual(["a", "b"]);
  });

  test("never mutates its input", () => {
    // The array handed in is a reactive store's own; sorting in place would
    // mutate state outside a setter.
    const source = [item({ name: "b" }), item({ name: "a" })];
    const before = source.map((i) => i.name);
    applySort(source, "name", comparators);
    expect(source.map((i) => i.name)).toEqual(before);
  });
});

describe("byNumberDesc", () => {
  test("highest first", () => {
    const out = [item({ name: "lo", downloads: 1 }), item({ name: "hi", downloads: 9 })].sort(
      byNumberDesc((i) => i.downloads)
    );
    expect(out.map((i) => i.name)).toEqual(["hi", "lo"]);
  });

  test("a missing count sorts as 0 rather than poisoning the comparison", () => {
    // ⚠️ The documented bug: `undefined - number` is NaN, a NaN comparator reads
    // as "equal", and the result is neither sorted nor stable, with nothing
    // logged. `null` has to behave the same way — tRadio's own item shape
    // declares `previewColors?: string[] | null`, so null is a real wire value.
    const out = [
      item({ name: "none" }),
      item({ name: "five", downloads: 5 }),
      item({ name: "null", downloads: null }),
    ].sort(byNumberDesc((i) => i.downloads));
    expect(out[0]!.name).toBe("five");
    expect(out.map((i) => i.name).slice(1).sort()).toEqual(["none", "null"]);
  });

  test("byNumberAsc is the mirror", () => {
    const out = [item({ name: "hi", downloads: 9 }), item({ name: "lo", downloads: 1 })].sort(
      byNumberAsc((i) => i.downloads)
    );
    expect(out.map((i) => i.name)).toEqual(["lo", "hi"]);
  });
});

describe("text comparators", () => {
  test("A-Z and Z-A", () => {
    const names = () => [item({ name: "Bravo" }), item({ name: "alpha" })];
    expect(names().sort(byTextAsc((i) => i.name)).map((i) => i.name)).toEqual(["alpha", "Bravo"]);
    expect(names().sort(byTextDesc((i) => i.name)).map((i) => i.name)).toEqual(["Bravo", "alpha"]);
  });

  test("uses localeCompare, so digits and accents order as a reader expects", () => {
    // Codepoint order would put "Unit 10" before "Unit 9" and "Zebra" before
    // "Ägis". This asserts the accent case, which is the unambiguous one.
    const out = [item({ name: "Zebra" }), item({ name: "Ägis" })].sort(
      byTextAsc((i) => i.name)
    );
    expect(out.map((i) => i.name)).toEqual(["Ägis", "Zebra"]);
  });

  test("a missing field is an empty string, not a crash", () => {
    const out = [item({ name: "a" }), item({ name: undefined as unknown as string })].sort(
      byTextAsc((i) => i.name)
    );
    expect(out).toHaveLength(2);
  });
});

describe("byNewestFirst", () => {
  test("newest ISO timestamp first", () => {
    const out = [
      item({ name: "old", createdAt: "2026-01-01T00:00:00Z" }),
      item({ name: "new", createdAt: "2026-09-01T00:00:00Z" }),
    ].sort(byNewestFirst((i) => i.createdAt));
    expect(out.map((i) => i.name)).toEqual(["new", "old"]);
  });
});

describe("byFlagFirst", () => {
  test("flagged items lead", () => {
    const out = [
      item({ name: "no" }),
      item({ name: "yes", installed: true }),
    ].sort(byFlagFirst((i) => i.installed === true));
    expect(out.map((i) => i.name)).toEqual(["yes", "no"]);
  });

  test("does NOT order within either group, so the server's ranking survives", () => {
    const out = [
      item({ name: "b", installed: true }),
      item({ name: "a", installed: true }),
      item({ name: "d" }),
      item({ name: "c" }),
    ].sort(byFlagFirst((i) => i.installed === true));
    expect(out.map((i) => i.name)).toEqual(["b", "a", "d", "c"]);
  });
});

describe("byRank", () => {
  const ranks = { ui: 0, sound: 1, theme: 2 };

  test("groups by the table", () => {
    const out = [
      item({ name: "t", type: "theme" }),
      item({ name: "u", type: "ui" }),
      item({ name: "s", type: "sound" }),
    ].sort(byRank((i) => i.type ?? "", ranks));
    expect(out.map((i) => i.name)).toEqual(["u", "s", "t"]);
  });

  test("an unranked type sorts LAST, not first", () => {
    // A type nobody added to the lookup appearing at the top of the grid is the
    // more surprising failure, so the default rank is the maximum.
    const out = [
      item({ name: "mystery", type: "anim" }),
      item({ name: "u", type: "ui" }),
    ].sort(byRank((i) => i.type ?? "", ranks));
    expect(out.map((i) => i.name)).toEqual(["u", "mystery"]);
  });
});

describe("thenBy", () => {
  test("a tie on the first comparator falls through to the second", () => {
    // This is what makes the order stable ACROSS REFRESHES, which is not the
    // same property as Array.sort being stable: two items on the same download
    // count keep their relative order even when the server returns them the
    // other way round.
    const comparator = thenBy<Item>(
      byNumberDesc((i) => i.downloads),
      byTextAsc((i) => i.name)
    );
    const forward = [
      item({ name: "beta", downloads: 5 }),
      item({ name: "alpha", downloads: 5 }),
    ].sort(comparator);
    const reversed = [
      item({ name: "alpha", downloads: 5 }),
      item({ name: "beta", downloads: 5 }),
    ].sort(comparator);
    expect(forward.map((i) => i.name)).toEqual(["alpha", "beta"]);
    expect(reversed.map((i) => i.name)).toEqual(forward.map((i) => i.name));
  });

  test("returns 0 when every comparator ties", () => {
    const comparator = thenBy<Item>(byTextAsc((i) => i.name));
    expect(comparator(item({ name: "a" }), item({ name: "a" }))).toBe(0);
  });
});
