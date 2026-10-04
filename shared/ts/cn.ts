/**
 * Class-name joiner for every UI tree in this repo.
 *
 * `clsx` flattens conditionals and arrays; `unoMerge` then resolves conflicts so the LAST
 * utility wins. That second half is the reason this is not just `clsx`: a component that
 * hard-codes a horizontal padding must be overridable by a caller passing a different one,
 * and without the merge both classes ship and the winner is whichever UnoCSS happened to
 * emit later in the stylesheet -- stable in a given build, and silently different in the next.
 *
 * `unocss-merge`, not `tailwind-merge`. It reads UnoCSS's own conflict groups; tailwind-merge
 * hard-codes Tailwind's, which are close enough to look correct and wrong on anything from a
 * custom preset or shortcut.
 *
 * Lives here rather than in each tree because the shared components import it. A component in
 * `shared/ts` cannot reach a consumer's `src/lib/cn.ts`, so any component promoted out of a
 * consumer needs this resolvable from shared -- that is what forced the move, not the four
 * duplicate copies on their own.
 *
 * `clsx` and `unocss-merge` are real `dependencies` of this package, deliberately not
 * `peerDependencies`. Bun auto-installs peers, which is how `shared/ts/node_modules` ended up
 * with its own `solid-js` and gave every consumer two copies of the Solid runtime. Duplicating
 * these two is harmless -- both are pure string functions with no shared state or identity
 * checks -- but the distinction matters for anything that is a singleton, so do not add a
 * stateful package here without making it a peer and deduping it in every consumer's vite
 * config.
 *
 * NOTE ON COMMENTS IN THIS FILE: UnoCSS's content pipeline scans comments as well as code, so
 * a doc comment that spells a utility out in full can emit it as dead CSS. A plain `.ts` is
 * not scanned at all today, which is the only reason the previous version of this file got
 * away with it. Everything below therefore names utilities as namespace-plus-placeholder
 * rather than as complete class names.
 */

import type { ClassValue } from "clsx";
import clsx from "clsx";
import { unoMerge } from "unocss-merge";

export function cn(...classLists: ClassValue[]) {
  return mergeShielded(clsx(classLists));
}

/**
 * Why there is a shield at all.
 *
 * unocss-merge 0.10.0 classifies a utility by, in order: an exact-name table, a table of
 * regexes, a table of NAMESPACE PREFIXES, and finally a "split at the last dash" fallback.
 * Three gaps in that chain make it DELETE a class that conflicts with nothing, and a deletion
 * is not recoverable after the fact -- which is why these are held back from the merge rather
 * than cleaned up behind it.
 *
 * Gap 1 -- the regex tables are keyed to literal values, so an ARBITRARY value in square
 * brackets misses them and falls through to the prefix table. The text namespace is the
 * expensive case: its prefix entry maps to `color`, so an arbitrary FONT SIZE is filed as a
 * text COLOUR and the two annihilate each other. Measured against 0.10.0, with no variant
 * involved at all:
 *
 *     unoMerge("<bracketed-text-size> <text-colour-token>")  ->  only the colour
 *     unoMerge("<text-colour-token> <bracketed-text-size>")  ->  only the size
 *
 * This is not a custom-token problem and not an arbitrary-vs-named problem: an arbitrary
 * COLOUR -- a CSS variable in brackets, which is the dominant spelling in tRadio's admin UI --
 * collides with an arbitrary pixel size exactly the same way, because both land in `color`.
 * Most NAMED sizes escape, because the font-size regex lists them, but NOT the base size,
 * whose name is absent from that regex, so it collides with a text colour too.
 *
 * Gap 2 -- the variant-prefix parser only recognises a variant that is a bare word or that is
 * ENTIRELY wrapped in brackets. A variant which merely CONTAINS brackets -- the data-attribute,
 * aria-attribute and group/peer-data forms that Ark UI's state styling is built on -- matches
 * neither, so the prefix is never stripped and the whole token drops to the last-dash
 * fallback. Every utility under such a variant is then grouped by its leading text alone, so a
 * width and a colour in one namespace become one group and one of them is deleted:
 *
 *     unoMerge("<data-variant>:<border-width> <data-variant>:<border-colour>") -> colour only
 *     unoMerge("<data-variant>:<ring-width>   <data-variant>:<ring-colour>")   -> colour only
 *     unoMerge("<data-variant>:<border-width> <data-variant>:<border-style>")  -> style only
 *     unoMerge("<data-variant>:<text-size>    <data-variant>:<text-colour>")   -> colour only
 *
 * The same pairs under a plain word variant, or under a fully-bracketed selector variant, are
 * all handled correctly -- which is exactly why this hides.
 *
 * Gap 3 -- independent of both, the ring-offset namespace has no colour group of its own, so
 * the offset's colour is filed with the RING's colour and the ring loses its own colour. No
 * variant needed and no custom tokens needed; it is the plain two-token case, and it reaches
 * every focusable element whose focus ring is assembled through this function.
 *
 * None of the three is catchable by any other check here: every class involved is real and
 * resolves to CSS. Only the merged OUTPUT is wrong, which is why the assertions in
 * tests/unit/cn-contract.test.ts are written against the whole returned string.
 */

