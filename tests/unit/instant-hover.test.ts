/**
 * The one-of-many surfaces in tLib have NO hover/active colour transition.
 *
 * The rule, in the owner's words: a lone button or two may fade, but a *list* of
 * buttons whose tint fades in and out behind the cursor makes the whole app feel
 * laggy. The test is density, not element type — if you meet six of a thing in a
 * row, its hover has to land on the frame the cursor arrives, not 100-200ms later.
 *
 * Why this is asserted and not just commented. These classes are consumed through
 * `@tlib/shared` by tELS, tUnit, tRadio, tAFK and tCAD, so one `transition-colors`
 * put back here for "polish" re-slows six products at once, in a repo whose own
 * tests would all still pass. Nothing else reads the decision.
 *
 * The kept cases are asserted too, in the same file. A gate that only bans things
 * reads as "transitions are forbidden", and the next person deletes the slide off
 * the Tabs indicator or the thumb off the Switch. The boundary IS the rule, so
 * both sides of it are evidence.
 *
 * A text parse of the shipped source, deliberately — not an import of the cva
 * objects. `cva()` hands back a function; reading its base would mean trusting a
 * mirror that can agree with this test while disagreeing with the string UnoCSS
 * actually scanned.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const SURFACE = read("shared/css/surface.css");

/** The body of one top-level `.<name> { … }` rule, comments stripped. */
function rule(css: string, selector: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = stripped.match(
    new RegExp(`(^|[\\s,])\\${selector}\\s*\\{([^{}]*)\\}`, "m")
  );
  if (!m) throw new Error(`no rule for ${selector} in surface.css`);
  return m[2];
}

describe("surface.css: a row is one of many", () => {
  // Named rather than looped so a failure says WHICH surface went slow again.
  for (const selector of [".list-row", ".row-action", ".segment"]) {
    test(`${selector} tints instantly`, () => {
      expect(rule(SURFACE, selector)).not.toContain("transition");
    });
  }

  test(".prop-input keeps its fade — a field is a destination, not a row", () => {
    // The counter-case. A text field is somewhere you go and stop; you do not
    // sweep a cursor across forty of them the way you do a list.
    expect(rule(SURFACE, ".prop-input")).toContain("border-color 120ms");
  });
});

describe("shared/ts/ui: the repeated primitives tint instantly", () => {
  const COLOUR_TRANSITION = /transition-colors|transition-all|transition-\[[^\]]*color/;

  const cases: [string, string][] = [
    // A tab strip is the canonical row of neighbours.
    ["shared/ts/ui/tabs.tsx", "tabTriggerVariants"],
    // `interactive` Cards arrive in grids.
    ["shared/ts/ui/card.tsx", "cardVariants"],
    // Badges arrive in tag rows.
    ["shared/ts/ui/badge.tsx", "badgeVariants"],
  ];

  for (const [file, symbol] of cases) {
    test(`${symbol} declares no colour transition`, () => {
      const src = read(file);
      const start = src.indexOf(`const ${symbol} = cva(`);
      expect(start).toBeGreaterThan(-1);
      // cva's call ends at the first `});` that closes it; everything before is
      // the base string plus the variant table, which is all we need to see.
      const body = src.slice(start, src.indexOf("\n});", start));
      expect(body).not.toMatch(COLOUR_TRANSITION);
    });
  }

  test("the Checkbox control and its label declare no colour transition", () => {
    const src = read("shared/ts/ui/checkbox.tsx");
    for (const konst of ["CONTROL_BASE", "LABEL_BASE"]) {
      const start = src.indexOf(`const ${konst} =`);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf('";', start))).not.toMatch(COLOUR_TRANSITION);
    }
  });

  test("the export dropdown's rows declare no colour transition", () => {
    // `tlib-export-row` renders inside a `<For>`; the trigger beside it sits in
    // the prop-editor's icon toolbar. Both are one-of-many.
    const src = read("shared/ts/ui/export-badge.tsx");
    for (const handle of ["tlib-export-row ", "tlib-export-trigger "]) {
      const start = src.indexOf(handle);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf("`}", start))).not.toMatch(COLOUR_TRANSITION);
    }
  });
});

describe("the transitions that carry meaning survive", () => {
  test("the Switch thumb still slides, and the track still follows it", () => {
    // Stripping the track's colour while the thumb kept its 200ms slide would
    // read as broken, not as fast: the two are one movement.
    const src = read("shared/ts/ui/switch.tsx");
    expect(src).toContain("transition-transform duration-200");
    expect(src).toMatch(/transition-\[[^\]]*background-color[^\]]*\] duration-200/);
  });

  test("the Tabs indicator still slides between triggers", () => {
    expect(read("shared/ts/ui/tabs.tsx")).toContain("transition: mounted()");
  });

  test("Popover and Tooltip still animate open", () => {
    for (const file of ["shared/ts/ui/popover.tsx", "shared/ts/ui/tooltip.tsx"]) {
      expect(read(file)).toContain("transition-[opacity,transform] duration-150");
    }
  });
});
