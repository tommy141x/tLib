/**
 * Pins the resolved classes of `ui/select.tsx`.
 *
 * ── What this file used to test, and why it does not any more ───────────────
 *
 * The select this replaced was a cva component crossing three `size` tiers with
 * three `density` tiers, and these tests asserted the PRECEDENCE between them —
 * true only because `density` was declared after `size`, invisible to the compiler,
 * and destroyed by swapping two object keys. That was worth pinning while it
 * existed.
 *
 * It no longer exists. That component had zero importers across seven UI-bearing
 * resources: both editors that needed a dropdown wrote their own on `@ark-ui/solid`
 * rather than use it, and this file is now that fork, promoted. Its scale is a
 * single axis with two tiers, so there is no precedence left to get wrong.
 *
 * What CAN still go wrong is the two things the editors forked it over, and those
 * are what is asserted below: the 11px floor, and `bg-popover` rather than
 * `bg-background` on the floating surface. Both are one string edit away from
 * returning and neither fails a build, a typecheck or a lint.
 *
 * Still a TEXT assertion on resolved classes rather than a render: nothing here
 * needs a DOM, and a render test would pass on a component whose classes UnoCSS
 * never emits.
 */

import { describe, expect, mock, test } from "bun:test";
import { cn } from "../cn.ts";

/**
 * `select.tsx` imports two icon modules that unplugin-icons synthesises inside Vite
 * and that do not exist outside it, so Bun cannot resolve them and the suite would
 * die with a module-not-found before a single test ran. `mock.module` fixes that
 * where a resolver hook cannot: Bun's `onResolve` is bundler-only and never fires in
 * the test runtime.
 *
 * The stubs must be registered BEFORE the component module is evaluated, which is
 * why the import below is dynamic with top-level await — static imports are hoisted
 * above this code and would resolve first.
 */
mock.module("~icons/lucide/check", () => ({ default: () => null }));
mock.module("~icons/lucide/chevron-down", () => ({ default: () => null }));

const { SELECT_SIZES, SELECT_CONTENT_CLASS } = await import("./select.tsx");

/**
 * The font-size actually in effect after conflict resolution, asserted to be
 * EXACTLY ONE surviving class.
 *
 * That strictness is the point and it is inherited from the version of this file
 * that came before. `cn("text-sm", "text-[9px]")` leaves BOTH standing —
 * unocss-merge cannot classify an arbitrary `text-[…]` as font-size rather than
 * colour, so it keeps both rather than guess — and a `.find()` would report the
 * first and pass while a second declaration of equal specificity sat in the same
 * string, with emission order in the generated stylesheet deciding what rendered.
 */
function fontSizeOf(classes: string): string | undefined {
  const won = cn(classes).split(/\s+/);
  const hits = won.filter((c) => /^!?text-(xs|sm|base|lg|xl|\[)/.test(c));
  if (hits.length > 1) {
    throw new Error(
      `expected one surviving font-size, got ${hits.length} (${hits.join(" ")}). ` +
        `Two declarations of equal specificity reach the element and emission order ` +
        `decides the winner. Full: "${won.join(" ")}"`
    );
  }
  return hits[0];
}

describe("the 11px floor", () => {
  /**
   * The scale at the top of `shared/css/surface.css` puts the floor at 11px, and
   * the measurement behind it is that a 10px webfont on a dark surface in CEF 103
   * has almost no stem left. Every "the fonts are poor" report this library has
   * collected has been that, not the typeface. The previous select's smallest tier
   * was 9px and tELS overrode it back to 12px with `!important` at runtime.
   */
  test.each(["sm", "default"] as const)("size=%s declares nothing below 11px", (size) => {
    for (const part of [SELECT_SIZES[size].trigger, SELECT_SIZES[size].item]) {
      for (const px of part.matchAll(/text-\[(\d+)px\]/g)) {
        expect(Number.parseInt(px[1], 10)).toBeGreaterThanOrEqual(11);
      }
    }
  });

  test("sm resolves to 11px on the trigger and wins", () => {
    // `!text-[11px]`, with the bang: the trigger is `.prop-input`, which declares
    // its own 12px from a `@layer components` rule that an UNLAYERED utility would
    // otherwise lose to. Without the important flag `sm` silently renders at 12px.
    expect(SELECT_SIZES.sm.trigger).toContain("!");
    expect(fontSizeOf(`prop-input ${SELECT_SIZES.sm.trigger}`)).toBe("!text-[11px]");
  });

  test("a caller's size class still beats the tier", () => {
    // `cn` is last-wins, and the component composes base → tier → caller `class`.
    expect(fontSizeOf(`${SELECT_SIZES.default.trigger} text-[13px]`)).toBe("text-[13px]");
  });
});

describe("the floating surface sits above the panel it opens from", () => {
  /**
   * `--popover` is 9.8%; `--card`, which a panel is filled with, is 6.67%. Painting
   * the Content `bg-background` — 6.67%, the bottom of the ladder — makes the list
   * the same colour as the panel behind it with only a border between them. That is
   * the "black text on a dark grey selector" report and it is why both editors
   * forked this component.
   */
  test("Content is bg-popover, never bg-background or bg-card", () => {
    expect(SELECT_CONTENT_CLASS).toContain("bg-popover");
    expect(SELECT_CONTENT_CLASS).not.toMatch(/\bbg-background\b/);
    expect(SELECT_CONTENT_CLASS).not.toMatch(/\bbg-card\b/);
  });

  test("Content has a border of its own", () => {
    expect(SELECT_CONTENT_CLASS).toContain("border-border");
  });
});

describe("no blurred shadow anywhere in the component", () => {
  /**
   * CEF does not composite a drop shadow usefully — it costs a compositor pass over
   * a moving 3D scene and buys nothing — and tUnit had to zero `--un-shadow`
   * bundle-wide with `!important` specifically to defeat tLib's own components.
   * Every `shadow*` in `shared/ts/ui/*` was stripped for that reason; this keeps it
   * stripped here, where a dropdown is the single most likely place for one to be
   * added back by habit.
   */
  test("the Content class carries no shadow utility", () => {
    expect(SELECT_CONTENT_CLASS).not.toMatch(/\bshadow/);
  });

  test("the source file declares no shadow utility at all", async () => {
    const source = await Bun.file(new URL("./select.tsx", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\bshadow-/);
  });
});
