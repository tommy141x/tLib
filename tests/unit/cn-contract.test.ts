/**
 * The contract for `cn()`, the class-name joiner every NUI tree here renders through, measured
 * against unocss-merge 0.10.0 and clsx 2.1.1 — a version bump changing any case here should fail
 * loudly rather than let a component's class override quietly stop working on some screens.
 *
 * Roughly half of the file is the oracle for the shield in shared/ts/cn.ts, around four defects
 * in 0.10.0 that delete a class rather than duplicate it (see that file's header for the
 * mechanism); the groups tagged SHIELD below all return the wrong answer from a bare
 * `unoMerge(clsx(...))`.
 *
 * Token order is deliberately not asserted except where noted — the cascade never reads order
 * from the attribute, and the shield appends held-back utilities after the merged ones, so an
 * order assertion would test the implementation rather than the contract. `toContain` on the
 * split string asserts set-membership instead.
 */
import { describe, expect, test } from "bun:test";

import { cn } from "../../shared/ts/cn.ts";

/** The returned classes as a set-like array, for order-independent membership assertions. */
const parts = (...args: Parameters<typeof cn>) =>
  cn(...args)
    .split(" ")
    .filter(Boolean);

describe("cn: the parts unocss-merge already gets right", () => {
  test("keeps the last of two genuinely conflicting utilities", () => {
    expect(cn("bg-surface", "bg-surface-raised")).toBe("bg-surface-raised");
    expect(cn("rounded-lg", "rounded-xl")).toBe("rounded-xl");
    expect(cn("px-4", "px-6")).toBe("px-6");
  });

  test("resolves conflicts among this repo's own theme colour names", () => {
    // These names live only in consumers' uno.config.ts files; unocss-merge matches colour
    // utilities by namespace prefix, so they work with no help.
    expect(cn("border-line", "border-accent")).toBe("border-accent");
    expect(cn("text-fg-muted", "text-accent")).toBe("text-accent");
  });

  test("leaves non-conflicting shorthand and longhand alone", () => {
    expect(parts("p-4", "px-6")).toEqual(["p-4", "px-6"]);
    expect(parts("gap-2", "gap-x-4")).toEqual(["gap-2", "gap-x-4"]);
  });

  test("resolves the font families presetWind3 ships", () => {
    // No NUI uno.config.ts here defines a family outside sans/serif/mono, exactly what
    // unocss-merge's font-family group lists — which is why tWeb's CUSTOM_GROUPS layer (for its
    // own `font-hero`) was not ported. Adding a family to a consumer's theme needs that layer too.
    expect(cn("font-sans", "font-mono")).toBe("font-mono");
    expect(parts("font-medium", "font-sans")).toEqual(["font-medium", "font-sans"]);
  });

  test("scopes every conflict to the variant it applies under", () => {
    // A responsive or state override is not a conflict — the two apply at different times, and
    // collapsing them would delete the override.
    expect(parts("font-sans", "md:font-mono")).toEqual(["font-sans", "md:font-mono"]);
    expect(parts("bg-surface", "hover:bg-surface-hover")).toEqual([
      "bg-surface",
      "hover:bg-surface-hover",
    ]);
    expect(cn("md:text-sm", "md:text-lg")).toBe("md:text-lg");
    expect(cn("hover:bg-surface", "hover:bg-surface-hover")).toBe("hover:bg-surface-hover");
    expect(parts("text-[9px]", "md:text-accent")).toEqual(["text-[9px]", "md:text-accent"]);
  });

  test("accepts the conditional forms components actually use", () => {
    // Held in a variable rather than inline `false && "p-4"`, which the linter flags as a
    // constant expression — the point is the runtime falsy value reaching cn(), not its source.
    const inactive = false;
    expect(cn("p-2", inactive && "p-4", undefined, null)).toBe("p-2");
    expect(cn("p-2", { "p-4": true })).toBe("p-4");
    expect(cn("p-2", { "p-4": false })).toBe("p-2");
    expect(parts(["p-2", "text-sm"], "p-4")).toEqual(["p-4", "text-sm"]);
    expect(cn()).toBe("");
  });
});

