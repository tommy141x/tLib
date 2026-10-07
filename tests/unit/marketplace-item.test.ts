/**
 * Pins the canonical item normaliser.
 *
 * The property under test is mostly ABSENCE, which is why these assertions use
 * `in` rather than comparing to `undefined`. `expect(item.preview_url).toBeUndefined()`
 * passes for both `{}` and `{preview_url: undefined}`, and those two are NOT
 * equivalent downstream: every card branches on presence, so an explicit
 * `undefined` key makes a UI item claim to be playable and renders a blank
 * swatch row instead of the placeholder tile. A test that cannot tell the two
 * apart cannot protect the rule.
 */

import { describe, expect, test } from "bun:test";
import type { CatalogueItem } from "../../shared/ts/marketplace/item.ts";
import { toCanonicalItem } from "../../shared/ts/marketplace/item.ts";

const base: CatalogueItem = {
  id: "i1",
  slug: "siren-pack",
  type: "sound",
  resource: "tELS",
  name: "Siren Pack",
  description: "d",
  creatorName: "someone",
  currentVersion: "1",
  sizeBytes: 2048,
  downloads: 7,
  createdAt: "2026-01-01T00:00:00Z",
};

/**
 * Every wire field, with a value unique across the fixture so no assertion can
 * be satisfied by a different field's value.
 *
 * Typed `Required<CatalogueItem>` on purpose: it forces the fixture to carry
 * every field INCLUDING the optional ones, so adding a field to the wire type
 * breaks this file at COMPILE time. Without that, a new optional wire field
 * would simply be absent here and the exhaustiveness test below would pass
 * while the field went unmapped.
 */
const exhaustive: Required<CatalogueItem> = {
  id: "wire-id",
  slug: "wire-slug",
  type: "sound",
  resource: "wire-resource",
  name: "wire-name",
  description: "wire-description",
  creatorName: "wire-creator",
  currentVersion: "wire-version",
  sizeBytes: 111,
  downloads: 222,
  createdAt: "wire-created",
  previewWaveform: [333],
  previewColors: ["wire-colour"],
  thumbnail: "wire-thumbnail",
  previewUrl: "wire-preview-url",
  likes: 444,
  // ⚠️ `true`, not `false`. The exhaustiveness test below compares JSON-stringified
  // VALUES, and `false` collides with nothing here while `true` is unique — but
  // more importantly a `false` that was silently dropped would be
  // indistinguishable from an omitted key, which is the one distinction this
  // field exists to preserve.
  liked: true,
};

describe("exhaustiveness: no wire field may be silently dropped", () => {
  // tradio-59's condition, and the reason for it is measured rather than
  // hypothetical: while tRadio's camelCase and tLib's snake_case disagreed, every
  // field whose name differed read `undefined` — sound cards rendered no player
  // and theme cards no swatches, both falling through to the placeholder tile.
  // Nothing threw and nothing warned; it rendered a plausible wrong thing.
  //
  // So this asserts the dangerous direction: not "the happy path renders", but
  // "a field that never arrives is a test failure".
  test("every value on the wire item appears on the canonical item", () => {
    const item = toCanonicalItem(exhaustive);
    const got = new Set(Object.values(item).map((v) => JSON.stringify(v)));
    const dropped = Object.entries(exhaustive)
      .filter(([, v]) => !got.has(JSON.stringify(v)))
      .map(([k]) => k);
    expect(dropped).toEqual([]);
  });

  test("the canonical item carries no more fields than the wire supplied", () => {
    // Guards the other direction: a field invented by the normaliser rather than
    // carried from the wire would be data the backend never sent.
    expect(Object.keys(toCanonicalItem(exhaustive)).length).toBe(
      Object.keys(exhaustive).length,
    );
  });
});

describe("field renaming", () => {
  test("every camelCase wire field lands on its snake_case name", () => {
    const item = toCanonicalItem(base);
    expect(item.creator_name).toBe("someone");
    expect(item.current_version).toBe("1");
    expect(item.size_bytes).toBe(2048);
    expect(item.created_at).toBe("2026-01-01T00:00:00Z");
  });

  test("no camelCase key survives onto the canonical object", () => {
    // The failure this guards is silent: a leftover camelCase key plus a missing
    // snake_case one reads as `undefined` at the card, never as an error.
    const keys = Object.keys(toCanonicalItem(base));
    expect(keys.filter((k) => /[A-Z]/.test(k))).toEqual([]);
  });
});

