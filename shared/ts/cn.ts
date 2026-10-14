/**
 * Class-name joiner: `clsx` to flatten, then `unoMerge` so the LAST utility wins.
 * `SHIELDED` holds four namespaces back from it; why, in `shared/ts/README.md`.
 * Name utilities as placeholders, never in full -- UnoCSS extracts from comments.
 */

import type { ClassValue } from "clsx";
import clsx from "clsx";
import { unoMerge } from "unocss-merge";

export function cn(...classLists: ClassValue[]) {
  return mergeShielded(clsx(classLists));
}

/**
 * A bracketed value read as a LENGTH; anything else there is read as a colour.
 * A CSS variable is ambiguous, so it guesses colour, which every one here is.
 */
const LENGTH = String.raw`\[(?:[-+.\d]|(?:clamp|calc|min|max)\()[^\]]*\]`;

/**
 * Utilities held back from `unoMerge` and deduplicated here by the CSS property
 * actually at stake. ORDER MATTERS: first match wins, every colour entry is a
 * catch-all, and `$1` takes capture group 1 so one entry can cover every side of
 * the border box. The ring entries look dead and are not -- see the README.
 */
const SHIELDED: Array<[group: string, match: RegExp]> = [
  // Width before colour in both ring namespaces; the bare word means 1px.
  ["ring-offset-width", new RegExp(String.raw`^ring-offset-(?:\d|${LENGTH}$)`)],
  ["ring-offset-color", /^ring-offset-/],
  ["ring-width", new RegExp(String.raw`^ring(?:-(?:\d+(?:\.\d+)?|${LENGTH}))?$`)],
  ["ring-color", /^ring-(?!inset$)/],
  // Takes a length and nothing else, so one group does what ring-offset needs
  // two for. The leading `-?` is load-bearing: the negative spelling misses
  // every `unoMerge` table, and without it both signs ship together.
  ["outline-offset", /^-?outline-offset-/],
  // THE BARE NAMESPACE WORD IS A STYLE HERE, NOT A WIDTH -- presetWind3 maps it
  // to `outline-style`. The reset spelling is filed with the styles.
  [
    "outline-style",
    /^outline(?:-(?:auto|dashed|dotted|double|hidden|solid|groove|ridge|inset|outset|none|inherit|initial|revert|revert-layer|unset))?$/,
  ],
  // A bracketed non-length falls to the colour catch-all, as presetWind3 does.
  ["outline-width", new RegExp(String.raw`^outline-(?:width-|size-)?(?:\d+(?:\.\d+)?|${LENGTH})$`)],
  ["outline-color", /^outline-/],
  ["border-style", /^border-(?:solid|dashed|dotted|double|hidden|none)$/],
  // Optionally per side; the namespace word alone means 1px.
  [
    "border-width$1",
    new RegExp(String.raw`^border(-(?:[xytrbse]|inline|block))?(?:-(?:\d+(?:\.\d+)?|${LENGTH}))?$`),
  ],
  [
    "border-color$1",
    /^border(-(?:[xytrbse]|inline|block))?-(?!collapse$|separate$|spacing|rounded|rd)/,
  ],
  // Font size in three spellings; the explicit namespaces match on prefix alone.
  ["text-size", /^(?:text-size|font-size)-/],
  ["text-size", /^text-(?:\d+(?:\.\d+)?|base|(?:\d+(?:\.\d+)?)?(?:xs|sm|md|lg|xl))(?:\/\S+)?$/],
  // The worst case here: the colour a bracketed size eats is usually bracketed too.
  ["text-size", new RegExp(String.raw`^text-${LENGTH}(?:/\S+)?$`)],
  [
    "text-color",
    /^text-(?!left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$|shadow($|-)|stroke($|-)|op-|opacity-|indent($|-))/,
  ],
];

/**
 * `unoMerge`, with SHIELDED utilities lifted out and put back afterwards; they
 * are still deduplicated among themselves, per variant prefix. Takes a string
 * because `clsx` has already run and the shield needs individual tokens.
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
 * Splits a prefixed utility on the LAST colon, which is what makes it work where
 * `unocss-merge`'s own parser does not. Scoping by prefix is not cosmetic: a
 * state override is not a conflict, so collapsing across prefixes deletes it.
 */
function splitVariants(cls: string): [prefix: string, base: string] {
  const at = cls.lastIndexOf(":");
  return at === -1 ? ["", cls] : [cls.slice(0, at + 1), cls.slice(at + 1)];
}
