/**
 * "Is the thing on disk the same thing as this catalogue item?" — one answer.
 *
 * ── The defect this exists to end ───────────────────────────────────────────
 *
 * A marketplace slug is NAMESPACED BY PRODUCT and a local install name is not,
 * and nothing reconciled the two. Measured on this estate, 2026-10-07:
 *
 *   catalogue slug        on-disk directory
 *   ────────────────      ─────────────────
 *   tradio-qrx-720        layouts/QRX-720
 *   tradio-swx-250        layouts/SWX-250
 *   tels-wcc2             …
 *   tdetector-rdx-4000    …
 *
 * tRadio's admin panel asked `new Set(adminStore.models).has(item.slug)`, where
 * `models` is literally `readdir(layouts/)`. `"QRX-720" !== "tradio-qrx-720"`,
 * so the answer was `false` for **all eleven shipped radio heads** and every one
 * of them offered an Install button for something already installed. Nothing
 * failed; the panel was simply confident and wrong.
 *
 * Pressing that button is not harmless either: the install route hands the RAW
 * SLUG to `installFromData`, so it would have written a second copy of the same
 * radio to `layouts/tradio-qrx-720/` beside the `layouts/QRX-720/` that was
 * already there. Fixing the match therefore also removes the only route to that
 * duplication, which is why the install target is deliberately left alone here —
 * see the warning on `installedNameCandidates`.
 *
 * ── Why it is shared and headless ───────────────────────────────────────────
 *
 * Every surface that draws an "Installed" badge has to answer this, and the
 * namespacing is a property of the CATALOGUE, not of any one panel: tELS's
 * `tels-wcc2` and tDetector's `tdetector-rdx-4000` are the identical shape. A
 * second copy of this reasoning in the next panel would be the same bug again
 * with a different spelling.
 *
 * Pure string functions — no DOM, no Solid, no fs — so the NUI graph (CEF 103),
 * tRadio's Node server bundle and a Workers build can all call it.
 */

import type { MarketplaceItem } from "./item";

/**
 * Drop a leading `<resource>-` from a slug, if it carries one.
 *
 * ⚠️ The hyphen is part of the prefix and is REQUIRED, which is what keeps this
 * from over-matching: a hypothetical `tradiology-foo` does not start with
 * `tradio-` and is returned untouched. A slug that was never namespaced is also
 * returned untouched, so this is safe to apply unconditionally.
 *
 * Case-insensitive on both sides. The catalogue lowercases slugs and the
 * resource name is CamelCase (`tRadio`), so a case-sensitive compare would
 * never strip anything at all.
 */
export function stripResourcePrefix(slug: string, resource: string | undefined): string {
  if (!resource) return slug;
  const prefix = `${resource.toLowerCase()}-`;
  const lower = slug.toLowerCase();
  // `length > prefix.length`, not `>=`: a slug that IS the bare prefix would
  // otherwise strip to the empty string, which matches nothing useful and would
  // compare equal to any other empty candidate.
  if (lower.startsWith(prefix) && lower.length > prefix.length) return slug.slice(prefix.length);
  return slug;
}

/**
 * Every local name this item could legitimately be installed under, most
 * specific first.
 *
 * ⚠️ BOTH SPELLINGS, and that is not hedging — both genuinely occur:
 *
 *  · the RAW SLUG, because the install route passes `slug` straight to
 *    `installFromData`, so anything installed through the panel today really is
 *    sitting in a directory named `tradio-<model>`;
 *  · the PREFIX-STRIPPED slug, because everything that SHIPPED with the
 *    resource is named by its model (`QRX-720`) and always was.
 *
 * Matching only the stripped form would have broken detection for genuinely
 * marketplace-installed items — trading eleven false negatives for a different
 * set of them. Matching only the raw slug is the bug.
 *
 * ⛔ This is NOT a function for choosing an install TARGET. Do not reach for
 * `candidates[1]` to rename the destination: `layouts/qrx-720` and
 * `layouts/QRX-720` are one directory on Windows and two on Linux, every t*
 * resource ships to Linux containers, and a receipt written against one name
 * cannot uninstall the other. Deciding the on-disk name is a migration, not a
 * string transform.
 */
export function installedNameCandidates(item: {
  slug: string;
  resource?: string;
}): readonly string[] {
  const stripped = stripResourcePrefix(item.slug, item.resource);
  return stripped === item.slug ? [item.slug] : [item.slug, stripped];
}

/**
 * Whether any of `installedNames` is this item.
 *
 * Case-insensitive, because the two sides are produced by different things: the
 * catalogue slugifies to lower case and a directory name is whatever the author
 * typed (`QRX-720`, `HLX-120G`). A case-sensitive compare here is just the
 * original bug with one extra step.
 *
 * `Iterable` rather than `Set`, so a caller can pass the array it already has
 * without building a set the function then rebuilds internally anyway.
 */
export function isItemInstalledLocally(
  item: { slug: string; resource?: string },
  installedNames: Iterable<string>
): boolean {
  const wanted = new Set(installedNameCandidates(item).map((n) => n.toLowerCase()));
  for (const name of installedNames) {
    if (wanted.has(name.toLowerCase())) return true;
  }
  return false;
}

/**
 * The same question for a full catalogue item, kept as a separate named export
 * so a call site reads as what it is rather than as a structural coincidence.
 */
export function isInstalledItem(item: MarketplaceItem, installedNames: Iterable<string>): boolean {
  return isItemInstalledLocally(item, installedNames);
}
