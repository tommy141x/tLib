// The marketplace browser, as parts a host composes into its OWN editor chrome.
//
// ── Why these are parts and not a panel ─────────────────────────────────────
//
// tLib also ships a whole marketplace dialog (`MarketplacePanel` in its own
// app), and tDetector and tRadar currently open it over their HUD editors. That
// is the model this module exists to replace: opening a dialog on top of what is
// already an editor is the wrong shape, and the marketplace is supposed to feel
// built into each resource's UI — which is what tRadio already does by hand.
//
// So nothing here renders a backdrop, a dialog, a header or a tab bar. A host
// lays out its own chrome and drops `ItemCard`, `InstalledTab`, `PreviewOverlay`
// and `InstallError` into it, keeping its own filter over what it browses: tELS
// sees patterns and tELS HUDs, tDetector sees tDetector HUDs, and so on.
//
// ── The theming contract ────────────────────────────────────────────────────
//
// Every colour resolves through the `--nui-*` layer in `../../nui-kit/nui.css`,
// never through a host token directly. A host retheming these overrides that
// set — `--nui-surface`, `-inset`, `-text`, `-muted`, `-border`, `-hover`,
// `-danger`, `-accent`, `-radius`, `-control-border` — and nothing else.
//
// ⚠️ If you override a colour that has a `-raw` partner (`--nui-text-raw`,
// `--nui-accent-raw`) you must override the partner too. The partner holds the
// bare HSL triplet the alpha tints are built on, because a resolved colour
// cannot have alpha taken back out of it in CSS that CEF 103 can parse. Miss it
// and the tints paint nothing rather than erroring.
//
// ⚠️ No `color-mix()` and no `oklch()` in any CSS reached from here. NUI is CEF
// 103 and both landed in Chromium 111; CEF drops the declaration silently.

import "./marketplace.css";

export { NuiButton } from "../../nui-kit/NuiButton";
// The install state machine is headless and lives one level up, in
// `../install-machine`. It is surfaced through this barrel because a host that
// composes these parts needs the same predicates to drive them — and because a
// host deriving `busy` itself is how three copies of it appeared in this
// directory in the first place.
export {
  INSTALL_ACTION_LABEL,
  INSTALL_FAILED_FALLBACK,
  type InstallAction,
  installAction,
  installError,
  isInstallBusy,
  isInstalled,
} from "../install-machine";
export * from "./browse";
export { ErrorPane, InstallError } from "./InstallError";
export { InstalledTab } from "./InstalledTab";
export { ItemCard } from "./ItemCard";
export * from "./inspection";
export { PreviewOverlay } from "./PreviewOverlay";
export * from "./types";
