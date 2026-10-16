// What a `ui` marketplace item has to be, for every product that installs one.
//
// Why this is in tLib rather than written four times
//
// The installer establishes that a bundle is SAFE TO EXTRACT — zip slip, case
// aliasing, entry counts, declared-vs-actual sizes, compression methods,
// encryption, digests. It cannot establish that the bundle is a usable layout,
// because only a consumer knows what that means. Measured 2026-10-15, exactly one
// of the four consumers had a `ui` contract at all:
//
//   tRadio     server/lib/ui-item-contract.ts, thorough
//   tDetector  none
//   tRadar     none
//   tELS       none
//
// For the three with none, a bundle containing no `ui.html` — or an `install.lua`
// — installed with a success, and the only place left to find out was render time
// on a player's machine, where the symptom is a device that draws nothing and the
// operator has no reason to suspect the thing they just bought.
//
// The part that is genuinely shared is the part all four need, and it is settled
// by the corpus rather than by taste. All ten shipped layouts across tDetector,
// tRadar and tELS are `ui.html` + `module.json` at the archive root plus `.png`
// assets (tELS's WCC nests its under `icons/`). So: a ZIP, with `ui.html` at the
// top level, carrying only the file types a layout legitimately ships.
//
// FAILS ONLY ON WHAT CANNOT WORK — the rule tRadio's own contract states and the
// reason this is a floor and not a style checker. A gate that refuses a layout
// which would have rendered is worse than no gate at all, because the operator
// cannot install what they paid for and has no way to overrule it. Two concrete
// consequences, both deliberate:
//
//   · DECLARED DIMENSIONS ARE NOT CHECKED HERE. The attribute family differs by
//     product (`data-radio-*`, `data-radar-*`) and `ui/preview-canvas.ts` has a
//     fallback tier, so an undeclared canvas is a mis-scale and not a dead
//     layout. A product that wants it passes `checkDocument` — tRadio does, with
//     its `checkLayoutContract`.
//   · INLINE `<script>` IS FINE. Both shipped tELS layouts carry one, which is
//     how a pre-binder layout drives itself. What the allow-list refuses is a
//     separate executable FILE, which nothing in the corpus ships and no consumer
//     reads.

import type { ContentValidator, PreparedPayload } from "./core";

/**
 * The one document every layout is built around.
 *
 * Exactly this spelling, at the archive root. Not a case-insensitive match and
 * not a search of subdirectories: `prepareBundle` special-cases this literal name
 * when it strips the studio-design comment, and every consumer asks for the
 * literal path — tDetector's and tRadar's `layouts/<name>/ui.html`, tRadio's
 * `getRuntimeLayoutText(model, "ui.html")` and `cl_bridge.lua`'s `layoutHtml`.
 * Accepting `UI.HTML` would install a bundle all of those then fail to find,
 * which is worse than refusing it. (A bundle cannot contain both spellings —
 * `prepareBundle` rejects case-aliased zip paths outright.)
 */
export const UI_LAYOUT_DOCUMENT = "ui.html";

/**
 * File types a layout may ship.
 *
 * An allow-list, not a deny-list: a new image format is a one-line addition,
 * where a deny-list is wrong the moment somebody invents a new way to be
 * executable. Anchored to the END, so `skin.png.lua` does not smuggle one past.
 *
 * Note the absences. No `.js` — a layout is markup and CSS, and the preview
 * binder plus each consumer's own driver is what moves it; a layout that could
 * ship script would be shipping script into the NUI's origin. No `.lua`, no
 * `.exe`, no `.dll`, nothing archive-shaped. Extensionless files are refused too,
 * which is what keeps a `README` or a `Makefile` out.
 *
 * This is tRadio's measured list, carried over unchanged — it is a strict
 * superset of every file type in the shipped corpus.
 */
export const UI_LAYOUT_ALLOWED_EXTS =
  /\.(html|css|json|png|jpg|jpeg|gif|svg|webp|wav|ogg|otf|ttf|woff|woff2)$/i;

export interface UiLayoutContractOptions {
  /**
   * A product's own rules for the decoded `ui.html`, returning one sentence per
   * problem and an empty list when it is happy.
   *
   * The seam exists because the floor above is all four consumers agree on and
   * the document rules are not: tRadio requires `data-radio-width`/`-height` and
   * refuses an unusable one, which would refuse every tRadar layout.
   *
   * Decoded as UTF-8, because that is how every consumer reads it — Lua's
   * `LoadResourceFile`, the runtime cache's text decode and the stores' regexes
   * all treat it as text.
   */
  checkDocument?: (html: string) => readonly string[];
  /** Override the allow-list. Defaults to {@link UI_LAYOUT_ALLOWED_EXTS}. */
  allowedFiles?: RegExp;
}

/**
 * A {@link ContentValidator} for the `ui` type: hand it to
 * `createMarketplaceAgent`'s `validators`, not to a call site.
 *
 * Registered on the agent so EVERY route into a resource's install path is gated
 * by the same check — the in-game Lua install event and any HTTP/admin route the
 * consumer builds on `installFromData` directly. A contract enforced on one route
 * only is a contract an operator can walk around without knowing they did, and
 * this estate has already paid for one of those.
 *
 * Rejects by throwing, with every problem in one message rather than the first:
 * an operator fixing a broken layout should not have to install it five times to
 * find five faults. Runs before the staging directory exists, so a rejection
 * touches no disk and leaves nothing to roll back.
 */
export function uiLayoutContract(opts: UiLayoutContractOptions = {}): ContentValidator {
  const allowed = opts.allowedFiles ?? UI_LAYOUT_ALLOWED_EXTS;
  return (payload: PreparedPayload): void => {
    // A raw, non-ZIP bundle is a single file with no name — meaningful for a
    // sound, never for a layout, which is a document plus its artwork.
    if (!payload.zip) {
      throw new Error(
        `Layout "${payload.slug}" is not an archive. A ui item must be a ZIP containing ${UI_LAYOUT_DOCUMENT}.`
      );
    }

    const problems: string[] = [];

    const disallowed = [...payload.files.keys()].filter((name) => !allowed.test(name));
    if (disallowed.length > 0) {
      // Named, and capped: a bundle full of junk should not produce a wall of
      // text in a toast.
      const shown = disallowed.slice(0, 5).join(", ");
      const more = disallowed.length > 5 ? ` (and ${disallowed.length - 5} more)` : "";
      problems.push(`contains file types a layout may not ship: ${shown}${more}`);
    }

    const document = payload.files.get(UI_LAYOUT_DOCUMENT);
    if (document === undefined) {
      problems.push(
        `has no ${UI_LAYOUT_DOCUMENT} at the top level of the archive — that file IS the layout`
      );
    } else if (opts.checkDocument) {
      problems.push(...opts.checkDocument(document.toString("utf8")));
    }

    if (problems.length > 0) {
      throw new Error(`Layout "${payload.slug}" ${problems.join("; ")}`);
    }
  };
}
