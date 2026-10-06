import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  onSettled,
  reconcile,
  Show,
  untrack,
} from "solid-js";
// One notification timing table for the whole bundle. See `notify()` below for
// why this surface is not itself a toast.
import { TOAST_DURATIONS } from "../lib/toast-lifetime";
import { createEscapeLayer } from "@tlib/shared/escape-layer";
import { applyScopedTheme, themeRevision } from "../stores/theme-store";
import {
  accentFor,
  bannerFor,
  bannerUrl,
  readableInk,
  sampleInk,
  shade,
  skinFor,
  themeIdFor,
} from "./branding";
import { inGame, listen, preview, request } from "./bridge";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CircleAlert,
  Info,
  Search,
  SearchX,
  ShieldAlert,
  X,
} from "./components/lucide";
import { MenuRow } from "./components/MenuRow";
import {
  filterItems,
  type MenuEntry,
  menuEntries,
  moveSelection,
  nearestAncestor,
  optionValue,
  type PreparedIndex,
  prepareIndex,
  type SearchHit,
  searchCatalog,
  selectedOptionValue,
  VISIBLE_ROWS,
  windowStart,
} from "./navigation";
import { createMenuStore } from "./store";
import "./menu.css";
// After menu.css, never before: the vMenu skin is a set of overrides on it.
import "./skins/vmenu.css";
import { locale, t } from "./i18n";
import { sliderValue, stepSlider } from "./navigation";
import { normalizeSnapshot, sliderValueValid, snapshotError } from "./protocol";
import { play } from "./sound";
import { FormattedText, plainText } from "./text";
import type { ActionRequest, MenuItem, NavigationCommand, NuiMessage, Snapshot } from "./types";

interface CapturedAction {
  request: ActionRequest;
  kind: MenuItem["kind"];
  apply?: MenuItem["apply"];
  event: "change" | "activate";
  nextMenu?: string;
  confirm?: string;
  label: string;
  context: string;
  epoch: number;
}