describe("cn: SHIELD -- a font size and a text colour are independent", () => {
  test("a bracketed font size survives a text colour, and vice versa", () => {
    // The headline defect: unocss-merge's font-size group is keyed to literal values, so a
    // bracketed size misses it, falls through to the namespace table, and is filed as a colour.
    // Unshielded, each of these returns exactly one class.
    expect(parts("text-[9px]", "text-muted-foreground")).toEqual([
      "text-[9px]",
      "text-muted-foreground",
    ]);
    expect(parts("text-muted-foreground", "text-[9px]")).toEqual([
      "text-muted-foreground",
      "text-[9px]",
    ]);
    expect(parts("text-[clamp(1rem,2vw,2rem)]", "text-accent")).toEqual([
      "text-[clamp(1rem,2vw,2rem)]",
      "text-accent",
    ]);
    expect(parts("text-[10px]/4", "text-accent")).toEqual(["text-[10px]/4", "text-accent"]);
  });

  test("a bracketed size survives a bracketed COLOUR, which is the common spelling here", () => {
    // tRadio's admin UI writes nearly every colour as a CSS variable in brackets, so both tokens
    // miss the font-size group and land in the same colour bucket — a pairing that appears
    // hundreds of times across tRadio's server-side class strings.
    expect(parts("text-[10px]", "text-[var(--text-secondary)]")).toEqual([
      "text-[10px]",
      "text-[var(--text-secondary)]",
    ]);
    expect(parts("text-[var(--text-secondary)]", "text-[10px]")).toEqual([
      "text-[var(--text-secondary)]",
      "text-[10px]",
    ]);
  });

  test("the base font size survives a text colour, although it is spelled as a word", () => {
    // Named sizes mostly escape the defect because the font-size regex lists them; `base` is
    // absent, so it behaves like a bracketed value and is filed as a colour. Unshielded this
    // returns the colour alone.
    expect(parts("text-base", "text-accent")).toEqual(["text-base", "text-accent"]);
  });

  test("named sizes keep working, which is why this hid for so long", () => {
    expect(parts("text-sm", "text-accent")).toEqual(["text-sm", "text-accent"]);
    expect(parts("text-accent", "text-sm")).toEqual(["text-accent", "text-sm"]);
    expect(parts("text-2xl", "text-accent")).toEqual(["text-2xl", "text-accent"]);
  });

  test("two font sizes still resolve against each other, in every spelling", () => {
    // Shielding must not become "keep both" — a size is still overridable by a size. The last
    // two pairs are a bug fix in their own right: unshielded they return both classes and the
    // winner is decided by UnoCSS's emit order.
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
    expect(cn("text-[9px]", "text-[11px]")).toBe("text-[11px]");
    expect(cn("text-size-sm", "text-lg")).toBe("text-lg");
    expect(cn("text-[9px]", "text-sm")).toBe("text-sm");
    expect(cn("text-base", "text-sm")).toBe("text-sm");
  });

  test("two text colours still resolve against each other", () => {
    expect(cn("text-fg-muted", "text-accent")).toBe("text-accent");
    expect(cn("text-[var(--a)]", "text-[var(--b)]")).toBe("text-[var(--b)]");
  });

  test("the text utilities that are neither a size nor a colour are left to unocss-merge", () => {
    // Alignment, wrapping and overflow already group correctly; sweeping them into the colour
    // catch-all would have made the shield delete them.
    expect(parts("text-center", "text-[9px]", "text-accent")).toEqual([
      "text-center",
      "text-[9px]",
      "text-accent",
    ]);
    expect(parts("text-ellipsis", "text-accent")).toEqual(["text-ellipsis", "text-accent"]);
    expect(parts("text-balance", "text-accent")).toEqual(["text-balance", "text-accent"]);
    expect(parts("truncate", "text-accent")).toEqual(["truncate", "text-accent"]);
    expect(cn("text-left", "text-center")).toBe("text-center");
  });

  test("a text shadow or opacity no longer annihilates the text colour", () => {
    // Not a goal of the shield, a consequence of it: these sit in the same colour group as a
    // text colour in 0.10.0, and holding the colour back is what separates them. Unshielded,
    // each of these returns one class.
    expect(parts("text-accent", "text-op-50").sort()).toEqual(["text-accent", "text-op-50"]);
    expect(parts("text-accent", "text-shadow-lg").sort()).toEqual([
      "text-accent",
      "text-shadow-lg",
    ]);
  });
});

