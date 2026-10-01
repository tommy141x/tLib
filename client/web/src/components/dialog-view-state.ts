import type { DialogTab } from "./dialog-model";

/**
 * Where a dialog was when the player last left it, so reopening it puts them
 * back rather than at the default tab, scrolled to the top, re-centred.
 *
 * This is deliberately PRESENTATION ONLY — which tab, how far each tab's panel
 * was scrolled, and where the panel was dragged to. Nothing here is a value, a
 * result or an error:
 *
 *  - field values are not remembered. A half-typed field that was never
 *    submitted must not reappear looking saved.
 *  - validation state (`attempted`, `touched`, the error list) is not
 *    remembered. Errors belong to a submit attempt, not to a dialog.
 *  - the marketplace browser's own state (search, category, preview overlay,
 *    the catalogue itself) is not remembered. Its data is the answer to a
 *    server round trip that is refetched on every open, so restoring a result
 *    set would be restoring something that may no longer be true. Being ON the
 *    marketplace tab is remembered; what the browser was showing is not.
 *
 * It lives here in the page, in memory, rather than in Lua kvp on purpose.
 * Nothing in it is worth surviving a resource restart — a stale scroll offset
 * for a panel whose fields have since changed is worse than starting at the
 * top — and a page reload (resource restart, reconnect) is exactly when it
 * should be forgotten. It is also why none of it can leak across characters:
 * there is nothing player-specific in it to leak, and the map never reaches
 * disk or the server.
 */
export interface DialogViewState {
  /** Selected tab id, or null for a dialog that declares no tabs. */
  tab: string | null;
  /** Scroll offset of the field panel, keyed by the tab it belongs to. */
  scroll: Record<string, number>;
  /** Where the panel was dragged to, relative to its centred position. */
  offset: DialogOffset;
}
export interface DialogOffset {
  x: number;
  y: number;
}

/** Scroll key for a dialog with no tabs: it has exactly one panel. */
export const DIALOG_NO_TAB = "";

/**
 * Keyed by dialog id, so tRadar's settings and tRadio's settings restore
 * independently even though both are "the settings dialog".
 */
const views = new Map<string, DialogViewState>();

export function recallDialogView(id: string): DialogViewState | undefined {
  return views.get(id);
}

export function rememberDialogView(id: string, state: DialogViewState): void {
  views.set(id, { tab: state.tab, scroll: { ...state.scroll }, offset: { ...state.offset } });
}

/** The escape hatch: a caller that asked for `resetState` gets a fresh dialog. */
export function forgetDialogView(id: string): void {
  views.delete(id);
}

/** Test seam. Nothing in the page calls this — the page reload is the reset. */
export function clearDialogViews(): void {
  views.clear();
}

/**
 * The tab to open on, given the tabs this dialog actually has right now.
 *
 * A remembered tab is not a promise that the tab still exists: tabs here are
 * built per-open from config and permissions, so the Sounds tab a player saw as
 * an admin is simply absent the next time round. An id that is gone — or that
 * has become an `action` tab, which is a button owning no panel — falls back to
 * the first real tab rather than selecting nothing and drawing an empty panel.
 */
export function restoredTab(
  tabs: DialogTab[],
  remembered: string | null | undefined
): string | null {
  const selectable = tabs.filter((tab) => !tab.action);
  const first = selectable[0]?.id ?? null;
  if (!remembered) return first;
  return selectable.some((tab) => tab.id === remembered) ? remembered : first;
}

/**
 * Keep a dragged panel within half a panel of centre, which is the same rule
 * the drag itself enforces. Applied again on restore because the remembered
 * offset was clamped against the window size AT THE TIME — a smaller window, or
 * a dialog that came back a different size, would otherwise put the panel
 * somewhere the player cannot reach it.
 */
export function clampOffset(
  offset: DialogOffset,
  bounds: { panel: { width: number; height: number }; viewport: { width: number; height: number } }
): DialogOffset {
  const maxX = Math.max(0, (bounds.viewport.width - bounds.panel.width) / 2);
  const maxY = Math.max(0, (bounds.viewport.height - bounds.panel.height) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}
