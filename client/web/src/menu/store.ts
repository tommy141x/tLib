import { createSignal, createStore, reconcile } from "solid-js";
import { setLocale } from "./i18n";
import { isItem, normalizeAnchor, withinPresentationBudget } from "./protocol";
import type { Anchor, Branding, Menu, NuiMessage, SearchEntry, Snapshot } from "./types";

export function createMenuStore() {
  // align starts right because source's first-run default is right and the Misc
  // row declares the same, so the panel does not jump across the screen when the
  // stored preference arrives. hidden is separate from visible: the pause menu
  // and a screen fade take the panel off screen without ending the session, and
  // collapsing the two would run the close reset -- losing every in-progress
  // draft -- each time the player pressed Escape.
  const [state, setState] = createStore<{
    visible: boolean;
    hidden: boolean;
    align: Anchor;
    branding: Branding;
    menus: Menu[];
    palettes: { hair?: string[]; makeup?: string[] };
  }>({ visible: false, hidden: false, align: "top-right", branding: {}, menus: [], palettes: {} });
  // Clearing visible clears hidden, and only that direction: an ended session
  // must not stay hidden into the next open, but a snapshot arriving while the
  // pause menu is up must not put the menu back on screen behind it.
  function setVisible(next: boolean) {
    setState((s) => {
      s.visible = next;
      if (!next) s.hidden = false;
    });
  }
  // A signal rather than part of the store: at ~2,300 entries and ~51,000 option
  // labels, createStore would mint a child proxy for every entry and string array
  // the matcher touches, for data that is replaced whole and never rendered.
  // Replacement by identity is also what lets App.tsx cache the prepared form.
  const [searchIndex, setSearchIndex] = createSignal<readonly SearchEntry[]>([]);
  // Encoded size per menu id, so a delta only measures the pages it changes. Each
  // write drops the entries it invalidates first, and a rejected candidate clears
  // the map rather than leaving a stale size behind.
  const sizes = new Map<string, number>();
  function budget(candidate: readonly Menu[], changed: readonly string[]): boolean {
    for (const id of changed) sizes.delete(id);
    if (withinPresentationBudget(candidate, sizes)) return true;
    sizes.clear();
    return false;
  }
  function snapshot(data: Snapshot) {
    sizes.clear();
    setState((s) => {
      reconcile(data.menus, "id")(s.menus);
      s.visible = data.visible;
      if (!data.visible) s.hidden = false;
    });
  }
  function updateMenus(updates: Menu[]): boolean {
    // Response deltas hydrate known pages; they cannot recreate a revoked page.
    const byId = new Map(updates.map((menu) => [menu.id, menu]));
    if (
      byId.size !== updates.length ||
      updates.some((menu) => !state.menus.some((current) => current.id === menu.id))
    )
      return false;
    const candidate = state.menus.map((menu) => byId.get(menu.id) ?? menu);
    if (
      !budget(
        candidate,
        updates.map((menu) => menu.id)
      )
    )
      return false;
    setState((s) => {
      for (const update of updates) {
        const index = s.menus.findIndex((menu) => menu.id === update.id);
        reconcile(update, "id")(s.menus[index]!);
      }
    });
    return true;
  }
  function receive(message: NuiMessage) {
    switch (message.action) {
      case "menu:snapshot":
        snapshot(message.data);
        break;
      case "menu:visible":
        setVisible(message.data);
        break;
      // Hidden means "visible and off screen", so arriving while closed is a
      // no-op rather than a state the next open inherits.
      case "menu:hidden":
        if (state.visible || !message.data)
          setState((s) => {
            s.hidden = message.data;
          });
        break;
      // parseMessage already accepted it; the normalizer runs again only to turn
      // source's 'left'/'right' into corners the stylesheet has classes for.
      case "menu:align":
        setState((s) => {
          s.align = normalizeAnchor(message.data) ?? s.align;
        });
        break;
      // Configuration, not content: replaced whole, so a server that drops its
      // banner gets the plain header back rather than a merge of the two.
      case "menu:branding":
        setState((s) => {
          reconcile(message.data, null)(s.branding);
        });
        break;
      // Held by i18n.ts, not the store: nothing reconciles against a locale, and
      // every component down to MenuRow reads it without being passed a prop.
      case "menu:locale":
        setLocale(message.data);
        break;
      case "menu:palettes":
        setState((s) => {
          reconcile(message.data, null)(s.palettes);
        });
        break;
      // Replaced whole, as the game rebuilds it: the index describes one
      // permission-filtered catalog, and merging would leave revoked rows
      // findable. No reconcile -- nothing renders these, so preserving references
      // would buy only a deep diff.
      case "menu:searchIndex":
        setSearchIndex(message.data);
        break;
      case "menu:menu": {
        const index = state.menus.findIndex((menu) => menu.id === message.data.id);
        const candidate = state.menus
          .filter((menu) => menu.id !== message.data.id)
          .concat(message.data);
        if (!budget(candidate, [message.data.id])) break;
        setState((s) => {
          if (index < 0) s.menus.push(message.data);
          else reconcile(message.data, "id")(s.menus[index]!);
        });
        break;
      }
      case "menu:remove":
        sizes.delete(message.data.menuId);
        setState((s) => {
          s.menus = s.menus.filter((menu) => menu.id !== message.data.menuId);
        });
        break;
      case "menu:patch": {
        const { menuId, itemId, changes } = message.data;
        const menu = state.menus.findIndex((entry) => entry.id === menuId);
        if (menu < 0) break;
        const item = state.menus[menu]!.items.findIndex((entry) => entry.id === itemId);
        if (item < 0 || !isItem({ ...state.menus[menu]!.items[item], ...changes })) break;
        // A patch rewrites the page in place, so its cached size no longer holds.
        sizes.delete(menuId);
        setState((s) => {
          Object.assign(s.menus[menu]!.items[item]!, changes);
        });
        break;
      }
    }
  }
  return { state, searchIndex, snapshot, receive, updateMenus };
}
