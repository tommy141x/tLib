/**
 * The shared card contract, and the three defects it was written to end.
 *
 * Every assertion here corresponds to something an owner reported seeing in game
 * on 2026-10-07, and every one of those had the same cause: a surface that drew
 * its own card instead of the shared one, and therefore answered one of these
 * questions differently. The point of testing the HEADLESS answers is that they
 * are the half that is portable across presetWind3 and presetWind4 — the styling
 * is not shared, by decision, so these functions are the entire shared contract
 * and nothing else guards them.
 */

import { describe, expect, it } from "bun:test";
import {
  CARD_COPY,
  cardIdentity,
  type CardStat,
  cardStats,
  cardStatsOf,
  likeAffordance,
  nextLikedState,
} from "../../shared/ts/marketplace/card-model";
import type { MarketplaceItem } from "../../shared/ts/marketplace/item";
import {
  installedNameCandidates,
  isItemInstalledLocally,
  stripResourcePrefix,
} from "../../shared/ts/marketplace/local-name";
import {
  DEFAULT_HUD_PREVIEW_STATE,
  fitScale,
  PREVIEW_FRAME_ATTRS,
  previewBoxStyle,
  previewKind,
  resolvePreviewState,
} from "../../shared/ts/marketplace/ui/preview-frame";

function item(over: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: "i1",
    slug: "tradio-qrx-720",
    type: "ui",
    resource: "tRadio",
    name: "QRX-720",
    description: "A handheld portable.",
    creator_name: "TIMMYG",
    current_version: "1",
    size_bytes: 2048,
    downloads: 0,
    created_at: "2026-10-07",
    ...over,
  };
}

// ── The install-state match ───────────────────────────────────────────────────

describe("local install-name matching", () => {
  /**
   * The reported symptom, as a test: eleven shipped radio heads all offered an
   * Install button because `"QRX-720" !== "tradio-qrx-720"`.
   */
  it("matches a product-namespaced slug against the un-namespaced directory on disk", () => {
    const onDisk = ["DRX-330", "HLX-120", "QRX-720", "SWX-250"];
    expect(isItemInstalledLocally(item({ slug: "tradio-qrx-720" }), onDisk)).toBe(true);
    expect(isItemInstalledLocally(item({ slug: "tradio-ztr-540" }), onDisk)).toBe(false);
  });

  it("ALSO matches the raw slug, because that is what the install route writes", () => {
    // Anything installed through the panel today really does sit in a directory
    // named by the raw slug. Matching only the stripped form would trade eleven
    // false negatives for a different set of them.
    expect(isItemInstalledLocally(item({ slug: "tradio-newhead" }), ["tradio-newhead"])).toBe(true);
    expect(installedNameCandidates(item({ slug: "tradio-newhead" }))).toEqual([
      "tradio-newhead",
      "newhead",
    ]);
  });

  it("compares case-insensitively, since the catalogue lowercases and authors do not", () => {
    expect(isItemInstalledLocally(item({ slug: "tradio-hlx-120g" }), ["HLX-120G"])).toBe(true);
  });

  it("requires the hyphen, so a resource name that is a prefix of another does not strip", () => {
    expect(stripResourcePrefix("tradiology-foo", "tRadio")).toBe("tradiology-foo");
    expect(stripResourcePrefix("tradio-foo", "tRadio")).toBe("foo");
  });

  it("leaves an un-namespaced slug alone, so it is safe to apply unconditionally", () => {
    expect(stripResourcePrefix("qrx-720", "tRadio")).toBe("qrx-720");
    expect(installedNameCandidates({ slug: "qrx-720", resource: "tRadio" })).toEqual(["qrx-720"]);
  });

  it("does not strip a slug that is nothing but the prefix", () => {
    // Stripping would yield "", which compares equal to any other empty candidate.
    expect(stripResourcePrefix("tradio-", "tRadio")).toBe("tradio-");
  });

  it("is a no-op without a resource, rather than throwing", () => {
    expect(stripResourcePrefix("tradio-qrx-720", undefined)).toBe("tradio-qrx-720");
  });

  it("covers the other products' slug shapes, which are the same mistake waiting", () => {
    expect(stripResourcePrefix("tels-wcc2", "tELS")).toBe("wcc2");
    expect(stripResourcePrefix("tdetector-rdx-4000", "tDetector")).toBe("rdx-4000");
    expect(stripResourcePrefix("tradar-chx-800", "tRadar")).toBe("chx-800");
  });
});

// ── The stats row ─────────────────────────────────────────────────────────────

