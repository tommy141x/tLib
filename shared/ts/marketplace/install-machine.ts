/**
 * What state an install is in, and what the button should therefore say. Every Install
 * surface used to re-derive these questions from the union and drifted: the failure fallback
 * read "Could not install this item" in one component and "...Try again." in another, so one
 * item described its own failure two ways. tRadio's admin panel still carries its own
 * `marketplaceInstalling` string and does not use this union.
 *
 * Headless on purpose — no JSX, class names or Solid — since it's imported by the NUI
 * component graph (CEF 103), tRadio's Node server bundle, and potentially a Workers build.
 *
 * `installAction` returns a token, not a sentence; `INSTALL_ACTION_LABEL` is the default
 * English copy tLib's own English-only NUI renders. A localising host (tRadio's panel runs
 * every string through `t()`) maps the token itself and must not import the label table —
 * returning a sentence here would force it back to English or to deriving its own state.
 */

/**
 * The lifecycle of one item's install. `done` is distinct from `installed` — a failed
 * attempt is still "done", and that difference is what tells a retry apart from a reinstall.
 *
 * `builtin` is present-and-not-removable, a genuine third state: not `idle` (files exist)
 * and not `installed` (nothing the marketplace may do to them). Collapsing it into either is
 * the bug this exists to end — as `idle` the card offered Install for something already on
 * disk; as `installed` it offered Delete, which addresses `<installPath>/<slug>` and so forms
 * `layouts/tradio-qrx-720` for a shipped `QRX-720`, matching nothing and failing. A built-in
 * gets neither control.
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
 * Whether an operation is in flight, i.e. controls must be disabled. Both directions count —
 * reading only `installing` let a second request fire at an item mid-removal.
 */
export function isInstallBusy(state: InstallState): boolean {
  return state.state === "installing" || state.state === "uninstalling";
}

/**
 * Whether the item is on the server as a marketplace install right now. `builtin` is
 * deliberately not true here, even though those files are also on disk — every caller reads
 * this to decide whether to draw a management control, and a built-in has none. "Is anything
 * on disk" is `isInstalled(s) || isBuiltin(s)`; name that explicitly if a surface ever needs it.
 */
export function isInstalled(state: InstallState): boolean {
  return state.state === "installed";
}

/** Whether these files shipped with the consumer, and so are not ours to touch. */
export function isBuiltin(state: InstallState): boolean {
  return state.state === "builtin";
}

/**
 * Whether a Delete control may be drawn at all. Named rather than spelled out at each call
 * site, which is how `builtin` came to be offered a Delete. `uninstalling` is included
 * because the button must survive its own press, rendering the "Deleting…" spinner.
 */
export function canUninstall(state: InstallState): boolean {
  return state.state === "installed" || state.state === "uninstalling";
}

/**
 * Whether the primary (install/reinstall) control may be pressed. `false` for `builtin` —
 * the install target is the raw slug, so reinstalling would write `layouts/tradio-qrx-720/`
 * beside the shipped `layouts/QRX-720/` rather than replace it.
 */
export function canInstall(state: InstallState): boolean {
  return !isBuiltin(state) && !isInstallBusy(state);
}

/**
 * The failure message for a finished-and-failed attempt, else `undefined` (not `null` or
 * `""` — every call site renders this behind a presence check, and `""` would paint an
 * empty alert box).
 */
export function installError(state: InstallState): string | undefined {
  if (state.state !== "done" || state.ok) return undefined;
  return state.error ?? INSTALL_FAILED_FALLBACK;
}

/** What the primary button offers to do next. */
export type InstallAction = "install" | "installing" | "reinstall" | "retry" | "builtin";

/**
 * Which of the four things the primary button is currently offering. `uninstalling` maps
 * to `install`, not a state of its own: the button's disabled anyway (`isInstallBusy`), and
 * an install is what it offers once the removal lands.
 */
export function installAction(state: InstallState): InstallAction {
  if (state.state === "installing") return "installing";
  // Checked before `installed`: the token lets the button SAY it's built-in rather than
  // sit disabled with no explanation.
  if (state.state === "builtin") return "builtin";
  if (state.state === "installed") return "reinstall";
  if (state.state === "done" && !state.ok) return "retry";
  return "install";
}

/** Default English copy for each action, for English-only surfaces — see module header. */
export const INSTALL_ACTION_LABEL: Record<InstallAction, string> = {
  install: "Install",
  installing: "Installing…",
  reinstall: "Reinstall",
  retry: "Retry",
  // Matches ui/inspection.ts's "Protected built-in" family, shortened for a button.
  builtin: "Built in",
};

/**
 * Why the primary control is inert for a built-in, for its `title`. Kept here (not in the
 * components) since it must stay true to `installer/core.ts`'s addressing — if the install
 * target ever stops being the raw slug, this copy becomes a lie and should be one grep away.
 */
export const BUILTIN_EXPLANATION =
  "Ships with this resource. It is already installed and the marketplace cannot remove it.";
