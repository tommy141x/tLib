import type { DialogTab } from "./dialog-model";

/**
 * Where a dialog was when the player last left it — tab, scroll, drag offset — so
 * reopening restores it instead of defaulting to top/centre. Presentation only: field
 * values, validation state, and the marketplace browser's own state (search, category,
 * catalogue — refetched on every open) are deliberately never remembered.
 *
 * Lives in page memory, not Lua kvp: nothing here is worth surviving a resource
 * restart, a stale scroll for since-changed fields is worse than starting at the top,
 * and nothing in it is player-specific enough to need to leak.
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

// Keyed by dialog id, so tRadar's and tRadio's settings dialogs restore independently.
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

// The tab to open on, given the tabs this dialog actually has right now. A remembered
// tab is not a promise it still exists — tabs are built per-open from config and
// permissions, so an admin-only tab a player saw before may be gone. A gone id, or one
// that became an `action` tab (a button owning no panel), falls back to the first real
// tab rather than drawing an empty panel.
export function restoredTab(
  tabs: DialogTab[],
  remembered: string | null | undefined
): string | null {
  const selectable = tabs.filter((tab) => !tab.action);
  const first = selectable[0]?.id ?? null;
  if (!remembered) return first;
  return selectable.some((tab) => tab.id === remembered) ? remembered : first;
}

// Keep a dragged panel within half a panel of centre — same rule the drag itself
// enforces. Reapplied on restore because the remembered offset was clamped against the
// window size at the time; a smaller window or a differently-sized dialog could
// otherwise put the panel out of reach.
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
