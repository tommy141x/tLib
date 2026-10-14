/**
 * Guards the dead-class detector against its own false-positive history.
 *
 * Every case below is a bug this detector actually shipped, and each one failed
 * the same way: it reported source text that is not a class name, which is the
 * failure that gets a check switched off. A detector nobody trusts is worse
 * than no detector, so the noise cases matter at least as much as the hits.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandVariantGroups, findDeadClasses } from "../../shared/ts/build/dead-classes.ts";

/** Treats a fixed set of tokens as real; everything else generates nothing. */
function stubUno(alive: string[]) {
  const set = new Set(alive);
  return { parseToken: async (token: string) => (set.has(token) ? {} : undefined) };
}

async function deadIn(source: string, alive: string[] = [], file = "c.tsx") {
  const dir = mkdtempSync(join(tmpdir(), "deadclass-"));
  try {
    writeFileSync(join(dir, file), source);
    const dead = await findDeadClasses({ uno: stubUno(alive), roots: [dir] });
    return dead.map((d) => d.token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("expandVariantGroups", () => {
  test("expands a group onto each member", () => {
    expect(expandVariantGroups("hover:(bg-red-500 text-white)")).toBe(
      "hover:bg-red-500 hover:text-white"
    );
  });

  test("balances parens inside the group body", () => {
    // `[^()]*` cut this at the `)` inside minmax, leaving the unbalanced
    // fragments `lg:(grid-cols-[minmax(0,13rem)` and `justify-center)`, both
    // dead by construction.
    expect(expandVariantGroups("lg:(grid-cols-[minmax(0,13rem)] justify-center)")).toBe(
      "lg:grid-cols-[minmax(0,13rem)] lg:justify-center"
    );
  });

  test("leaves the Tailwind-v4 var shorthand intact", () => {
    // UnoCSS's own expandVariantGroup rewrites this to `min-w---reference-width`.
    // That is what the build-time transformer does, but reporting it sends the
    // author looking for a string that is not in their source.
    expect(expandVariantGroups("min-w-(--reference-width)")).toBe("min-w-(--reference-width)");
  });

  test("nests", () => {
    expect(expandVariantGroups("md:(p-2 lg:(m-1 m-2))")).toBe("md:p-2 md:lg:m-1 md:lg:m-2");
  });
});

describe("findDeadClasses", () => {
  test("reports a class that generates nothing", async () => {
    expect(await deadIn('<p class="flex data-disabled:opacity-50" />', ["flex"])).toEqual([
      "data-disabled:opacity-50",
    ]);
  });

  test("ignores a class name quoted inside a comment", async () => {
    // A comment naming a class that was tried and rejected is documentation.
    // Without stripComments the quoted name is harvested and reported, so the
    // check punishes the act of explaining why something is not used.
    const source = '<div class={cn("flex", /* was "old-dead-class" */ x)} />';
    expect(await deadIn(source, ["flex"])).toEqual([]);
  });

  test("ignores group and peer markers, named or not", async () => {
    const source = '<div class="group peer group/drawer peer/field" />';
    expect(await deadIn(source)).toEqual([]);
  });

  test("does not report source text pulled in across an apostrophe", async () => {
    // `label: "don't"` leaves an unpaired quote, so the string matcher pairs
    // the apostrophe with the next quote and hands over the source between
    // them. That arrived as the tokens `more:` and `y:` -- neither is a class,
    // and a report full of them is how a check stops being run.
    //
    const source = [
      'const v = cva("a-b", {',
      '  variants: { tone: { x: ["p-1"] } },',
      '  label: "don\'t",',
      '  more: { y: ["q-2"] },',
      "});",
    ].join("\n");
    expect(await deadIn(source, ["a-b"])).toEqual(["p-1", "q-2"]);
  });

  test("does not resynchronise on a quote inside a string", async () => {
    // `[&_svg:not([class*='size-'])]:size-4` is the shadcn idiom for "unless the
    // caller already sized the icon". With the inner `'` excluded from the
    // string body the outer `"` could never be matched whole, so the scan
    // restarted on the apostrophe and reported a bare `size-` -- along with
    // `h-`, `w-`, `flex-` and `text-` from the same shape elsewhere. None of
    // them appears in any source file as a class.
    const source =
      "const v = cva(\"[&_svg:not([class*='size-'])]:size-4 gap-2\", { variants: {} });";
    expect(await deadIn(source, ["gap-2"])).toEqual(["[&_svg:not([class*='size-'])]:size-4"]);
  });

  test("does not report a recipe's variant selection as a class", async () => {
    // `buttonVariants({ size: "icon-md" })` names a variant of the recipe; the
    // classes it stands for are in the recipe's own `cva(...)`, which is
    // harvested separately. Reported as written, `icon-md` is a finding that is
    // correct-as-written and cannot be acted on -- six of them across
    // solid-starter and tg-new. The sibling literal `"px-0"`, outside the
    // argument object, is still a class and is still checked.
    const source =
      '<div class={cn(buttonVariants({ variant: "ghost", size: "icon-md" }), "px-0", "p-typo")} />';
    expect(await deadIn(source, ["px-0"])).toEqual(["p-typo"]);
  });

  test("still harvests classes from a recipe definition's nested objects", async () => {
    // The blanking above is scoped to `class={...}`. Inside `cva(...)` the
    // nested objects ARE the recipe, and blanking them would hide most of a
    // component's class names -- the exact opposite of what this check is for.
    const source = 'const v = cva("base", { variants: { size: { sm: "h-6 typo-x" } } });';
    expect(await deadIn(source, ["base", "h-6"])).toEqual(["typo-x"]);
  });

  test("does not blank a template literal's interpolation as if it were an object", async () => {
    // The blanking scan skips strings, so `${...}` inside a `class={`...`}`
    // template is left alone and the literal parts either side stay fused to the
    // interpolation marker rather than being reported as a static prefix.
    const source = "<div class={`p-2 tone-${props.tone} typo-y`} />";
    expect(await deadIn(source, ["p-2"])).toEqual(["typo-y"]);
  });

  test("does not report a recipe's default variant as a class", async () => {
    // `defaultVariants` names variants, not classes, and the shadcn convention
    // hyphenates them -- `align: "inline-start"`, `placement: "top-end"` -- so
    // they are indistinguishable from a utility by shape. Both of those were
    // reported against solid-starter, both correct as written. The recipe's real
    // classes, in `variants`, are still checked.
    const source = [
      'const v = cva("base", {',
      '  variants: { align: { "inline-start": "p-1 typo-z" } },',
      '  defaultVariants: { align: "inline-start" },',
      "});",
    ].join("\n");
    expect(await deadIn(source, ["base", "p-1"])).toEqual(["typo-z"]);
  });

  test("checks the descendant-variant spelling instead of dropping it", async () => {
    // `**:` and `*:` are Tailwind's descendant and direct-child variants. The
    // shape guard only admitted a letter, `!`, `[` or `@`, so these were dropped
    // silently -- and `**:[svg]:…` generates nothing under presetWind4, which is
    // exactly the kind of miss this check exists for.
    const source = '<div class="**:[svg]:text-red-500 *:p-1 flex" />';
    expect(await deadIn(source, ["flex", "*:p-1"])).toEqual(["**:[svg]:text-red-500"]);
  });

  test("does not report a comparison operand as a class", async () => {
    // `phase() === "typing-email" && activeRing` inside a class region is a
    // state-machine member, declared as a union a few lines above; it is
    // kebab-case, so by shape alone it is indistinguishable from a utility. The
    // sibling literal, which really is a class, is still checked.
    const source =
      '<div class={cn("p-2 typo-w", phase() === "typing-email" && ring, "typing-password" !== p && ring)} />';
    expect(await deadIn(source, ["p-2"])).toEqual(["typo-w"]);
  });

  test("rejects fragments that cannot be class names", async () => {
    // An unbalanced bracket is source punctuation, not a utility.
    expect(await deadIn('<div class="a-b ]-oops p-3" />', ["a-b"])).toEqual(["p-3"]);
  });

  test("skips cva variant keys", async () => {
    // Variant names are not classes. A bare one like `lg` is already filtered
    // for having no utility punctuation, so the case that needs this guard is
    // the hyphenated key -- `size: { "icon-sm": … }` is the shadcn convention
    // and is indistinguishable from a utility by shape alone.
    const source = 'const v = cva("base", { variants: { size: { "icon-sm": "p-4" } } });';
    expect(await deadIn(source, ["base", "p-4"])).toEqual([]);
  });

  test("harvests classList keys", async () => {
    // The branch not taken in the reviewed screenshot is the one whose typo
    // nobody sees, so the conditional form has to be checked too.
    const source = '<div classList={{ "is-active": a, "data-x:opacity-0": b }} />';
    expect(await deadIn(source, ["is-active"])).toEqual(["data-x:opacity-0"]);
  });

  test("does not treat a comparison operand as a class", async () => {
    // `${issue() === "channel_invalid_coverage_required" ? …}` inside a class
    // template is an expression, not a fallback class.
    const source =
      '<input class={`p-2 ${issue() === "channel_invalid_coverage_required" ? "" : ""}`} />';
    expect(await deadIn(source, ["p-2"])).toEqual([]);
  });

  test("does not cut an interpolation short at a nested brace", async () => {
    // `[^}]*` ended this match at the inner `${props.class}`, leaving `` ` : ""}``
    // fused onto the prefix. The report then named `display-container${props.class`,
    // a token that appears nowhere in the source as a class.
    const source = '<div class={`display-container${props.class ? ` ${props.class}` : ""}`} />';
    expect(await deadIn(source)).toEqual([]);
  });

  test("skips a whole interpolation whose expression contains braces", async () => {
    // Cut at the inner `}`, the leftover expression source `) ? xx : yy}` is
    // harvested from an unambiguous class attribute, so `xx` and `yy` are
    // reported exactly as if they were classes the author wrote.
    const source = "<div class={`p-2 ${cond({ a: 1 }) ? xx : yy}`} />";
    expect(await deadIn(source, ["p-2"])).toEqual([]);
  });

  test("does not report the static prefix of a computed class name", async () => {
    // `home-page-indicator-${props.direction}` renders `home-page-indicator-up`.
    // The prefix alone is not the class, and reporting it sends the author after
    // a name that is correct as written.
    const source = "<svg class={`hpi hpi-${props.direction}`} />";
    expect(await deadIn(source, ["hpi"])).toEqual([]);
  });

  test("treats a class defined in the project's own CSS as declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deadclass-"));
    try {
      writeFileSync(join(dir, "c.tsx"), '<div class="tlib-nui-toasts" />');
      writeFileSync(join(dir, "s.css"), ".tlib-nui-toasts { display: grid; }");
      const dead = await findDeadClasses({ uno: stubUno([]), roots: [dir] });
      expect(dead).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips test files", async () => {
    const source = '<div class="data-disabled:opacity-50" />';
    expect(await deadIn(source, [], "c.test.tsx")).toEqual([]);
  });
});