/**
 * Utilities held back from `unoMerge` and deduplicated here instead.
 *
 * Each entry names a group and matches the utilities that belong to it. The groups are the
 * CSS PROPERTIES actually at stake, and they are genuinely independent: a caller overriding a
 * ring's colour must not lose its width, and a text colour must not cost a text size.
 *
 * ORDER MATTERS -- first match wins, and the colour entries are catch-alls:
 *   - offset width before offset colour, and both before the plain ring entries;
 *   - line style and width before the border colour catch-all;
 *   - every font-size spelling before the text colour catch-all.
 *
 * A `$1` in a group name is substituted from capture group 1 of the match, which is how one
 * entry covers every side of the border box without eight near-identical rows: a top width and
 * a bottom width are different properties and must not collide, while two plain widths must.
 *
 * Deliberate omissions, each because the utility is a boolean or an unrelated property with
 * nothing in these groups to conflict with, and sweeping it in would break a merge that
 * already works: the ring inset flag; the three table utilities in the border namespace
 * (collapse, separate and the spacing scale); the rounded-corner aliases that may be written
 * with a border prefix; and in the text namespace the six alignment keywords, the four
 * text-wrap keywords, the two text-overflow keywords, and the shadow, stroke and opacity
 * sub-namespaces. Those last three sit in the same `color` group as a text colour today and so
 * damage it; leaving them OUT of the shield is what separates them from it, since the colour
 * is held back and they are not.
 */
/**
 * A bracketed arbitrary value that is a LENGTH rather than a colour.
 *
 * The width-or-colour distinction cannot be made from the namespace alone once the value is
 * arbitrary: the border, ring and ring-offset namespaces all take both, in brackets, with the
 * same spelling. This treats a value that opens with a number, a sign or a decimal point, or
 * with one of the four CSS sizing functions, as a length, and everything else -- a CSS
 * variable, a colour keyword, a colour function -- as a colour.
 *
 * It is a heuristic and a CSS variable is genuinely ambiguous, so it guesses colour, which is
 * what every bracketed border and ring value in this repo actually is. Measured: without this
 * distinction a bare border width and a bracketed border COLOUR were classified into one group
 * and one of them was deleted -- the shield reproducing, on three real call sites, the exact
 * defect it exists to prevent. Guessing wrong in the other direction only leaves that one
 * token grouped where 0.10.0 already put it, so it is never worse than having no shield.
 */
const LENGTH = String.raw`\[(?:[-+.\d]|(?:clamp|calc|min|max)\()[^\]]*\]`;

