/**
 * What state an install is in, and what the button should therefore say.
 *
 * Why this is its own module
 *
 * Every surface that offers an Install button re-derived the same three
 * questions from the same union, and they had drifted:
 *
 *   - `busy` was declared identically in `ui/ItemCard.tsx`, `ui/PreviewOverlay.tsx`
 *     and `ui/InstalledTab.tsx` — three copies of one boolean.
 *   - `installLabel` was declared VERBATIM in `ui/ItemCard.tsx` and
 *     `ui/PreviewOverlay.tsx`.
 *   - the failure message was extracted in two places with two different
 *     fallbacks: "Could not install this item" in `ui/ItemCard.tsx` and
 *     "Could not install this item. Try again." in `ui/InstallError.tsx`. One
 *     item could therefore describe its own failure two ways depending on
 *     whether you were looking at the card or the overlay.
 *
 * A fourth surface — tRadio's admin panel — does not use this union at all; it
 * carries `marketplaceInstalling: string | null` plus a second
 * `themeInstalling` and derives booleans from those. That is the next consumer,
 * not this module's problem yet, and it is called out rather than quietly
 * accommodated.
 *
 * Headless on purpose
 *
 * No JSX, no class names, no Solid. It is imported by the NUI component graph
 * (CEF 103), by tRadio's Node server bundle and potentially by a Workers build,
 * so it must stay a pure function of its argument.
 *
 * The label split
 *
 * `installAction` returns a TOKEN, not a sentence. `INSTALL_ACTION_LABEL` is
 * the default English copy, which is what tLib's own NUI marketplace renders
 * because that surface is English-only (every string in `ui/` is a literal).
 *
 * A host that localises — tRadio's panel runs every string through `t()` — maps
 * the token itself and must NOT import the label table. Returning a sentence
 * from here would have forced that host to either accept English or go back to
 * deriving its own state, which is how the duplication started.
 */

/**
 * The lifecycle of one item's install, as the UI needs to know it.
 *
 * `done` is deliberately distinct from `installed`: a finished attempt that
 * FAILED is still "done", and the difference between a retry and a reinstall is
 * the only thing that tells a person whether their last click worked.
 *
 * `builtin` is PRESENT-AND-NOT-REMOVABLE, and it is a third thing
 *
 * It is not `idle` (the files are there) and it is not `installed` (there is
 * nothing the marketplace may do to them). Collapsing it into either is the bug
 * this member exists to end: as `idle` the card offers **Install** for something
 * already on disk, which is what the owner reported; as `installed` it offers
 * **Delete**, and the uninstaller addresses `<installPath>/<slug>` with an
 * ownership receipt required beside it, so a Delete on a shipped `QRX-720` forms
 * `layouts/tradio-qrx-720`, matches nothing, and fails. Both are wrong buttons.
 *
 * So a built-in gets NEITHER control. It is a state and not a flag on
 * `installed` because the predicates below are the only thing three surfaces
 * agree through, and a flag they could each read or forget is how the original
 * three copies of `busy` drifted.
 */
export type InstallState =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "uninstalling" }
  | { state: "installed" }
  | { state: "builtin" }
  | { state: "done"; ok: boolean; error?: string };

/** The one fallback sentence, so two surfaces cannot word a failure differently. */
export const INSTALL_FAILED_FALLBACK = "Could not install this item. Try again.";

/**
 * Whether an operation is in flight, i.e. whether the controls must be disabled.
 *
 * Both directions count. A half-finished uninstall is exactly as unsafe to
 * click through as a half-finished install, and reading only `installing` is
 * what let a second request be fired at an item mid-removal.
 */
export function isInstallBusy(state: InstallState): boolean {
  return state.state === "installing" || state.state === "uninstalling";
}