describe("cn: SHIELD -- the ring offset colour does not eat the ring colour", () => {
  test("a ring keeps its own colour alongside an offset colour", () => {
    // 0.10.0 has no colour group for the ring-offset namespace, so the offset's colour is filed
    // with the ring's colour and only the last survives — a stock palette collapses identically,
    // no custom token needed. Unshielded, each of these loses the ring colour.
    expect(parts("ring-ring", "ring-offset-surface")).toEqual(["ring-ring", "ring-offset-surface"]);
    expect(parts("ring-red-500", "ring-offset-white")).toEqual([
      "ring-red-500",
      "ring-offset-white",
    ]);
    expect(parts("ring-2 ring-ring ring-offset-2 ring-offset-surface")).toEqual([
      "ring-2",
      "ring-ring",
      "ring-offset-2",
      "ring-offset-surface",
    ]);
  });

  test("the shield does not cost the ring overrides that already worked", () => {
    expect(cn("ring-offset-surface", "ring-offset-canvas")).toBe("ring-offset-canvas");
    expect(cn("ring-offset-2", "ring-offset-4")).toBe("ring-offset-4");
    expect(cn("ring-ring", "ring-accent")).toBe("ring-accent");
    expect(cn("ring-3", "ring-1")).toBe("ring-1");
  });

  test("width and colour are independent in the ring and offset namespaces alike", () => {
    expect(parts("ring-1", "ring-accent")).toEqual(["ring-1", "ring-accent"]);
    expect(parts("ring", "ring-accent")).toEqual(["ring", "ring-accent"]);
    expect(parts("ring-offset-background", "ring-offset-[3px]")).toEqual([
      "ring-offset-background",
      "ring-offset-[3px]",
    ]);
  });

  test("the ring inset flag is a boolean and is deliberately not shielded", () => {
    expect(parts("ring-inset", "ring-accent")).toEqual(["ring-inset", "ring-accent"]);
  });
});