export default function Menu() {
  const { state, snapshot, receive, updateMenus, searchIndex } = createMenuStore();
  const [menuId, setMenuId] = createSignal("main");
  const [query, setQuery] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);

  function openSearch() {
    setSearchOpen(true);
    queueMicrotask(() => search?.focus());
  }
  const [selections, setSelections] = createStore<Record<string, string | undefined>>({});
  const [drafts, setDrafts] = createStore<Record<string, string | number | undefined>>({});
  // Selects and sliders show the new value before the game answers; this is the
  // same idea in the one shape the draft store cannot carry.
  const [toggleDrafts, setToggleDrafts] = createStore<Record<string, boolean | undefined>>({});
  const [pending, setPending] = createSignal<string>();
  const [closing, setClosing] = createSignal(false);
  const [navigating, setNavigating] = createSignal(false);
  const [textEditing, setTextEditing] = createSignal(false);
  const [confirmChoice, setConfirmChoice] = createSignal(false);
  const [notice, setNotice] = createSignal<{ text: string; error: boolean }>();
  const [confirmation, setConfirmation] = createSignal<CapturedAction>();
  const parents = new Map<string, string | undefined>();
  const positions = new Map<string, number>();
  // A signal, not a counter: validAction() reads it from the confirmedItem memo,
  // so a bare `let` bump would be invisible to the reactive graph and leave a
  // stale confirmation dialog over an action that is no longer valid.
  const [epoch, setEpoch] = createSignal(0);
  let search!: HTMLInputElement;
  let panel!: HTMLElement;
  let root!: HTMLDivElement;
  // A theme may supply full menu colors or shared shadcn HSL channels. Only the
  // owner root is adapted, never :root or the shared registry; explicit menu
  // colors win over aliases, and synthesized properties are tracked for removal.
  //
  // The tokens whose translucent tints tokens.css writes as `hsl(var(--x-raw) / a)`
  // — the menu's hover wash, its control border, its hairline rulings, the
  // vMenu skin's row separator, the shared focus ring. NUI is CEF 103, which
  // predates color-mix(), so slash-alpha over a bare triplet is the only way to
  // say "this colour at a% alpha" that the engine will parse at all.
  //
  // Which means every one of those tokens needs a partner holding the SAME
  // colour in unresolved channel form, and a partner cannot be computed from the
  // colour beside it: once `0 0% 93.33%` has been resolved to `hsl(0 0% 93.33%)`
  // the channels are gone as far as CSS is concerned, and no function takes them
  // back out again. That is the whole reason `-raw` partners are hand-written
  // constants in tokens.css rather than derived there.
  //
  // This effect is the last place in the program that still holds the theme's
  // value BEFORE it is resolved, so it is the only place a themed partner can be
  // written at all. Skipping it left a themed menu with correct opaque surfaces
  // and every tint beside them still keyed to stock tLib grey.
  //
  // --accent and --muted are absent on purpose: neither has a `-raw` partner in
  // tokens.css because nothing ever asks for a share of them, and inventing one
  // here would be a token with no readers.
  const rawPartners = new Set(["text", "panel", "border", "selected", "selected-ink"]);
  let themeAliases: string[] = [];
  // Two-argument form. The ONLY reactive read in this whole effect is the theme
  // id, so it is the entire compute half; everything below is DOM measurement
  // and DOM writes, which must not subscribe to anything.
  createEffect(
    () => {
      // themeRevision() belongs in compute: applyScopedTheme reads it
      // internally and would subscribe to nothing from the apply half.
      themeRevision();
      return themeIdFor(state.branding, menuId());
    },
    (themeId) => {
    for (const property of themeAliases) root.style.removeProperty(property);
    themeAliases = [];
    applyScopedTheme(themeId, root);
    const color = (value: string) =>
      CSS.supports("color", value)
        ? value
        : CSS.supports("color", `hsl(${value})`)
          ? `hsl(${value})`
          : undefined;
    // The bare HSL triplet inside a theme value, or nothing.
    //
    // The one question asked is whether the consumers' own expression parses,
    // because that is the only property of a partner that matters. Asking it in
    // exactly the shape tokens.css writes means the check cannot drift from what
    // is being checked. It is also why the legacy comma form is refused rather
    // than unwrapped: `hsl(0, 0%, 93% / 0.5)` is invalid CSS, and a partner that
    // makes its readers drop their declaration is worse than no partner at all.
    const triplet = (value: string) => {
      // `hsl(0 0% 93%)` is a triplet wearing a coat; take the coat off. An hsla()
      // that carries its own alpha fails the test below, correctly — an alpha
      // inside a partner would multiply against the reader's.
      const wrapped = /^hsla?\((.*)\)$/.exec(value.trim());
      const candidate = (wrapped ? wrapped[1]! : value).trim();
      // var() satisfies CSS.supports() whatever it eventually points at, so a
      // partner built from one would be a guess about a value not visible here.
      if (!candidate || candidate.includes("var(")) return undefined;
      return CSS.supports("color", `hsl(${candidate} / 0.5)`) ? candidate : undefined;
    };
    const aliases: Record<string, string> = {
      text: "foreground",
      panel: "card",
      muted: "muted-foreground",
    };
    for (const token of [
      "text",
      "panel",
      "muted",
      "border",
      "accent",
      "selected",
      "selected-ink",
    ]) {
      const property = `--${token}`;
      const own = root.style.getPropertyValue(property).trim();
      const alias = aliases[token] && root.style.getPropertyValue(`--${aliases[token]}`).trim();
      // --muted is a surface in shadcn but text ink in the menu API.
      const value =
        token === "muted" && own && !CSS.supports("color", own) && alias ? alias : own || alias;
      const resolved = value && color(value);
      // Read off the same `value` the line above resolves, not off `resolved`:
      // that is the point, and one statement later it is too late.
      const raw = value && rawPartners.has(token) ? triplet(value) : undefined;
      if (resolved) {
        root.style.setProperty(property, resolved);
        if (!own) themeAliases.push(property);
        const partner = `${property}-raw`;
        // A hex, a named colour or a comma-form hsl() gets no partner, and that
        // is deliberate: tokens.css's stock triplet stays in force, so the tint
        // paints a visible wash in the wrong hue instead of resolving to
        // `hsl( / 0.32)` and painting nothing. Wrong-hue is a theme the owner can
        // finish — name the colour as a triplet, or set the partner directly.
        // Dropped is invisible, and reads as a broken control rather than an
        // unfinished theme. That failure is the entire class of bug this pass
        // exists to remove, so it is never the one chosen here.
        //
        // An explicitly themed partner wins over a derived one, the same way
        // `own` wins over `alias` above: the owner stated it, so it is not ours
        // to overwrite.
        if (raw && !root.style.getPropertyValue(partner).trim()) {
          root.style.setProperty(partner, raw);
          // Tracked for removal even when the theme set the colour itself.
          // applyScopedTheme only remembers properties a theme actually named,
          // and this one is synthesized — untracked, it would outlive the theme
          // that justified it and go on tinting the next one.
          themeAliases.push(partner);
        }
      } else if (own) root.style.removeProperty(property);
    }
    }
  );
  let dialog!: HTMLDivElement;
  let noticeTimer: number | undefined;
  let disposed = false;

  // Hidden is a third state between open and closed: mounted, holding every draft,
  // simply not on screen. Anything deciding whether to accept input or talk to the
  // game asks this. validAction still reads state.visible, because an action
  // captured before the pause menu came up is still valid behind it.
  const shown = createMemo(() => state.visible && !state.hidden);
  // A banner that 404s will 404 for every later render of the same URL, so the
  // miss is remembered rather than re-requested, as MenuIcon does.
  const [failedBanner, setFailedBanner] = createSignal<string>();
  const [bannerInk, setBannerInk] = createSignal<"#000000" | "#ffffff">();
  // Per page, not once for the interface: the banner follows the same three
  // branding layers as the accent.
  const banner = createMemo(() => {
    const url = bannerUrl(bannerFor(state.branding, menuId()));
    return url && url !== failedBanner() ? url : undefined;
  });
  const accent = createMemo(() => accentFor(state.branding, menuId()));
  // Header text follows the brand's luminance rather than staying white, or a pale
  // banner or accent renders the title white on white. Measured banner ink wins
  // where the image could be sampled: that is what is actually behind the word.
  const brandStyle = createMemo(() => {
    const colour = accent();
    const ink = (banner() ? bannerInk() : undefined) ?? (colour ? readableInk(colour) : undefined);
    if (!colour && !ink) return undefined;
    return {
      ...(colour
        ? { "--accent": colour, "--brand-from": shade(colour, -0.45), "--brand-to": colour }
        : {}),
      ...(ink ? { "--brand-ink": ink } : {}),
    };
  });
  const menu = createMemo(() => state.menus.find((entry) => entry.id === menuId()));
  // Separate memos: fused, every keystroke re-ran menuEntries and minted fresh row
  // objects, so <For> rebuilt the whole window per character. filterItems returns
  // the same references, so only the set of rows changes.
  const entries = createMemo(() => menuEntries(menu()?.items ?? []));
  const local = createMemo(() => filterItems(entries(), query()));
  // Cached against the index's identity rather than held in a memo. Building it
  // walks every translated label in the granted catalog -- 15.7ms on the real
  // 2,281-row one -- and a memo would pay that on every snapshot push whether or
  // not the player ever types. The first keystroke pays it once instead, and a
  // locale push still invalidates it.
  let cachedIndex: PreparedIndex | undefined;
  function prepared() {
    const index = searchIndex();
    const tag = locale();
    if (!index.length) return undefined;
    if (cachedIndex?.entries !== index || cachedIndex.locale !== tag)
      cachedIndex = prepareIndex(index, tag);
    return cachedIndex;
  }
  // Joined only here, so this is the single place that decides how a trail reads.
  // MenuRow runs t() over the joined string once more; no dictionary key contains
  // ' › ', so it misses and falls through to itself.
  const breadcrumb = (path: readonly string[]) =>
    path.map((part) => plainText(t(part))).join(" › ");
  // Protocol-prefixed so it cannot collide with a catalog item id, which keeps the
  // canonicalId test below unambiguous.
  const SEARCH_ROW = "tlib:menu:searchHit";
  const hits = createMemo(() =>
    query().trim() ? searchCatalog(prepared(), query(), menuId(), state.menus) : []
  );
  // The page's own rows first, then the rest of the catalog under a heading.
  // Appended rather than rendered as a second list so the results inherit the
  // cursor, scroll window, counter and bindings -- in game there is no pointer.
  const items = createMemo<MenuEntry[]>(() => {
    const rows = local();
    const found = hits();
    if (!found.length) return rows as MenuEntry[];
    return [
      ...rows,
      {
        id: JSON.stringify([SEARCH_ROW, "group", null]),
        canonicalId: SEARCH_ROW,
        kind: "status",
        label: "In Other Menus",
      } as MenuEntry,
      ...found.map(
        (hit) =>
          ({
            id: JSON.stringify([SEARCH_ROW, hit.menuId, hit.itemId]),
            canonicalId: SEARCH_ROW,
            kind: "action",
            label: hit.label,
            description: hit.matched,
            rightLabel: breadcrumb(hit.path),
            hit,
          }) as MenuEntry
      ),
    ];
  });
  // The rows the cursor can land on. Its own memo so this and the
  // remembered-position effect below cannot drift into two index spaces again.
  const selectable = createMemo(() => items().filter((item) => item.kind !== "status"));
  const selectedId = createMemo(() => {
    const previous = selections[menuId()];
    const rows = selectable();
    return rows.some((item) => item.id === previous)
      ? previous
      : rows[Math.min(positions.get(menuId()) ?? 0, rows.length - 1)]?.id;
  });
  // Solid 2 does not ship `createSelector`, so this is a plain comparison.
  // The difference is real and accepted: `createSelector` kept one signal per
  // key, so changing the cursor notified exactly the two rows involved, while
  // this notifies every row's `active` prop and lets each one settle. The page
  // is a menu — tens of rows, not thousands — and the previous version's only
  // claim was that O(1) narrowing, not any behaviour the player can see.
  const isSelected = (id: string | undefined) => selectedId() === id;
  const selectedIndex = createMemo(() => items().findIndex((item) => item.id === selectedId()));
  const selected = createMemo(() => items()[selectedIndex()]);
  // MenuAPI's ShowColorPanel/ShowOpacityPanel. Both follow the live draft, so the
  // panel moves with the arrow keys as the row's value does. A colour panel with
  // no palette yet draws nothing rather than an empty grid.
  const rowPanel = createMemo(() => {
    const item = selected();
    if (!item?.panel) return undefined;
    const value = selectedOptionValue(item, drafts[key(item)]);
    if (typeof value !== "number") return undefined;
    if (item.panel === "opacity")
      return { kind: "opacity" as const, value: Math.max(0, Math.min(100, value)) };
    const swatches = item.panel === "hair" ? state.palettes.hair : state.palettes.makeup;
    if (!swatches?.length) return undefined;
    return {
      kind: "color" as const,
      swatches,
      index: value,
      total: item.options?.length ?? swatches.length,
    };
  });
  const start = createMemo(() => windowStart(selectedIndex(), items().length));
  const visibleItems = createMemo(() => items().slice(start(), start() + VISIBLE_ROWS));
  const confirmedItem = createMemo(() => {
    const target = confirmation();
    return target && validAction(target) ? target : undefined;
  });
  const key = (item: MenuEntry) => JSON.stringify([menuId(), item.canonicalId]);
  const context = () => {
    const chain = [];
    const seen = new Set<string>();
    let current = menu();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push([
        current.id,
        current.title,
        current.subtitle,
        current.description,
        current.parent,
        current.contextKey,
        current.items.filter((item) => item.kind === "select").map((item) => [item.id, item.value]),
      ]);
      current = state.menus.find((entry) => entry.id === current?.parent);
    }
    return JSON.stringify(chain);
  };
  function validAction(target: CapturedAction) {
    const item = menu()?.items.find((item) => item.id === target.request.itemId);
    return (
      state.visible &&
      target.epoch === epoch() &&
      target.request.menuId === menuId() &&
      target.context === context() &&
      item &&
      !item.disabled &&
      item.kind === target.kind &&
      item.apply === target.apply &&
      item.confirm === target.confirm &&
      item.nextMenu === target.nextMenu &&
      (item.display === "list"
        ? item.options?.some(
            (option) => option.value === target.request.value && option.label === target.label
          )
        : item.label === target.label) &&
      (item.kind !== "select" ||
        item.options?.some(
          (option) => option.value === target.request.value && !option.disabled
        )) &&
      (item.kind !== "slider" || sliderValueValid(item, target.request.value)) &&
      (item.kind !== "toggle" || target.request.value === !item.value)
    );
  }

  /**
   * The menu's own in-panel notice strip.
   *
   * ── Why this is NOT a toast, having been asked ─────────────────────────────
   *
   * tLib shipped two notification lifetimes with two sets of numbers: this one
   * (error 7000, everything else 2500) and `lib/toast-lifetime.ts`'s
   * `TOAST_DURATIONS` (error 6000, warning 5000, success/info 4000). Two tables
   * is one table too many and the duplicate is gone -- the deadline below is read
   * out of `TOAST_DURATIONS` now, so there is one place a timing changes.
   *
   * The SURFACE stays, deliberately, and it is not a near-miss of the toast:
   *
   *   1. The toast host is a HUD element whose anchor the PLAYER positions, in
   *      the layout editor. It can legitimately sit in any corner, including
   *      behind this panel. A refusal reason is the answer to the keypress just
   *      made and has to be beside the row that refused it; "somewhere the player
   *      chose, earlier, for a different purpose" is not that.
   *   2. This menu is driven entirely by ↑↓/↵ with the eye on the panel. A corner
   *      toast is exactly what gets missed, and `role="alert"` on the strip is
   *      what announces it to a screen reader in the menu's own reading order.
   *   3. Mechanically there is nothing to call. `createToastLifetime` is
   *      instantiated inside `components/Toast.tsx` and fed only by Lua's
   *      `showToast` NUI event; reaching it from here needs either a new
   *      cross-component bus or a NUI→Lua→NUI round trip for a string that is
   *      already in the browser. Both are new mechanisms, which is the thing not
   *      to add.
   *
   * So: one timing table, two surfaces, each where it belongs. `error` picks the
   * `error` deadline and anything else picks `info`'s; this strip has no
   * success/warning/loading states to key off.
   */
  function notify(text: string, error = false) {
    if (error) play("error");
    window.clearTimeout(noticeTimer);
    setNotice({ text, error });
    noticeTimer = window.setTimeout(
      () => setNotice(undefined),
      TOAST_DURATIONS[error ? "error" : "info"]
    );
  }

  function showMenu(id: string) {
    if (!state.menus.some((entry) => entry.id === id)) return;
    setEpoch((value) => value + 1);
    setMenuId(id);
    setQuery("");
    setSearchOpen(false);
    setConfirmation(undefined);
    panel?.focus();
  }

  // A snapshot contextualizes one page; the rest arrive as empty placeholders.
  // Staying on a page the game is no longer tracking draws a placeholder as if it
  // were real and then rejects every navigation off it, Back included.
  function applySnapshot(data: Snapshot) {
    snapshot(data);
    if (
      data.menuId &&
      data.menuId !== menuId() &&
      state.menus.some((entry) => entry.id === data.menuId)
    )
      showMenu(data.menuId);
  }

  let navigationSerial = 0;
  let navigationTimer: number | undefined;
  async function navigate(id: string, reason: "enter" | "back" = "enter") {
    if (!state.visible || closing() || !state.menus.some((entry) => entry.id === id)) return;
    const serial = ++navigationSerial,
      from = menuId(),
      contextKey = menu()?.contextKey;
    // A page whose rows are already here is painted now and confirmed afterwards.
    // The game answers in about 19ms, and the rows in that reply are the rows
    // already in the store -- either prefetched while the cursor rested on the row
    // pointing here, or left from a previous visit. So the wait confirms rather
    // than decides, and it can happen behind a page the player is already reading.
    // A page still a placeholder has nothing to draw and keeps its round trip.
    //
    // The reply stays authoritative: its `menus` replace what was painted and a
    // refusal puts the player back. Acting on the painted page meanwhile is safe
    // because an action is validated against the game's projection, not the DOM.
    const painted = state.menus.some((entry) => entry.id === id && !entry.placeholder);
    if (painted) showMenu(id);
    // After the optimistic paint, since showMenu bumps the epoch: this is the
    // generation the reply is judged against.
    const generation = epoch();
    // Only a page actually waited on gets an indicator, and under 120ms one reads
    // as a flicker.
    window.clearTimeout(navigationTimer);
    if (!painted)
      navigationTimer = window.setTimeout(() => {
        if (serial === navigationSerial) setNavigating(true);
      }, 120);
    const result = await request("navigate", { menuId: id, fromMenuId: from, contextKey, reason });
    window.clearTimeout(navigationTimer);
    if (serial === navigationSerial) setNavigating(false);
    if (
      disposed ||
      serial !== navigationSerial ||
      generation !== epoch() ||
      !state.visible ||
      closing() ||
      menuId() !== (painted ? id : from) ||
      (!painted && menu()?.contextKey !== contextKey)
    )
      return;
    if (result.snapshot) applySnapshot(result.snapshot);
    if (result.menus && !updateMenus(result.menus)) {
      notify("Unable to apply menu update.", true);
      return;
    }
    if (!result.ok) {
      // Painted then refused: back first, told why second, so the notice never
      // appears over a page the player is not on.
      if (painted && menuId() === id) showMenu(from);
      notify(result.error ?? "Unable to open menu.", true);
      // A stale page rejects every navigation, Back included, stranding the player.
      if (result.error === "Menu context changed" || result.error === "Menu unavailable")
        void refreshFromGame();
      else if (result.nextMenu && result.nextMenu !== id && result.nextMenu !== from)
        void navigate(result.nextMenu, "back");
      return;
    }
    if (!painted) showMenu(id);
  }

  async function close() {
    if (closing()) return;
    setClosing(true);
    // The most latency-sensitive press there is: the panel goes straight away and
    // comes back only if the game refuses.
    receive({ action: "menu:visible", data: false });
    const result = await request("close");
    if (disposed) return;
    setClosing(false);
    if (!result.ok) {
      receive({ action: "menu:visible", data: true });
      notify(result.error ?? "Unable to close the menu. Use the menu key to try again.", true);
    }
  }

  function back() {
    play("back");
    if (confirmation()) {
      setConfirmation(undefined);
      panel?.focus();
      return;
    }
    // One press, not two: leaving search takes the query with it.
    if (searchOpen()) {
      endSearch();
      return;
    }
    const parent = menu()?.parent;
    const ancestor = parent ? nearestAncestor(parent, parents, state.menus) : undefined;
    if (ancestor && ancestor !== menuId()) void navigate(ancestor, "back");
    else if (menuId() !== "main" && state.menus.some((entry) => entry.id === "main"))
      void navigate("main", "back");
    else void close();
  }

  function move(direction: number) {
    const next = moveSelection(items(), selectedId(), direction);
    if (next !== undefined) play("nav");
    setSelections((draft) => {
      draft[menuId()] = next;
    });
  }

  function changeSlider(item: MenuEntry, next: number) {
    if (
      !state.visible ||
      closing() ||
      confirmation() ||
      pending() ||
      item.disabled ||
      item.kind !== "slider" ||
      !sliderValueValid(item, next)
    )
      return;
    const previous = sliderValue(item, drafts[key(item)]);
    // A slider clamps rather than wraps, and marks that dead end with the error
    // sound instead of the navigation one.
    play(next === previous ? "error" : "cycle");
    setDrafts((draft) => {
      draft[key(item)] = next;
    });
    if (next !== previous && (item.apply === "change" || item.apply === "both"))
      submit(item, "change", next);
  }

  // A row carrying a value of its own owns left/right. For everything else right
  // is a second Select and left steps back to the parent.
  function ownsArrows(item: MenuEntry) {
    return (
      item.kind === "slider" ||
      (item.kind === "select" && item.display !== "list" && Boolean(item.options?.length))
    );
  }

  function cycle(item: MenuEntry, direction: number) {
    if (!ownsArrows(item)) {
      if (direction > 0) activate(item);
      else back();
      return;
    }
    if (item.kind === "slider") {
      changeSlider(item, stepSlider(item, drafts[key(item)], direction));
      return;
    }
    if (
      !state.visible ||
      closing() ||
      confirmation() ||
      pending() ||
      item.disabled ||
      item.kind !== "select" ||
      item.display === "list" ||
      !item.options?.length
    )
      return;
    play("cycle");
    const value = selectedOptionValue(item, drafts[key(item)]);
    const index = item.options.findIndex((option) => option.value === value);
    const next =
      index < 0
        ? direction > 0
          ? 0
          : item.options.length - 1
        : (index + direction + item.options.length) % item.options.length;
    const nextValue = item.options[next]!.value;
    setDrafts((draft) => {
      draft[key(item)] = nextValue;
    });
    // Only an explicitly changed selection applies; snapshots never dispatch.
    if (nextValue !== value && (item.apply === "change" || item.apply === "both"))
      submit(item, "change", nextValue);
  }

  async function execute(target: CapturedAction) {
    if (pending() || closing() || !validAction(target)) return;
    const actionKey = JSON.stringify([target.request.menuId, target.request.itemId]);
    setPending(actionKey);
    // Hoisted: the `typeof` narrowing above does not survive into the draft
    // callback, which is a separate closure the checker re-widens inside.
    const toggleValue = target.request.value;
    if (target.kind === "toggle" && typeof toggleValue === "boolean")
      setToggleDrafts((draft) => {
        draft[actionKey] = toggleValue;
      });
    const result = await request("action", target.request);
    if (disposed) return;
    const stillCurrent = Boolean(validAction(target));
    setPending(undefined);
    if (result.snapshot) applySnapshot(result.snapshot);
    const applied = !(result.menus && stillCurrent && !updateMenus(result.menus));
    // Released only once the authoritative value is in the store, so the row never
    // flashes the old checkmark on its way to the new one.
    setToggleDrafts((draft) => {
      draft[actionKey] = undefined;
    });
    if (!applied) {
      notify("Unable to apply menu update.", true);
      return;
    }
    if (target.event === "change")
      setDrafts((draft) => {
        draft[actionKey] = undefined;
      });
    if (result.ok) {
      setDrafts((draft) => {
        draft[actionKey] = undefined;
      });
      // The response snapshot is authoritative: never invent a detail page, or
      // reopen one the player backed out of while the request was pending.
      const currentItem = menu()?.items.find((item) => item.id === target.request.itemId);
      const nextMenu = result.nextMenu ?? target.nextMenu;
      if (
        stillCurrent &&
        state.visible &&
        target.epoch === epoch() &&
        menuId() === target.request.menuId &&
        currentItem &&
        !currentItem.disabled &&
        (result.nextMenu || currentItem.nextMenu === target.nextMenu) &&
        nextMenu
      )
        void navigate(nextMenu);
      if (preview) notify("Preview action completed. No game state changed.");
    } else {
      notify(result.error ?? "The action was rejected.", true);
      if (
        result.nextMenu &&
        state.visible &&
        target.epoch === epoch() &&
        menuId() === target.request.menuId &&
        menu()?.contextKey === target.request.contextKey
      )
        void navigate(result.nextMenu, "back");
    }
  }

  function activate(item = selected()) {
    if (item?.disabled) {
      play("error");
      return;
    }
    if (!item || item.kind === "status" || confirmation() || pending() || closing()) return;
    play("select");
    // Picking a row ends the search, whichever input picked it. Here rather than in
    // the key handler so mouse, gamepad and keyboard cannot disagree.
    if (searchOpen()) endSearch();
    if (item.hit) {
      void openHit(item.hit);
      return;
    }
    setSelections((draft) => {
      draft[menuId()] = item.id;
    });
    if (item.kind === "submenu") {
      if (item.menu) navigate(item.menu);
      return;
    }
    const value =
      item.kind === "toggle"
        ? !item.value
        : item.kind === "slider"
          ? sliderValue(item, drafts[key(item)])
          : item.kind === "select"
            ? (item.chosenValue ?? optionValue(item, drafts[key(item)]))
            : undefined;
    if ((item.kind === "select" || item.kind === "slider") && item.apply === "change") return;
    submit(item, "activate", value);
  }

  // A hit is opened, never actioned: the row it names is not on this page, and
  // validAction pins every request to the page on screen. Navigating also teaches
  // the tree rather than replacing it -- the player ends up where the option lives.
  async function openHit(hit: SearchHit) {
    await navigate(hit.menuId);
    // The query does not travel: the player arrives on the real page with the row
    // they chose under the cursor, not on one still filtered.
    if (disposed || menuId() !== hit.menuId) return;
    const row = untrack(items).find((entry) => entry.canonicalId === hit.itemId);
    if (row)
      setSelections((draft) => {
        draft[hit.menuId] = row.id;
      });
  }

  function submit(item: MenuEntry, event: CapturedAction["event"], value?: ActionRequest["value"]) {
    const target: CapturedAction = {
      request: {
        menuId: menuId(),
        itemId: item.canonicalId,
        ...(item.apply === "both" ? { event } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(menu()?.contextKey !== undefined ? { contextKey: menu()!.contextKey } : {}),
      },
      kind: item.kind,
      apply: item.apply,
      event,
      nextMenu: item.nextMenu,
      confirm: item.confirm,
      label: item.label,
      context: context(),
      epoch: epoch(),
    };
    if (item.confirm) {
      setConfirmChoice(false);
      setConfirmation(target);
      return;
    }
    void execute(target);
  }

  function confirm() {
    const item = confirmedItem();
    setConfirmation(undefined);
    panel?.focus();
    if (item) void execute(item);
  }

  // The query and the box go away together, and the effect below releases the
  // game's keyboard grab, so every exit leaves the same state behind.
  function endSearch() {
    setQuery("");
    setSearchOpen(false);
    search?.blur();
    panel?.focus();
  }

  function navigateCommand(command: NavigationCommand) {
    // A command arriving while the pause menu is up belongs to the pause menu.
    // Searching is not such a state: the filter narrows the page the player is
    // standing on, and standing on a page means navigating it.
    if (!shown()) return;
    if (confirmation()) {
      if (command === "back") back();
      else if (
        command === "left" ||
        command === "right" ||
        command === "up" ||
        command === "down"
      ) {
        setConfirmChoice((value) => !value);
        dialog?.querySelectorAll<HTMLButtonElement>("button")[confirmChoice() ? 1 : 0]?.focus();
      } else if (command === "accept") {
        if (confirmChoice()) confirm();
        else back();
      }
      return;
    }
    if (command === "jump" || command === "delete") {
      const instruction = menu()?.instructions?.find((entry) => entry.control === command);
      const item = menu()?.items.find(
        (entry) => entry.id === instruction?.itemId && entry.hidden && !entry.disabled
      );
      if (!item || !instruction || pending() || closing()) return;
      const value = instruction.valueFrom === "selection" ? selected()?.chosenValue : undefined;
      submit({ ...item, canonicalId: item.id }, "activate", value);
      return;
    }
    if (command === "back") {
      back();
      return;
    }
    if (command === "accept") {
      activate();
      return;
    }
    if (command === "up" || command === "down") {
      move(command === "down" ? 1 : -1);
      return;
    }
    const item = selected();
    if (item) cycle(item, command === "right" ? 1 : -1);
  }

  // The production validator, so the report cannot disagree with what the menu
  // would actually accept.
  let selftestFindings: { error: string }[] = [];
  function selftestMessage(data: { menu?: unknown; done: boolean }) {
    if (data.menu !== undefined) {
      if (!normalizeSnapshot({ version: 1, visible: false, menus: [data.menu] })) {
        selftestFindings.push({ error: snapshotError({ menus: [data.menu] }) });
      }
      return;
    }
    const results = selftestFindings;
    selftestFindings = [];
    void request("selftest", { results });
  }

  function runtimeMessage(message: NuiMessage) {
    if (message.action === "menu:snapshot") applySnapshot(message.data);
    else if (message.action === "menu:selftest") selftestMessage(message.data);
    else if (message.action === "menu:navigate") navigateCommand(message.data);
    else if (message.action === "menu:input") {
      setTextEditing(message.data);
      if (message.data) openSearch();
      else endSearch();
    } else receive(message);
  }

  /*
   * Escape is NOT in here. It is a registered layer; see `createEscapeLayer`
   * below.
   *
   * This handler had two Escape branches — one for the confirmation, one for the
   * page — and no `defaultPrevented` check. That matters specifically here,
   * because `MarketplaceBrowser` mounts a REGISTERED layer beside this host, so
   * a press the registry consumed still arrived and still ran `back()`: one
   * press, two dismissals.
   *
   * Adding `if (event.defaultPrevented) return` would NOT have fixed it, and
   * that is worth writing down because it is the obvious fix. Both this listener
   * and the registry's deciding listener are bubble-phase on `window`, and
   * within one target and phase the order is REGISTRATION order. This one is
   * added in `onSettled` at app start; the registry attaches lazily on its first
   * `add()`, which is when the browser mounts — strictly later. The registry's
   * capture handler runs first but only SAMPLES; the `preventDefault()` happens
   * in its bubble handler, after this one. So the guard would have read `false`
   * every time: a check that can never fire, which is worse than no check.
   *
   * The guard below is still here, for anything that does prevent in capture.
   */
  function onKey(event: KeyboardEvent) {
    if (!shown() || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // The one key the field never sees: it is how the player gets back out, and in
    // game it is also the key the game bound.
    if (searchOpen() && (event.key === "F3" || event.key === "Tab")) {
      event.preventDefault();
      endSearch();
      return;
    }
    if (confirmation()) {
      if (event.key === "Tab") {
        const buttons = dialog?.querySelectorAll<HTMLButtonElement>("button");
        if (buttons?.length) {
          event.preventDefault();
          const next = document.activeElement === buttons[0] ? buttons[1] : buttons[0];
          next?.focus();
        }
      }
      return;
    }
    if (event.key === "F1") {
      event.preventDefault();
      void close();
      return;
    }
    // The field holds DOM focus because that is the only way typed characters reach
    // it in game, but holding focus is not owning the keyboard -- only actual text
    // falls through. Left/right included: on a selector row they change the value,
    // which is worth more than moving a caret inside a filter query.
    if (
      event.target === search &&
      !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)
    )
      return;
    if (!inGame && (event.key === "/" || event.key === "F3")) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (!inGame && (event.key === " " || event.key === "Delete") && event.target !== search) {
      event.preventDefault();
      if (!event.repeat) navigateCommand(event.key === " " ? "jump" : "delete");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      // Not while searching: the next character has to land in the field.
      if (!searchOpen()) panel.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const item = selected();
      if (item) cycle(item, event.key === "ArrowRight" ? 1 : -1);
    } else if (
      event.key === "Enter" &&
      (event.target === panel || event.target === search || event.target === document.body)
    ) {
      event.preventDefault();
      if (!event.repeat) activate();
    } else if (event.key === "Backspace" && event.target !== search) {
      event.preventDefault();
      back();
    }
  }

  // In game the box can only receive characters while the game has handed CEF its
  // keyboard, so the box being open and the grab being held are one state. Held
  // here rather than at each of the five exits, where only the ones that remembered
  // to call back into the game released it.
  createEffect(searchOpen, (open) => {
    if (!inGame || open === textEditing()) return;
    void request("input", { active: open });
  });
  createEffect(
    () => state.menus,
    (menus) => {
      for (const entry of menus) parents.set(entry.id, entry.parent);
    }
  );
  // Only the page vanishing matters: tracking the fallback lookup too would make
  // this effect re-run its own setMenuId write.
  createEffect(menu, (current) => {
    // No `untrack` needed any more: the apply half does not track at all, which
    // is exactly what the comment above was asking `on()` for.
    if (current) return;
    const fallback = nearestAncestor(menuId(), parents, state.menus);
    setConfirmation(undefined);
    if (fallback) showMenu(fallback);
  });
  let highlighted = "";
  createEffect(
    () => {
      const item = selected();
      // A search hit is not a row on this page, so its synthetic id would report a
      // highlight on an item the game has never heard of.
      const data =
        item && !item.hit
          ? {
              menuId: menuId(),
              itemId: item.canonicalId,
              value:
                item.chosenValue ??
                (item.kind === "select" ? selectedOptionValue(item, drafts[key(item)]) : undefined),
              contextKey: menu()?.contextKey,
            }
          : undefined;
      // Blank while hidden as well as closed: nothing is highlighted behind the pause
      // menu, and blanking makes the identical highlight a change again on restore,
      // which is how the game's marker comes back with the panel.
      return { data, signature: shown() && data ? JSON.stringify(data) : "" };
    },
    ({ data, signature }) => {
      if (signature !== highlighted) {
        highlighted = signature;
        if (signature && data) void request("highlight", data);
      }
    }
  );
  createEffect(
    () => {
      // The same index space selectedId() reads it back in: selectable rows, status
      // headings excluded. selectedIndex() counts into items(), which includes the
      // headings, so storing that put the restored cursor one row low per heading.
      const id = selectedId();
      return { id, page: menuId(), index: selectable().findIndex((item) => item.id === id) };
    },
    ({ id, page, index }) => {
      if (index >= 0) positions.set(page, index);
      // The guard reads the store path this effect writes. It needs no `untrack`
      // now: apply does not track, so reading it here subscribes to nothing.
      if (selections[page] !== id)
        setSelections((draft) => {
          draft[page] = id;
        });
    }
  );
  // Visibility only: menuId() and state.menus are read inside and setMenuId is
  // called, so tracking them would run the whole reset twice on close.
  createEffect(
    () => state.visible,
    (visible) => {
      if (visible) queueMicrotask(() => panel?.focus());
      else {
        setEpoch((value) => value + 1);
        setTextEditing(false);
        setConfirmation(undefined);
        setNotice(undefined);
        // Closing resets the game to the main menu, so the page resets too, and an
        // uncommitted draft must not reappear as the live value on the next open.
        setQuery("");
        setSearchOpen(false);
        setDrafts(reconcile({}));
        setToggleDrafts(reconcile({}));
        if (menuId() !== "main" && state.menus.some((entry) => entry.id === "main"))
          setMenuId("main");
      }
    }
  );
  // A new banner is unmeasured; keeping the previous ink would paint the title
  // against the wrong one until the replacement loads.
  createEffect(banner, () => setBannerInk(undefined));
  // The exact inverse of hiding: no epoch bump, no draft reset, no page reset.
  // Only focus has to go back, to whichever of the two the player was in.
  createEffect(
    () => state.hidden,
    (hidden) => {
      if (hidden || !state.visible) return;
      queueMicrotask(() => {
        if (confirmedItem()) dialog?.querySelector<HTMLButtonElement>("button")?.focus();
        else panel?.focus();
      });
    },
    // `defer` is an option on the two-argument form now, rather than a third
    // argument to `on()`. Same meaning: skip the first run.
    { defer: true }
  );
  createEffect(
    () => ({ pending: confirmation(), confirmed: confirmedItem() }),
    ({ pending, confirmed }) => {
      if (pending && !confirmed) setConfirmation(undefined);
      // The shade is absolute inside the panel, so on a short viewport it covers the
      // top of the content rather than what is in view. Returning to the top pins the
      // two together, and is-blocked holds them there while the dialog is up.
      if (confirmed && panel) panel.scrollTop = 0;
      if (confirmed)
        queueMicrotask(() => dialog?.querySelector<HTMLButtonElement>("button")?.focus());
    }
  );

  // A rejected push means this copy of the menu is stale, and a stale page can no
  // longer be navigated or exited.
  let resyncing = false;
  async function refreshFromGame() {
    if (resyncing) return;
    resyncing = true;
    try {
      const result = await request("resync");
      if (!disposed && result.snapshot) applySnapshot(result.snapshot);
      else if (!disposed && !result.ok)
        notify(result.error ?? "Unable to resynchronize the menu.", true);
    } finally {
      resyncing = false;
    }
  }
  async function resync(reason: string) {
    notify(reason, true);
    await refreshFromGame();
  }

  onSettled(() => {
    const unlisten = listen(runtimeMessage, (reason) => void resync(reason));
    window.addEventListener("keydown", onKey);
    /*
     * Escape, as the one arbitrated layer rather than two branches of the raw
     * handler above.
     *
     * `back()` already distinguishes the three things Escape can mean here — it
     * dismisses the confirmation, else leaves search taking the query with it,
     * else walks up the page stack and finally closes — so there is nothing for
     * `onInternal` to split out. Depth 0: this is the HOST, and the marketplace
     * browser mounted inside it registers at depth 1 and wins while it is open,
     * which is the whole arrangement the registry exists to express.
     *
     * `blocked` carries the modifier rule the raw handler had, and it is
     * `blocked` rather than `active` on purpose: a `Ctrl`-Escape is "not mine",
     * so the layer below should get a chance at it, not "mine, do nothing".
     */
    const disposeEscape = createEscapeLayer({
      label: "menu",
      depth: 0,
      active: () => shown(),
      blocked: (event) => Boolean(event.ctrlKey || event.metaKey || event.altKey),
      onEscape: back,
    });
    void request("ready").then((result) => {
      if (disposed) return;
      if (result.snapshot) applySnapshot(result.snapshot);
      if (!result.ok) notify(result.error ?? "Unable to initialize the menu.", true);
    });
    // Solid 2's `onSettled` takes its teardown as the RETURNED function rather
    // than through `onCleanup` inside the body.
    return () => {
      disposed = true;
      unlisten();
      window.removeEventListener("keydown", onKey);
      disposeEscape();
      window.clearTimeout(noticeTimer);
      window.clearTimeout(navigationTimer);
    };
  });

  return (
    // Always a concrete skin, resolved per page through the same branding layers as
    // the accent. This attribute is all the markup knows about skins.
    <div ref={root} class="tlib-menu" data-skin={skinFor(state.branding, menuId())}>
      <Show when={preview}>
        <div class="preview-world" aria-hidden="true">
          <div class="preview-grid" />
          <span>LOS SANTOS / DEVELOPMENT ENVIRONMENT</span>
        </div>
        <div class="preview-badge">
          <span class="status-dot" /> BROWSER PREVIEW{" "}
          <button
            type="button"
            onClick={() => receive({ action: "menu:visible", data: !state.visible })}
          >
            {state.visible ? "Hide menu" : "Open menu"}
          </button>
        </div>
      </Show>
      <Show when={state.visible}>
        {/* aria-hidden rather than unmounted: the panel keeps its scroll offset,
            focus target and drafts, and a screen reader still stops reading it. */}
        <section
          ref={panel}
          class={[
            "menu-panel",
            {
              "is-blocked": Boolean(confirmedItem()),
              "is-hidden": state.hidden,
              "has-accent": Boolean(accent()),
              [`align-${state.align}`]: true,
            },
          ]}
          style={brandStyle()}
          aria-hidden={state.hidden ? "true" : undefined}
          tabindex="-1"
          aria-label={menu()?.title ?? "Menu"}
          aria-busy={pending() ? "true" : "false"}
        >
          <header class="menu-brand">
            {/* Decorative: the word beside it is the accessible name. */}
            <Show when={banner()}>
              {(url) => (
                <img
                  class="brand-banner"
                  src={url()}
                  alt=""
                  aria-hidden="true"
                  onLoad={(event) => setBannerInk(sampleInk(event.currentTarget))}
                  onError={() => setFailedBanner(url())}
                />
              )}
            </Show>
            <span class={["brand-word", { "source-title": Boolean(menu()?.subtitle) }]}>
              <FormattedText
                text={menu()?.subtitle ? menu()?.title : (state.menus[0]?.title ?? "Menu")}
              />
            </span>
            {/* The game gives NUI no cursor, so mouse affordances exist only in
                the browser preview. */}
            <Show when={!inGame}>
              <button
                class="close-button"
                type="button"
                aria-label={t("Close menu")}
                disabled={closing()}
                onClick={() => void close()}
              >
                <X />
              </button>
            </Show>
          </header>
          <div class="menu-heading">
            <Show when={!inGame}>
              <button type="button" class="back-button" onClick={back} aria-label={t("Back")}>
                <ChevronLeft />
              </button>
            </Show>
            <h1>
              <FormattedText text={menu()?.subtitle ?? menu()?.title ?? "No available menus"} />
            </h1>
            <span
              class="item-count"
              aria-label={t("Option {{ index }} of {{ total }}", {
                index: Math.max(0, selectedIndex() + 1),
                total: items().length,
              })}
            >
              {Math.max(0, selectedIndex() + 1)} / {items().length}
            </span>
          </div>
          {/* Only appears once a page has taken longer than 120ms to open. */}
          <Show when={navigating()}>
            <div class="loading-bar" role="status" aria-label={t("Opening menu")} />
          </Show>
          <Show when={searchOpen()}>
            <div class="search-wrap">
              <input
                ref={search}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("Filter this menu…")}
                aria-label={t("Filter this menu")}
                maxlength="128"
              />
              <kbd>{inGame ? "F3" : "Esc"}</kbd>
            </div>
          </Show>
          <div
            class="menu-items"
            role="group"
            aria-label={plainText(t(menu()?.title ?? "Menu items"))}
          >
            {/* Keyed by reference: rows read through to the store, so identity only
                changes when the page's structure does and scrolling moves nodes
                rather than re-running every binding. pending is compared per row so
                one slow spawn does not grey out the whole page. */}
            <For each={visibleItems()}>
              {(item) => (
                <MenuRow
                  item={item}
                  active={isSelected(item.id)}
                  pending={pending() === key(item)}
                  toggleValue={item.kind === "toggle" ? toggleDrafts[key(item)] : undefined}
                  sliderValue={
                    item.kind === "slider" ? sliderValue(item, drafts[key(item)]) : undefined
                  }
                  onSliderInput={(value) => changeSlider(item, value)}
                  optionIcon={
                    item.kind === "select" && item.display !== "list"
                      ? item.options?.find(
                          (option) => option.value === selectedOptionValue(item, drafts[key(item)])
                        )?.rightIcon
                      : undefined
                  }
                  optionLabel={
                    item.options?.find(
                      (option) => option.value === selectedOptionValue(item, drafts[key(item)])
                    )?.label ?? (item.disabled ? "Unavailable" : "Choose…")
                  }
                  onSelect={() =>
                    setSelections((draft) => {
                      draft[menuId()] = item.id;
                    })
                  }
                  onActivate={() => activate(item)}
                  onCycle={(direction) => cycle(item, direction)}
                />
              )}
            </For>
            <Show when={!items().length}>
              <div class="empty-state">
                <SearchX aria-hidden="true" />
                {query()
                  ? t("No matching options.")
                  : t("No options available. Check your ACE permissions.")}
              </div>
            </Show>
          </div>
          <Show when={items().length > VISIBLE_ROWS}>
            <div
              class="scroll-cue"
              aria-label={t("Showing {{ from }}–{{ to }} of {{ total }}", {
                from: start() + 1,
                to: Math.min(start() + VISIBLE_ROWS, items().length),
                total: items().length,
              })}
            >
              <ChevronUp aria-hidden="true" />
              <ChevronDown aria-hidden="true" />
            </div>
          </Show>
          <Show when={!rowPanel() && (selected()?.weaponStats ?? menu()?.weaponStats)}>
            {(stats) => (
              <div
                class="vehicle-stats weapon-stats"
                role="group"
                aria-label={t("Weapon performance")}
              >
                {/* Spelled out rather than capitalized from the key: a runtime-built
                string is invisible to t() and to anything scanning for strings. */}
                <For each={["damage", "speed", "accuracy", "range"] as const}>
                  {(name) => {
                    const label = () =>
                      t(
                        name === "damage"
                          ? "Damage"
                          : name === "speed"
                            ? "Speed"
                            : name === "accuracy"
                              ? "Accuracy"
                              : "Range"
                      );
                    const fraction = () => Math.max(0, Math.min(1, stats()[name] ?? 0));
                    return (
                      <div class="vehicle-stat">
                        <span>{label()}</span>
                        <div
                          class="stat-bar"
                          role="meter"
                          aria-valuemin="0"
                          aria-valuemax="1"
                          aria-valuenow={stats()[name]}
                          aria-label={label()}
                        >
                          <div class="stat-fill" style={{ width: `${fraction() * 100}%` }} />
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
          <Show when={!rowPanel() && selected()?.vehicleStats}>
            {(stats) => (
              <div class="vehicle-stats" role="group" aria-label={t("Vehicle performance")}>
                {/* The accessible name is the row's own word: the protocol key would be
                read out in English next to a translated label. */}
                <For each={["speed", "acceleration", "braking", "traction"] as const}>
                  {(name) => {
                    const label = () =>
                      t(
                        name === "speed"
                          ? "Speed"
                          : name === "acceleration"
                            ? "Acceleration"
                            : name === "braking"
                              ? "Braking"
                              : "Traction"
                      );
                    const fraction = () => Math.max(0, Math.min(1, stats()[name] ?? 0));
                    return (
                      <div class="vehicle-stat">
                        <span>{label()}</span>
                        <div
                          class="stat-bar"
                          role="meter"
                          aria-valuemin="0"
                          aria-valuemax="1"
                          aria-valuenow={stats()[name]}
                          aria-label={label()}
                        >
                          <div class="stat-fill" style={{ width: `${fraction() * 100}%` }} />
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
          <div class="description-panel">
            <p>
              <FormattedText
                text={
                  selected()?.description ?? menu()?.description ?? "Select an option to continue."
                }
              />
            </p>
          </div>
          <Show when={rowPanel()}>
            {(data) => (
              <div
                class="swatch-panel"
                role="group"
                aria-label={data().kind === "opacity" ? t("Opacity") : t("Color")}
              >
                <Show
                  when={
                    data().kind === "opacity"
                      ? (data() as { kind: "opacity"; value: number })
                      : undefined
                  }
                >
                  {(opacity) => (
                    <div class="opacity-bar">
                      <span>{t("Opacity")}</span>
                      <div
                        class="stat-bar"
                        role="meter"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={opacity().value}
                        aria-label={t("Opacity")}
                      >
                        <div
                          class="stat-fill"
                          style={{ width: `${Math.max(0, Math.min(100, opacity().value))}%` }}
                        />
                      </div>
                      <span class="opacity-value">{opacity().value}%</span>
                    </div>
                  )}
                </Show>
                <Show
                  when={
                    data().kind === "color"
                      ? (data() as {
                          kind: "color";
                          swatches: string[];
                          index: number;
                          total: number;
                        })
                      : undefined
                  }
                >
                  {(colors) => (
                    <div
                      class="swatches"
                      aria-label={t("Color {{ index }} of {{ total }}", {
                        index: Math.min(colors().index + 1, colors().total),
                        total: colors().total,
                      })}
                    >
                      <For each={colors().swatches}>
                        {(colour, index) => (
                          <span
                            class={["swatch", { "is-current": index() === colors().index }]}
                            style={{ background: `#${colour}` }}
                            aria-hidden="true"
                          />
                        )}
                      </For>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(message) => (
              <div
                class={["notice", { "notice-error": message().error }]}
                role={message().error ? "alert" : "status"}
              >
                <Show when={message().error} fallback={<Info aria-hidden="true" />}>
                  <CircleAlert aria-hidden="true" />
                </Show>
                {t(message().text)}
              </div>
            )}
          </Show>
          {/* The game's rejection strings arrive through notify() and take the same
              lookup, so a translated client never gets a half-English notice. */}
          <footer class="menu-footer">
            <span>
              <kbd>↑↓</kbd> {t("Navigate")}
            </span>
            <span>
              <kbd>↵</kbd> {t("Select")}
            </span>
            <span>
              <kbd>Backspace</kbd> {t("Back")}
            </span>
            <Show
              when={!inGame}
              fallback={
                <span>
                  <kbd>F3</kbd> {t("Search")}
                </span>
              }
            >
              <button
                type="button"
                onClick={openSearch}
                aria-label={t("Search this menu")}
                aria-expanded={searchOpen() ? "true" : "false"}
              >
                <Search aria-hidden="true" /> {t("Search")}
              </button>
            </Show>
            <For
              each={
                inGame
                  ? []
                  : (menu()?.instructions?.filter((instruction) =>
                      menu()?.items.some((item) => item.id === instruction.itemId && !item.disabled)
                    ) ?? [])
              }
            >
              {(instruction) => (
                <span>
                  <kbd>{instruction.control === "jump" ? "Space" : "Delete"}</kbd>{" "}
                  <FormattedText text={instruction.label} />
                </span>
              )}
            </For>
            <Show when={pending()}>
              <span class="pending-dot" aria-label={t("Waiting for game")} />
            </Show>
          </footer>
          <Show when={confirmedItem()}>
            {(item) => (
              <div class="confirmation-shade">
                <div
                  ref={dialog}
                  class="confirmation"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="confirm-title"
                  aria-describedby="confirm-description"
                >
                  <div class="eyebrow">
                    <ShieldAlert aria-hidden="true" />
                    {t("CONFIRM ACTION")}
                  </div>
                  <h2 id="confirm-title">
                    <FormattedText text={item().label} />
                  </h2>
                  <p id="confirm-description">
                    <FormattedText text={item().confirm} />
                  </p>
                  {/* ⚠️ AFFIRMATIVE LEFT, deliberately. The source order is the
                      visual order and the Tab order both; the reasoning and the
                      count behind it are in `layout/LayoutEditor.tsx`. */}
                  <div class="flex gap-2 mt-5">
                    <button type="button" class="dialog-confirm" onClick={confirm}>
                      <Check aria-hidden="true" />
                      {t("Confirm")}
                    </button>
                    <button type="button" class="dialog-cancel" onClick={back}>
                      <X aria-hidden="true" />
                      {t("Cancel")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </section>
      </Show>
    </div>
  );
}
