import { describe, expect, test } from "bun:test";
import {
  ALL_FACETS,
  applyFacet,
  facetCounts,
  matchesSearchTerm,
  normaliseSearchTerm,
} from "../../shared/ts/marketplace/filter";

type Kind = "ui" | "sound" | "theme";
interface Item {
  name: string;
  description?: string | null;
  type: Kind;
}

const item = (name: string, type: Kind, description?: string | null): Item => ({
  name,
  type,
  description,
});

describe("normaliseSearchTerm", () => {
  test("trims and lowercases, so an untouched box is the empty string", () => {
    expect(normaliseSearchTerm("  Siren  ")).toBe("siren");
    expect(normaliseSearchTerm("   ")).toBe("");
    expect(normaliseSearchTerm("")).toBe("");
  });
});

describe("matchesSearchTerm", () => {
  test("an empty term matches EVERYTHING", () => {
    // ⚠️ The inverse would hide the whole catalogue on first paint, which is
    // what a search box at rest must never do.
    expect(matchesSearchTerm(["anything"], "")).toBe(true);
    expect(matchesSearchTerm([], "")).toBe(true);
  });

  test("matches any supplied field, lowercasing the field", () => {
    expect(matchesSearchTerm(["Whelen Liberty"], "liberty")).toBe(true);
  });

  test("⚠️ the TERM must already be normalised — it is not lowercased here", () => {
    // Deliberate asymmetry, and the contract the doc comment states: the term
    // is folded once per keystroke by `normaliseSearchTerm`, the fields are
    // folded once per item. Lowercasing the term again inside this function
    // would be the per-item work the split exists to avoid. A caller that
    // forgets gets no matches, which is why this is pinned rather than papered
    // over.
    expect(matchesSearchTerm(["Whelen Liberty"], "LIBERTY")).toBe(false);
    expect(matchesSearchTerm(["Whelen Liberty"], normaliseSearchTerm("  LIBERTY "))).toBe(true);
  });

  test("searches the description too, which is the divergence it settles", () => {
    // tELS matched the title only; tRadio matched name and description. A theme
    // is looked for by what it looks like, and only the description says that.
    expect(matchesSearchTerm(["Nightfall", "a dark blue dispatch board"], "dark")).toBe(true);
  });

  test("a missing field is skipped, not stringified", () => {
    // `String(null)` is "null", which would make a search for "null" match
    // every item that has no description.
    expect(matchesSearchTerm(["Nightfall", null, undefined], "null")).toBe(false);
    expect(matchesSearchTerm([null, undefined], "anything")).toBe(false);
  });

  test("no match is false", () => {
    expect(matchesSearchTerm(["Nightfall", "dark blue"], "siren")).toBe(false);
  });
});

describe("applyFacet", () => {
  const items = [item("a", "ui"), item("b", "sound"), item("c", "ui")];

  test("the all sentinel returns the input UNCHANGED", () => {
    // Identity: the common case is no narrowing, and this runs in a memo.
    expect(applyFacet(items, ALL_FACETS, (i) => i.type)).toBe(items);
  });

  test("a facet keeps only that facet", () => {
    expect(applyFacet(items, "ui", (i) => i.type).map((i) => i.name)).toEqual(["a", "c"]);
  });

  test("a facet with no items is empty, not everything", () => {
    expect(applyFacet(items, "theme", (i) => i.type)).toHaveLength(0);
  });
});

describe("facetCounts", () => {
  const facets: readonly Kind[] = ["ui", "sound", "theme"];

  test("every declared facet gets a key, including the empty ones", () => {
    // ⚠️ A chip with an absent count renders blank or `undefined` instead of
    // `(0)`, and "there are no themes" is information the reader wants.
    const counts = facetCounts([item("a", "ui")], facets, (i) => i.type);
    expect(counts).toEqual({ all: 1, ui: 1, sound: 0, theme: 0 });
  });

  test("all is the total", () => {
    const counts = facetCounts(
      [item("a", "ui"), item("b", "sound"), item("c", "theme")],
      facets,
      (i) => i.type
    );
    expect(counts.all).toBe(3);
  });

  test("an empty catalogue is all zeroes rather than an empty object", () => {
    expect(facetCounts([], facets, (i) => i.type)).toEqual({
      all: 0,
      ui: 0,
      sound: 0,
      theme: 0,
    });
  });

  test("an item in an undeclared facet counts in all but creates no extra key", () => {
    // A catalogue that starts serving `anim` must not add a key nobody renders,
    // and must not be silently dropped from the total either — it IS in the shop.
    const counts = facetCounts(
      [item("a", "ui"), item("x", "anim" as Kind)],
      facets,
      (i) => i.type
    );
    expect(counts.all).toBe(2);
    expect(counts.ui).toBe(1);
    expect(Object.keys(counts).sort()).toEqual(["all", "sound", "theme", "ui"]);
  });
});