describe("cn: SHIELD -- the outline offset does not eat the outline colour", () => {
  // Gap 4 in shared/ts/cn.ts's header, and the one that matters most: this estate's focus
  // indicator is an outline, never a `ring-*`, because presetWind3 compiles a ring to an
  // outward box-shadow and CEF 103 clips it to nothing inside the `overflow: hidden` ancestor
  // every NUI panel is. Unshielded, the first, second and fourth cases below each silently lose
  // a class; the third (negative-offset) already worked and must keep working.
  // Shipped live twice without `focus-visible:outline-ring` (tUnit's element list rows and its
  // character editor chips both painted focus in `currentColor`); this shield is for the next one.
  test("a width, a style, a colour and a POSITIVE offset all four survive", () => {
    expect(parts("outline-2 outline-solid outline-ring/40 outline-offset-2").sort()).toEqual([
      "outline-2",
      "outline-offset-2",
      "outline-ring/40",
      "outline-solid",
    ]);
  });

  test("the same, with the offset written as a bracketed arbitrary length", () => {
    expect(parts("outline-2 outline-solid outline-ring/40 outline-offset-[2px]").sort()).toEqual([
      "outline-2",
      "outline-offset-[2px]",
      "outline-ring/40",
      "outline-solid",
    ]);
  });

  test("the NEGATIVE offset spelling, which already worked, still does", () => {
    // Green without the shield, asserted anyway: the shield adds `-?` to the offset group, and
    // breaking the spelling two live call sites were migrated to would be worse than the defect.
    expect(parts("outline-2 outline-solid outline-ring/40 -outline-offset-1").sort()).toEqual([
      "-outline-offset-1",
      "outline-2",
      "outline-ring/40",
      "outline-solid",
    ]);
  });

  test("an offset and a colour under the same variant prefix both survive", () => {
    // The prefixed form is how every focus indicator here is actually written. Deletion goes both
    // ways depending on which token came last — offset-then-colour loses the offset,
    // colour-then-offset loses the colour. Unshielded each of these returns one class.
    expect(parts("focus-visible:outline-offset-2 focus-visible:outline-ring/40").sort()).toEqual([
      "focus-visible:outline-offset-2",
      "focus-visible:outline-ring/40",
    ]);
    expect(parts("focus-visible:outline-ring focus-visible:outline-offset-1").sort()).toEqual([
      "focus-visible:outline-offset-1",
      "focus-visible:outline-ring",
    ]);
  });

  test("the explicit width spellings and a bracketed length keep the colour too", () => {
    // `outline-width-`/`outline-size-` are presetWind3's own aliases; a bracketed CSS math value
    // is routed to its width handler. All three landed in the colour group unshielded.
    expect(parts("outline-width-2", "outline-ring/40").sort()).toEqual([
      "outline-ring/40",
      "outline-width-2",
    ]);
    expect(parts("outline-[2px]", "outline-ring/40").sort()).toEqual([
      "outline-[2px]",
      "outline-ring/40",
    ]);
  });

  test("a bracketed value that is NOT a length is treated as the colour", () => {
    // The `LENGTH` heuristic, same call presetWind3's `handleColorOrWidth` makes. A CSS variable
    // in brackets is the dominant colour spelling in this estate.
    expect(parts("outline-[var(--ring)]", "outline-offset-2").sort()).toEqual([
      "outline-[var(--ring)]",
      "outline-offset-2",
    ]);
  });

  test("both signs of the offset are ONE group, so they deduplicate against each other", () => {
    // The second half of Gap 4, and a missed conflict rather than an invented one: the negative
    // spelling escapes every table in 0.10.0, so unshielded these two values of one property
    // both ship. Order is asserted here, because which one wins is the whole point.
    expect(cn("outline-offset-[2px] -outline-offset-1")).toBe("-outline-offset-1");
    expect(cn("-outline-offset-1 outline-offset-2")).toBe("outline-offset-2");
  });

  test("the shield does not cost the outline overrides that already worked", () => {
    expect(cn("outline-offset-2", "outline-offset-4")).toBe("outline-offset-4");
    expect(cn("outline-ring/40", "outline-ring/80")).toBe("outline-ring/80");
    expect(cn("outline-2", "outline-4")).toBe("outline-4");
    expect(cn("outline-solid", "outline-dashed")).toBe("outline-dashed");
    expect(cn("outline-none", "outline-hidden")).toBe("outline-hidden");
  });

  test("the bare namespace word is a STYLE here, not a width", () => {
    // Where the outline namespace parts company with border and ring: presetWind3 maps bare
    // `outline` to `outline-style: solid`. So it must not deduplicate against a width, and it
    // must not be read as one either.
    expect(parts("outline", "outline-ring/40").sort()).toEqual(["outline", "outline-ring/40"]);
    expect(parts("outline", "outline-2").sort()).toEqual(["outline", "outline-2"]);
    expect(cn("outline", "outline-dashed")).toBe("outline-dashed");
  });

  test("ConfirmDelete's four focus tokens now survive INSIDE cn()", () => {
    // ConfirmDelete concatenates these outside `cn()` deliberately — its own header measures why.
    // This asserts the workaround is no longer needed: the icon-only form's box is the glyph, so
    // its offset must be positive and can't use the negative spelling `buttonVariants` escapes through.
    const focus =
      "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:outline-offset-2";
    const button = parts(focus, "transition-colors shrink-0 rounded-sm", "text-destructive");
    expect(button).toContain("focus-visible:outline-2");
    expect(button).toContain("focus-visible:outline-solid");
    expect(button).toContain("focus-visible:outline-ring/40");
    expect(button).toContain("focus-visible:outline-offset-2");
    expect(button).toContain("outline-none");
    // A caller may now override one of them without losing the other three — impossible with
    // the concatenated form.
    const overridden = parts(focus, "focus-visible:outline-offset-4");
    expect(overridden).toContain("focus-visible:outline-offset-4");
    expect(overridden).not.toContain("focus-visible:outline-offset-2");
    expect(overridden).toContain("focus-visible:outline-ring/40");
  });
});