describe("cardStats", () => {
  /**
   * The reported "I also don't see download counts and stuff". tRadio's own card
   * gated the count behind `> 0`, and a freshly imported catalogue is
   * `downloads: 0` for every item, so the gate hid it everywhere.
   */
  it("reports downloads AT ZERO, because zero is known and not unknown", () => {
    expect(cardStats(item({ downloads: 0 }))).toContainEqual({ key: "downloads", value: 0 });
  });

  it("omits likes on ABSENCE but keeps a real zero", () => {
    // Absent means "this host does not have likes"; 0 means "nobody has yet".
    expect(cardStats(item()).some((s) => s.key === "likes")).toBe(false);
    expect(cardStats(item({ likes: 0 }))).toContainEqual({ key: "likes", value: 0 });
  });

  it("puts downloads first, then likes, then size", () => {
    expect(cardStats(item({ likes: 3, size_bytes: 10 })).map((s) => s.key)).toEqual([
      "downloads",
      "likes",
      "size",
    ]);
  });

  it("words the download count as installs, which is what it means to a server owner", () => {
    expect(CARD_COPY.downloads("0")).toBe("0 installs");
  });
});

describe("cardStatsOf — the same contract for a host with its own item type", () => {
  /**
   * ⚠️ These assertions are the reason `cardStatsOf` exists at all. tELS's
   * marketplace tab merges two catalogues into one `CardView` and so will never
   * hold a `MarketplaceItem`; without a narrowed contract its only options were
   * to fake the fields it does not have, or to word and order the stats itself —
   * which is what it did, printing "12 downloads" where every other surface
   * printed "12 installs".
   */
  it("is what `cardStats` delegates to, so there is only one implementation", () => {
    expect(cardStatsOf(item({ likes: 3, size_bytes: 10 }))).toEqual(
      cardStats(item({ likes: 3, size_bytes: 10 })) as CardStat[]
    );
  });

  it("needs nothing but a download count, which is all a merged card model has", () => {
    expect(cardStatsOf({ downloads: 12 })).toEqual([{ key: "downloads", value: 12 }]);
    expect(cardStatsOf({ downloads: 0 })).toEqual([{ key: "downloads", value: 0 }]);
  });

  it("keeps the presence rule for likes, so an absent field is not a confident zero", () => {
    expect(cardStatsOf({ downloads: 1 }).some((s) => s.key === "likes")).toBe(false);
    expect(cardStatsOf({ downloads: 1, likes: 0 })).toContainEqual({ key: "likes", value: 0 });
  });

  it("draws no size chip for a host that measures no size, and none for zero bytes", () => {
    // Unlike `likes`, an unmeasured size and a zero size read the same to a
    // person, and `0B` is noise either way.
    expect(cardStatsOf({ downloads: 1 }).some((s) => s.key === "size")).toBe(false);
    expect(cardStatsOf({ downloads: 1, size_bytes: 0 }).some((s) => s.key === "size")).toBe(false);
  });

  it("holds the order, so a host that walks the array cannot invent its own", () => {
    expect(cardStatsOf({ downloads: 1, likes: 2, size_bytes: 3 }).map((s) => s.key)).toEqual([
      "downloads",
      "likes",
      "size",
    ]);
  });
});

// ── The like affordance ───────────────────────────────────────────────────────

describe("likeAffordance", () => {
  /**
   * ⚠️ This asserts that "no like button" is CORRECT against the deployed
   * backend, which sends neither field. It is the one symptom on the owner's
   * list that is not a bug, and a future pass must not "fix" it by guessing.
   */
  it("is none when the host has no likes at all", () => {
    expect(likeAffordance(item(), true)).toBe("none");
  });

  it("is a plain count when we have the number but not this player's state", () => {
    expect(likeAffordance(item({ likes: 7 }), true)).toBe("count");
  });

  it("is a plain count when the surface cannot say who is asking", () => {
    expect(likeAffordance(item({ likes: 7, liked: false }), false)).toBe("count");
  });

  it("is a button only with both the count and this player's state", () => {
    expect(likeAffordance(item({ likes: 7, liked: false }), true)).toBe("button");
    expect(likeAffordance(item({ likes: 7, liked: true }), true)).toBe("button");
  });

  it("asks for the next state, so a retry after a timeout cannot invert anything", () => {
    expect(nextLikedState(item({ liked: true }))).toBe(false);
    expect(nextLikedState(item({ liked: false }))).toBe(true);
    expect(nextLikedState(item())).toBe(true);
  });
});

describe("cardIdentity", () => {
  it("omits an absent version and description rather than emitting empty lines", () => {
    const id = cardIdentity(item({ current_version: "", description: "" }));
    expect("version" in id).toBe(false);
    expect("description" in id).toBe(false);
  });
});

// ── The preview geometry ──────────────────────────────────────────────────────