const SHIELDED: Array<[group: string, match: RegExp]> = [
  // Ring offset, width before colour: a bare number or a bracketed length is the width.
  ["ring-offset-width", new RegExp(String.raw`^ring-offset-(?:\d|${LENGTH}$)`)],
  ["ring-offset-color", /^ring-offset-/],
  // The ring itself. The namespace word alone means a 1px ring, as it does for borders.
  ["ring-width", new RegExp(String.raw`^ring(?:-(?:\d+(?:\.\d+)?|${LENGTH}))?$`)],
  ["ring-color", /^ring-(?!inset$)/],
  // Line style is a third independent property, classified before the colour catch-all so a
  // style can never be deduplicated against a colour.
  ["border-style", /^border-(?:solid|dashed|dotted|double|hidden|none)$/],
  // Width, optionally per side; the namespace word alone means 1px.
  [
    "border-width$1",
    new RegExp(
      String.raw`^border(-(?:[xytrbse]|inline|block))?(?:-(?:\d+(?:\.\d+)?|${LENGTH}))?$`,
    ),
  ],
  // Colour, optionally per side, minus the table and rounded-corner utilities.
  [
    "border-color$1",
    /^border(-(?:[xytrbse]|inline|block))?-(?!collapse$|separate$|spacing|rounded|rd)/,
  ],
  // Font size, in three spellings. The two explicit size namespaces take any value, including
  // a theme key, so they are matched on the prefix alone.
  ["text-size", /^(?:text-size|font-size)-/],
  ["text-size", /^text-(?:\d+(?:\.\d+)?|base|(?:\d+(?:\.\d+)?)?(?:xs|sm|md|lg|xl))(?:\/\S+)?$/],
  // The same width-or-colour ambiguity as above, resolved the same way. A bracketed text size
  // is the single most damaging case in this repo, because the colour it annihilates is itself
  // usually written as a bracketed CSS variable.
  ["text-size", new RegExp(String.raw`^text-${LENGTH}(?:/\S+)?$`)],
  [
    "text-color",
    /^text-(?!left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$|shadow($|-)|stroke($|-)|op-|opacity-|indent($|-))/,
  ],
];

/**
 * `unoMerge`, with SHIELDED utilities lifted out and put back afterwards.
 *
 * They are still deduplicated, just among themselves and per variant prefix, so a caller can
 * still override a shielded utility with another from the same group. What they no longer do
 * is annihilate an unrelated class on the way through.
 *
 * Takes a string rather than ClassValue[] because clsx has already run -- the shield needs
 * individual tokens, and unoMerge's own internal clsx call would otherwise happen after this
 * has already split on spaces. `unoMerge` only ever removes entries, so there is nothing for a
 * second pass to find.
 *
 * Two known blind spots, neither currently reachable from this repo's components:
 *
 *   - A utility written in VARIANT-GROUP form -- a variant, a colon, then several utilities in
 *     parentheses -- is one opaque token here and the shield cannot see inside it. The group
 *     transformer is enabled in the shared preset, so this is possible; no component class
 *     string in tLib, tRadio, tAFK, tELS or tUnit uses it today. If one starts to, write the
 *     utilities longhand, or teach this function to expand groups first.
 *   - An important marker is not stripped before matching, so an important-marked utility
 *     falls through to `unoMerge`, which handles the marker itself. That keeps today's
 *     behaviour for those tokens rather than shielding them.
 */
function mergeShielded(classes: string): string {
  const parts = classes.split(" ").filter(Boolean);
  const passed: string[] = [];
  const held = new Map<string, string>();

  outer: for (const cls of parts) {
    const [prefix, base] = splitVariants(cls);
    for (const [group, match] of SHIELDED) {
      const hit = match.exec(base);
      if (hit) {
        held.set(`${prefix}${group.replace("$1", hit[1] ?? "")}`, cls);
        continue outer;
      }
    }
    passed.push(cls);
  }

  if (held.size === 0) return unoMerge(passed.join(" "));
  return [unoMerge(passed.join(" ")), ...held.values()].filter(Boolean).join(" ");
}

/**
 * Splits a prefixed utility into its variant prefix and its bare utility.
 *
 * The LAST colon is the separator. That is what makes this work where unocss-merge's own
 * parser does not: a data-attribute or aria-attribute variant contains brackets without
 * starting with one, and splitting on the last colon handles it, along with a fully-bracketed
 * selector variant and a pseudo-element selector written with a double colon.
 *
 * Scoping by prefix is not cosmetic. A responsive or state override is not a conflict -- the
 * two apply at different times -- so collapsing across prefixes would silently delete the
 * override.
 *
 * It mis-splits a utility whose arbitrary VALUE contains a colon, which in these namespaces
 * means only the explicit length and colour hints. Those appear before the value, so the hint
 * becomes the prefix, the remainder matches nothing, and the token passes through to
 * `unoMerge` unshielded. That is the pre-shield behaviour, not a new failure.
 */
function splitVariants(cls: string): [prefix: string, base: string] {
  const at = cls.lastIndexOf(":");
  return at === -1 ? ["", cls] : [cls.slice(0, at + 1), cls.slice(at + 1)];
}
