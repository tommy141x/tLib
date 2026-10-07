/**
 * What state an install is in, and what the button should therefore say.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
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
 * ── Headless on purpose ─────────────────────────────────────────────────────
 *
 * No JSX, no class names, no Solid. It is imported by the NUI component graph
 * (CEF 103), by tRadio's Node server bundle and potentially by a Workers build,
 * so it must stay a pure function of its argument.
 *
 * ── ⚠️ The label split ──────────────────────────────────────────────────────
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
 */
export type InstallState =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "uninstalling" }
  | { state: "installed" }
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

/** Whether the item is on the server right now. */
export function isInstalled(state: InstallState): boolean {
  return state.state === "installed";
}

/**
 * The failure message for a finished-and-failed attempt, else `undefined`.
 *
 * ⚠️ `undefined` rather than `null` or `""`: every call site renders this
 * behind a presence check, and an empty string would paint an empty alert box.
 */
export function installError(state: InstallState): string | undefined {
  if (state.state !== "done" || state.ok) return undefined;
  return state.error ?? INSTALL_FAILED_FALLBACK;
}

/** What the primary button offers to do next. */
export type InstallAction = "install" | "installing" | "reinstall" | "retry";

/**
 * Which of the four things the primary button is currently offering.
 *
 * Note `uninstalling` maps to `install`, not to a state of its own: while a
 * removal is in flight the primary button is disabled anyway (`isInstallBusy`),
 * and what it will offer once the removal lands is an install.
 */
export function installAction(state: InstallState): InstallAction {
  if (state.state === "installing") return "installing";
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
};