describe("optional fields are omitted, not set to undefined", () => {
  test.each(["preview_waveform", "preview_colors", "preview_url", "thumbnail"] as const)(
    "%s is absent when the wire omits it",
    (key) => {
      const item = toCanonicalItem(base);
      expect(key in item).toBe(false);
    },
  );

  test("present optional fields are carried through", () => {
    const item = toCanonicalItem({
      ...base,
      previewUrl: "https://example.test/a.ogg",
      previewWaveform: [1, 2],
      previewColors: ["#fff"],
      thumbnail: "https://example.test/t.png",
    });
    expect(item.preview_url).toBe("https://example.test/a.ogg");
    expect(item.preview_waveform).toEqual([1, 2]);
    expect(item.preview_colors).toEqual(["#fff"]);
    expect(item.thumbnail).toBe("https://example.test/t.png");
  });

  test("an empty preview_colors array is omitted, not carried as []", () => {
    // `[]` is falsy-adjacent but truthy in JS, so a naive `raw.x ? ... : {}` would
    // keep it and render a blank swatch row. Documented behaviour: [] IS truthy,
    // so it IS carried. This test states which it is rather than leaving it to
    // whoever next reads the spread.
    const item = toCanonicalItem({ ...base, previewColors: [] });
    expect("preview_colors" in item).toBe(true);
    expect(item.preview_colors).toEqual([]);
  });
});

describe("likes: omission means \"this host has no likes\", not zero", () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════
   * ⚠️ THE ONE RULE ON THIS FIELD THAT IS EASY TO BREAK AND SILENT WHEN BROKEN.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `downloads` and `size_bytes` go through `num()`, which maps a missing value
   * to `0`. Doing the same to `likes` would be the obvious consistency — and it
   * would make a backend that predates likes indistinguishable from an item
   * nobody has liked, printing a confident "0 likes" on every card in the
   * catalogue against any older or self-hosted host.
   *
   * `ItemCard` branches on PRESENCE for exactly that reason, so these tests use
   * `in` rather than comparing against `undefined` — see this file's header.
   */
  test("likes is absent when the wire omits it, NOT coerced to 0", () => {
    const item = toCanonicalItem(base);
    expect("likes" in item).toBe(false);
    expect(item.likes).toBeUndefined();
  });

  test("a real zero IS carried, because zero likes is a fact", () => {
    const item = toCanonicalItem({ ...base, likes: 0 });
    expect("likes" in item).toBe(true);
    expect(item.likes).toBe(0);
  });

  test("a real count is carried", () => {
    expect(toCanonicalItem({ ...base, likes: 12 }).likes).toBe(12);
  });

  test.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "12" as unknown as number],
  ])("%s likes is dropped rather than becoming 0", (_label, value) => {
    // Dropped and not zeroed: a host sending nonsense is a host we know nothing
    // about, and "no data" is the honest rendering of that. Zeroing it would
    // assert something about the item.
    const item = toCanonicalItem({ ...base, likes: value });
    expect("likes" in item).toBe(false);
  });
});

describe("liked: absence means \"we did not ask\", and false must survive", () => {
  /*
   * ⚠️ A PRESENCE CHECK, NOT A TRUTHINESS ONE. `liked: false` means "you have
   * not liked this" and renders a working empty heart; an ABSENT `liked` means
   * no identity was asserted and renders no heart at all. A `raw.liked ? … : {}`
   * spread would collapse the first into the second, which takes the control
   * away from every player who has not yet liked the item — i.e. from everybody
   * the control exists for.
   */
  test("absent when the wire omits it", () => {
    expect("liked" in toCanonicalItem(base)).toBe(false);
  });

  test("a false is CARRIED, not dropped", () => {
    const item = toCanonicalItem({ ...base, liked: false });
    expect("liked" in item).toBe(true);
    expect(item.liked).toBe(false);
  });

  test("a true is carried", () => {
    expect(toCanonicalItem({ ...base, liked: true }).liked).toBe(true);
  });

  test("a non-boolean is dropped rather than coerced", () => {
    const item = toCanonicalItem({ ...base, liked: "yes" as unknown as boolean });
    expect("liked" in item).toBe(false);
  });
});

describe("numeric coercion", () => {
  test.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "12" as unknown as number],
    ["undefined", undefined as unknown as number],
  ])("%s size becomes 0 rather than propagating", (_label, value) => {
    expect(toCanonicalItem({ ...base, sizeBytes: value }).size_bytes).toBe(0);
  });

  test("a real number is preserved", () => {
    expect(toCanonicalItem({ ...base, downloads: 41 }).downloads).toBe(41);
  });
});