describe("cn: SHIELD -- a border colour does not delete a border width", () => {
  test("width, colour and line style are three independent properties", () => {
    expect(parts("border-2", "border-dashed", "border-accent")).toHaveLength(3);
    expect(parts("border", "border-primary")).toEqual(["border", "border-primary"]);
    expect(parts("border-x-2", "border-x-accent")).toEqual(["border-x-2", "border-x-accent"]);
  });

  test("each is still overridable within its own group", () => {
    expect(cn("border-2", "border-4")).toBe("border-4");
    expect(cn("border-line", "border-accent")).toBe("border-accent");
    expect(cn("border-solid", "border-dashed")).toBe("border-dashed");
  });

  test("the sides of the box do not collide with each other", () => {
    expect(parts("border-t-2", "border-b-4")).toEqual(["border-t-2", "border-b-4"]);
    expect(cn("border-t-2", "border-t-4")).toBe("border-t-4");
  });

  test("the table utilities in the border namespace are not dragged into the colour group", () => {
    // Unrelated properties that happen to share the namespace; the colour catch-all excludes
    // them by name, and this keeps that exclusion honest.
    expect(parts("border-collapse", "border-spacing-2")).toHaveLength(2);
    expect(cn("border-collapse", "border-separate")).toBe("border-separate");
  });

  test("a rounded-corner utility written with the border prefix still merges as a radius", () => {
    expect(cn("rounded-md", "border-rounded-lg")).toBe("border-rounded-lg");
  });
});

describe("cn: SHIELD -- a bracketed border or ring value is read as width or colour", () => {
  test("a bracketed length is a width and a bracketed colour is a colour", () => {
    // Nothing in the namespace distinguishes them, so the shield reads the value: a number,
    // sign, decimal point or CSS sizing function means a length, anything else means a colour.
    // Getting this wrong made the shield itself delete a border at three real call sites in
    // tRadio's colour picker, where a 1px border meets a bracketed CSS-variable colour.
    expect(parts("border-[3px]", "border-accent")).toEqual(["border-[3px]", "border-accent"]);
    expect(parts("border", "border-[var(--border)]")).toEqual(["border", "border-[var(--border)]"]);
    expect(parts("border-2", "border-[rgba(var(--ring-rgb),0.5)]")).toEqual([
      "border-2",
      "border-[rgba(var(--ring-rgb),0.5)]",
    ]);
    expect(parts("focus-visible:ring-2", "focus-visible:ring-[var(--accent-raw)]")).toEqual([
      "focus-visible:ring-2",
      "focus-visible:ring-[var(--accent-raw)]",
    ]);
  });

  test("two bracketed values of the same kind still resolve against each other", () => {
    expect(cn("border-[2px]", "border-[4px]")).toBe("border-[4px]");
    expect(cn("border-[var(--a)]", "border-[var(--b)]")).toBe("border-[var(--b)]");
  });
});

describe("cn: SHIELD -- a variant that contains brackets no longer degrades the merge", () => {
  test("a data-attribute variant keeps both a width and a colour", () => {
    // unocss-merge's variant parser accepts a bare word or a fully bracketed selector, but not
    // a variant that merely contains brackets — the prefix is then never stripped and every
    // utility under it groups by its leading text alone, so a width and a colour become one
    // group. This is the form Ark UI's state styling is built on. Unshielded, each of these
    // returns the colour or the style alone.
    expect(
      parts(
        "border border-line-input",
        "data-[state=checked]:border-5",
        "data-[state=checked]:border-accent"
      )
    ).toEqual([
      "border",
      "border-line-input",
      "data-[state=checked]:border-5",
      "data-[state=checked]:border-accent",
    ]);
    expect(parts("data-[focus-visible]:ring-2", "data-[focus-visible]:ring-ring")).toEqual([
      "data-[focus-visible]:ring-2",
      "data-[focus-visible]:ring-ring",
    ]);
    expect(parts("data-[x]:border-2", "data-[x]:border-dashed")).toEqual([
      "data-[x]:border-2",
      "data-[x]:border-dashed",
    ]);
    expect(parts("data-[x]:text-sm", "data-[x]:text-accent")).toEqual([
      "data-[x]:text-sm",
      "data-[x]:text-accent",
    ]);
  });

  test("the aria-attribute and group-data forms behave the same way", () => {
    expect(parts("aria-[selected=true]:border-2", "aria-[selected=true]:border-accent")).toEqual([
      "aria-[selected=true]:border-2",
      "aria-[selected=true]:border-accent",
    ]);
    expect(parts("group-data-[x]:border-2", "group-data-[x]:border-accent")).toEqual([
      "group-data-[x]:border-2",
      "group-data-[x]:border-accent",
    ]);
  });

  test("a conflict under one of those variants is still resolved", () => {
    expect(cn("data-[state=checked]:border-2", "data-[state=checked]:border-4")).toBe(
      "data-[state=checked]:border-4"
    );
    expect(cn("data-[x]:text-sm", "data-[x]:text-lg")).toBe("data-[x]:text-lg");
  });

  test("a bracketed-selector variant and a plain word variant are untouched", () => {
    expect(parts("[&>svg]:ring-2", "[&>svg]:ring-accent")).toEqual([
      "[&>svg]:ring-2",
      "[&>svg]:ring-accent",
    ]);
    expect(parts("peer-checked:border-2", "peer-checked:border-accent")).toEqual([
      "peer-checked:border-2",
      "peer-checked:border-accent",
    ]);
  });
});