/**
 * Whether the item is on the server as a MARKETPLACE install right now.
 *
 * `builtin` is deliberately NOT true here even though those files are also
 * on the server. Every caller of this reads it to decide whether to draw a
 * management control, and a built-in has none — see the warning on the union.
 * "Is anything on disk" is `isInstalled(s) || isBuiltin(s)`, and no surface has
 * needed to ask that yet; if one does, it should be named rather than smuggled
 * in by widening this.
 */
export function isInstalled(state: InstallState): boolean {
  return state.state === "installed";
}

/** Whether these files shipped with the consumer, and so are not ours to touch. */
export function isBuiltin(state: InstallState): boolean {
  return state.state === "builtin";
}

/**
 * Whether a Delete control may be drawn at all.
 *
 * This REPLACES `isInstalled(s) || s.state === "uninstalling"`, which was
 * written out by hand in `ui/ItemCard.tsx` and `ui/PreviewOverlay.tsx` — two
 * copies of the gate that now has to exclude `builtin`, and therefore two
 * chances for one surface to keep offering a Delete that cannot succeed.
 *
 * `uninstalling` is included because the button must survive its own press: it
 * is what renders the "Deleting…" spinner.
 */
export function canUninstall(state: InstallState): boolean {
  return state.state === "installed" || state.state === "uninstalling";
}

/**
 * Whether the primary (install/reinstall) control may be pressed.
 *
 * `false` for `builtin` — reinstalling a built-in is the duplication this whole
 * fix removes the route to: the install target is the raw slug, so it would
 * write `layouts/tradio-qrx-720/` beside the shipped `layouts/QRX-720/` rather
 * than replace it.
 */
export function canInstall(state: InstallState): boolean {
  return !isBuiltin(state) && !isInstallBusy(state);
}

/**
 * The failure message for a finished-and-failed attempt, else `undefined`.
 *
 * `undefined` rather than `null` or `""`: every call site renders this
 * behind a presence check, and an empty string would paint an empty alert box.
 */
export function installError(state: InstallState): string | undefined {
  if (state.state !== "done" || state.ok) return undefined;
  return state.error ?? INSTALL_FAILED_FALLBACK;
}

/** What the primary button offers to do next. */
export type InstallAction = "install" | "installing" | "reinstall" | "retry" | "builtin";

/**
 * Which of the four things the primary button is currently offering.
 *
 * Note `uninstalling` maps to `install`, not to a state of its own: while a
 * removal is in flight the primary button is disabled anyway (`isInstallBusy`),
 * and what it will offer once the removal lands is an install.
 */
export function installAction(state: InstallState): InstallAction {
  if (state.state === "installing") return "installing";
  // Before `installed`, because a built-in reads as neither an install nor an
  // offer to make one. The token exists so the button can SAY what it is rather
  // than be an unlabelled disabled control: a card with the name of a radio the
  // owner can see in game and no explanation is the same confusion as the wrong
  // button, one step quieter.
  if (state.state === "builtin") return "builtin";
  if (state.state === "installed") return "reinstall";
  if (state.state === "done" && !state.ok) return "retry";
  return "install";
}

/**
 * Default English copy for each action.
 *
 * For English-only surfaces. A localising host maps `InstallAction` through its
 * own catalogue instead — see this module's header.
 */
export const INSTALL_ACTION_LABEL: Record<InstallAction, string> = {
  install: "Install",
  installing: "Installing…",
  reinstall: "Reinstall",
  retry: "Retry",
  // Matches `ui/inspection.ts`'s "Protected built-in" family rather than
  // inventing a third word for it, shortened because this is a button and not a
  // status line.
  builtin: "Built in",
};

/**
 * Why the primary control is inert for a built-in, for its `title`.
 *
 * Here rather than in the components because both of them need it and because
 * it is the one sentence that has to stay true to `installer/core.ts`'s
 * addressing — if the install target ever stops being the raw slug, this is the
 * copy that becomes a lie, and it should be one grep away.
 */
export const BUILTIN_EXPLANATION =
  "Ships with this resource. It is already installed and the marketplace cannot remove it.";