describe("fitScale", () => {
  it("fits the constraining axis", () => {
    // 209.5x426.5 into a 300x200 box: height is the binding constraint.
    expect(fitScale({ w: 209.5, h: 426.5 }, { w: 300, h: 200 })).toBeCloseTo(200 / 426.5, 10);
  });

  it("caps at 1 by default, so a small skin is not blown up into artefacts", () => {
    expect(fitScale({ w: 100, h: 100 }, { w: 800, h: 800 })).toBe(1);
  });

  it("upscales when the caller asks, which a thumbnail grid does", () => {
    expect(fitScale({ w: 100, h: 100 }, { w: 800, h: 800 }, { allowUpscale: true })).toBe(8);
  });

  it("returns 1 rather than Infinity or 0 for a degenerate canvas or box", () => {
    // Measuring before layout settles really does hand us a zero-width box.
    expect(fitScale({ w: 0, h: 0 }, { w: 300, h: 200 })).toBe(1);
    expect(fitScale({ w: 200, h: 200 }, { w: 0, h: 0 })).toBe(1);
    expect(fitScale({ w: -5, h: 10 }, { w: 300, h: 200 })).toBe(1);
  });
});

describe("the preview frame contract", () => {
  /**
   * The reported scrollbars. `PreviewOverlay.tsx` set `overflow: hidden` on its
   * scaled wrapper and tRadio's panel did not, which is the whole of why one
   * surface showed scrollbars and the other never did.
   */
  it("clips the scaled wrapper, which is what stops a scrollbar inside the preview", () => {
    const style = previewBoxStyle({ w: 209.5, h: 426.5 }, 0.5);
    expect(style.overflow).toBe("hidden");
    // Without flex-shrink the browser shrinks the box BEFORE the transform runs,
    // so the scale was computed against a width the element no longer has.
    expect(style["flex-shrink"]).toBe("0");
    expect(style.width).toBe("209.5px");
    expect(style.transform).toBe("scale(0.5)");
  });

  it("centres by translating as well as scaling, in one transform", () => {
    const style = previewBoxStyle({ w: 100, h: 100 }, 0.25, { center: true });
    expect(style.transform).toBe("translate(-50%, -50%) scale(0.25)");
    expect(style.position).toBe("absolute");
  });

  it("suppresses frame scrolling and stays in an opaque origin", () => {
    expect(PREVIEW_FRAME_ATTRS.scrolling).toBe("no");
    // `allow-same-origin` alongside `allow-scripts` would hand arbitrary
    // marketplace HTML the embedding panel's session.
    expect(PREVIEW_FRAME_ATTRS.sandbox).toBe("allow-scripts");
    expect(PREVIEW_FRAME_ATTRS.sandbox).not.toContain("allow-same-origin");
  });
});

describe("previewKind", () => {
  it("holds the branch order the surfaces had each nested differently", () => {
    expect(previewKind(item({ type: "sound", preview_url: "u" }))).toBe("sound");
    expect(previewKind(item({ type: "ui", thumbnail: "t" }))).toBe("thumbnail");
    expect(previewKind(item({ type: "ui" }))).toBe("ui");
    expect(previewKind(item({ type: "theme", preview_colors: ["#000"] }))).toBe("swatches");
    expect(previewKind(item({ type: "theme" }))).toBe("none");
  });

  it("falls through a failed thumbnail instead of collapsing the slot", () => {
    expect(previewKind(item({ type: "ui", thumbnail: "t" }), { thumbFailed: true })).toBe("ui");
  });

  it("does not claim a sound is playable without a preview url", () => {
    expect(previewKind(item({ type: "sound" }))).toBe("none");
  });

  it("treats an empty swatch array as nothing, not as a blank swatch row", () => {
    expect(previewKind(item({ type: "theme", preview_colors: [] }))).toBe("none");
  });
});

describe("resolvePreviewState", () => {
  /**
   * The reported blank previews with no mock state. `previewState` is optional
   * all the way down and the binder was only injected `if (state)`, so a surface
   * with no preset — tELS has none — rendered every layout unbound.
   */
  it("falls back to a populated default instead of rendering a dead device", () => {
    expect(resolvePreviewState(null)).toBe(DEFAULT_HUD_PREVIEW_STATE);
    expect(resolvePreviewState(undefined)).toBe(DEFAULT_HUD_PREVIEW_STATE);
    expect(resolvePreviewState({})).toBe(DEFAULT_HUD_PREVIEW_STATE);
  });

  it("still prefers a resource's own preset, which can express more than a table", () => {
    const preset = { ln01: "REAL" };
    expect(resolvePreviewState(preset)).toBe(preset);
  });

  it("nests leds as dot paths, because the preview binder resolves dot paths", () => {
    // A flat `leds_power` silently matches nothing — the documented history of
    // hud-preview-script.ts itself.
    expect((DEFAULT_HUD_PREVIEW_STATE.leds as Record<string, unknown>).power).toBe(true);
  });

  it("defaults leds.power true, because older skins use it as an LCD visibility gate", () => {
    // A default of false blanks the entire screen of every pre-binder skin.
    expect((DEFAULT_HUD_PREVIEW_STATE.leds as Record<string, unknown>).power).toBe(true);
  });
});
