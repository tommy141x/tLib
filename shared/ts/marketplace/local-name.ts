/**
 * "Is the thing on disk the same thing as this catalogue item?" — one answer, for
 * every surface that draws an "Installed" badge. See ../README.md.
 *
 * A catalogue slug is namespaced by product (`tradio-qrx-720`) and a local install
 * name is not (`layouts/QRX-720`); nothing reconciled the two, so every shipped
 * radio head was offered an Install for something already installed.
 */

import type { MarketplaceItem } from "./item";

/**
 * Drop a leading `<resource>-` from a slug, if it carries one. Safe to apply
 * unconditionally: the hyphen is part of the prefix, so `tradiology-foo` does not
 * match `tradio-`, and an un-namespaced slug is returned untouched.
 *
 * Case-insensitive because the resource name is CamelCase (`tRadio`) and the
 * catalogue lowercases slugs, so a case-sensitive compare strips nothing at all.
 */
export function stripResourcePrefix(slug: string, resource: string | undefined): string {
  if (!resource) return slug;
  const prefix = `${resource.toLowerCase()}-`;
  const lower = slug.toLowerCase();
  // `>` and not `>=`: a slug that IS the bare prefix would strip to the empty
  // string, which then compares equal to any other empty candidate.
  if (lower.startsWith(prefix) && lower.length > prefix.length) return slug.slice(prefix.length);
  return slug;
}

/**
 * Every local name this item could legitimately be installed under, most specific
 * first. Both spellings, because both genuinely occur: the raw slug for anything
 * installed through the panel, the stripped slug for anything that shipped with
 * the resource. Matching only one trades one set of false negatives for another.
 *
 * Not a function for choosing an install TARGET — do not reach for
 * `candidates[1]` to rename a destination. See ../README.md.
 */
export function installedNameCandidates(item: {
  slug: string;
  resource?: string;
}): readonly string[] {
  const stripped = stripResourcePrefix(item.slug, item.resource);
  return stripped === item.slug ? [item.slug] : [item.slug, stripped];
}

/**
 * HOW a local name matched, which is the difference between two wrong buttons.
 * `"managed"` matched the raw slug, the only name the marketplace writes and so
 * the only one the uninstaller can address; `"builtin"` matched only the stripped
 * spelling, so the files shipped with the consumer. See ../README.md, including
 * the one case a string compare cannot separate.
 */
export type LocalInstallKind = "managed" | "builtin";

/**
 * Which kind of local install, if any, `installedNames` holds for this item.
 * `"managed"` wins when both spellings are on disk, leaving a Delete that can
 * succeed. Case-insensitive; `Iterable` so a caller passes the array it has.
 */
export function localInstallKind(
  item: { slug: string; resource?: string },
  installedNames: Iterable<string>
): LocalInstallKind | null {
  const raw = item.slug.toLowerCase();
  const stripped = stripResourcePrefix(item.slug, item.resource).toLowerCase();
  let builtin = false;
  for (const name of installedNames) {
    const lower = name.toLowerCase();
    if (lower === raw) return "managed";
    if (lower === stripped) builtin = true;
  }
  return builtin ? "builtin" : null;
}

/** Whether any of `installedNames` is this item. Delegates, so the two cannot drift. */
export function isItemInstalledLocally(
  item: { slug: string; resource?: string },
  installedNames: Iterable<string>
): boolean {
  return localInstallKind(item, installedNames) !== null;
}

/**
 * The other direction, for the Installed tab, which walks `readdir()` output
 * rather than the catalogue: the same namespacing rule read backwards.
 */
export function matchLocalName<T extends { slug: string; resource?: string }>(
  name: string,
  items: Iterable<T>
): { item: T; kind: LocalInstallKind } | null {
  let fallback: { item: T; kind: LocalInstallKind } | null = null;
  for (const item of items) {
    const kind = localInstallKind(item, [name]);
    if (kind === "managed") return { item, kind };
    if (kind === "builtin" && !fallback) fallback = { item, kind };
  }
  return fallback;
}

/** The same question for a full catalogue item, named so a call site reads as one. */
export function isInstalledItem(item: MarketplaceItem, installedNames: Iterable<string>): boolean {
  return isItemInstalledLocally(item, installedNames);
}