describe("cn: the real call sites the shield was measured against", () => {
  // Class lists the components actually build, copied from source — the screens that were
  // wrong, each verified against the unshielded function before the shield landed.

  test("a floating panel's title and description render at their intended size", () => {
    // PopoverTitle and PopoverDescription, sized to a type scale documented at their own
    // definitions. Unshielded, neither size was ever emitted and both inherited the parent's.
    expect(parts("text-[13px] font-semibold text-foreground")).toContain("text-[13px]");
    expect(parts("text-[12px] text-muted-foreground")).toContain("text-[12px]");
  });

  test("a tooltip renders at its intended size", () => {
    // The tooltip's own call: data-attribute variants are the second defect family, and the
    // bracketed transform-origin must pass through untouched.
    const tooltip = parts(
      "z-50 rounded-md bg-secondary px-3 py-1.5 text-[12px] text-secondary-foreground",
      "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-out",
      "data-[state=open]:opacity-100 data-[state=open]:scale-100",
      "data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.96]"
    );
    expect(tooltip).toContain("text-[12px]");
    expect(tooltip).toContain("text-secondary-foreground");
    expect(tooltip).toContain("origin-[var(--transform-origin)]");
  });

  test("a tab trigger renders at its intended size under both variants", () => {
    // The tabs cva: its base carries the size, every variant carries a colour, so the two
    // always meet. Both variants were affected.
    const base =
      "inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5 text-[12px] font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative";
    for (const variant of [
      "text-muted-foreground hover:text-foreground data-[selected]:text-foreground data-[selected]:font-semibold rounded-md relative z-10",
      "text-muted-foreground hover:text-foreground rounded-none pb-3 data-[selected]:text-foreground data-[selected]:font-semibold relative",
    ]) {
      const trigger = parts(base, variant);
      expect(trigger).toContain("text-[12px]");
      expect(trigger).toContain("text-muted-foreground");
      expect(trigger).toContain("data-[selected]:text-foreground");
    }
  });

  test("a toolbar button keeps a visible focus ring", () => {
    // tAFK's editor HUD is the one place in these six resources where the ring colour and the
    // offset colour share a variant prefix, which is what the first defect family needs. The
    // shared components mostly leave the offset colour unprefixed, which is why they escaped.
    const button = parts(
      "group flex items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
      "active:scale-[0.98]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
      "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
      "bg-card/80 border-border/60 hover:bg-secondary"
    );
    expect(button).toContain("focus-visible:ring-ring");
    expect(button).toContain("focus-visible:ring-2");
    expect(button).toContain("focus-visible:ring-offset-2");
    expect(button).toContain("focus-visible:ring-offset-card");
  });

  test("a text input's large size resolves to one font size, not two", () => {
    // tLib and tRadio's Input cva: the base sets one size, the `lg` variant another. Unshielded
    // both shipped, because the base's size is a named size and `base` is not in the font-size
    // regex, so the rendered size was decided by UnoCSS's emit order. The one real call site
    // whose rendered output the shield changes rather than restores.
    const base =
      "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
    const lg = parts(base, "h-12 text-base");
    expect(lg).toContain("text-base");
    expect(lg).not.toContain("text-sm");
    // The prefixed one is a different property on a different element and must survive.
    expect(lg).toContain("file:text-sm");
  });
});
