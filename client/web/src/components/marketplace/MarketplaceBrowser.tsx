/**
 * The marketplace BODY: toolbar, tabs, grid, pagination, preview, and
 * install/uninstall/inspect. Two hosts mount it — `MarketplacePanel.tsx` as a
 * modal, `Dialog.tsx` inside a dialog tab — so this component must never
 * render its own backdrop/focus trap; `onEscape` hands the key back to
 * whichever host owns dismissal.
 *
 * Browse/preview/install go through Lua, not a direct fetch: CEF's origin is
 * `cfx-nui-tLib` and the marketplace host sends no Access-Control-Allow-Origin
 * (see `@tlib/shared/marketplace/ui`'s `browse.ts` and `client/cl_marketplace.lua`).
 */

import type { JSX } from "@solidjs/web";
import { createEscapeLayer } from "@tlib/shared/escape-layer";
import { localInstallKind } from "@tlib/shared/marketplace/local-name";
import {
  browseMarketplace,
  ErrorPane,
  type InspectionRequest,
  type InspectionState,
  type InstalledSound,
  InstalledTab,
  type InstallState,
  ItemCard,
  inspectableIdentity,
  isBuiltin,
  likeMarketplaceItem,
  type MarketplaceItem,
  matchesInspectionReply,
  type OpenData,
  PreviewOverlay,
  patchInstalledNames,
  summarizeInspection,
} from "@tlib/shared/marketplace/ui";
// See the note on the Lucide imports in `../MarketplacePanel.tsx`: the package
// form in an app, `~icons/lucide` in `shared/ts/**`, and nothing mixed.
import IconLoaderCircle from "lucide-solid/icons/loader-circle";
import IconSearch from "lucide-solid/icons/search";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import { NuiButton } from "../ui/nui-field";
import { MarketplaceSort } from "./MarketplaceSort";

let inspectionSequence = 0;

export interface MarketplaceBrowserProps {
  /** The open payload. `null` means nothing has been provided yet. */
  data: OpenData | null;
  /**
   * Whether this mount is visible and allowed to issue requests. Going false
   * aborts anything in flight; going true re-applies `data` from scratch.
   * Neither first-party host actually passes `false` while mounted — both tie
   * `active` to the same condition that mounts the component — so this path
   * (hide without unmount, to avoid losing an install result) is untested.
   */
  active: boolean;
  /** Chrome rendered at the start of the header row (the modal's title). */
  header?: JSX.Element;
  /** Chrome rendered at the end of the header row (the modal's close button). */
  headerActions?: JSX.Element;
  /** Escape pressed with no preview open. A preview is always dismissed here first. */
  onEscape?: () => void;
  /** Extra classes on the root, e.g. `mp-embed`. */
  class?: string;
}

export function MarketplaceBrowser(props: MarketplaceBrowserProps) {
  const [tab, setTab] = createSignal<"uis" | "sounds" | "installed">("uis");
  const [resourceFilter, setResourceFilter] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal<string>("");
  const [search, setSearch] = createSignal("");
  const [items, setItems] = createSignal<MarketplaceItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  const [installStates, setInstallStates] = createSignal<Record<string, InstallState>>({});
  const [installedLayouts, setInstalledLayouts] = createSignal<string[]>([]);
  const [installedSounds, setInstalledSounds] = createSignal<InstalledSound[]>([]);
  const [sort, setSort] = createSignal<"downloads" | "created_at">("downloads");
  const [installedMarketplaceItems, setInstalledMarketplaceItems] = createSignal<MarketplaceItem[]>(
    []
  );
  const [installedLoading, setInstalledLoading] = createSignal(false);
  const [previewItem, setPreviewItem] = createSignal<MarketplaceItem | null>(null);
  const [previewFn, setPreviewFn] = createSignal<string | null>(null);
  const [previewState, setPreviewState] = createSignal<Record<string, unknown> | null>(null);
  const [panelPreviewUrl, setPanelPreviewUrl] = createSignal<string | null>(null);

  /**
   * Slugs with a like round trip in flight. Keyed per-slug rather than one
   * boolean, since a single flag would disable every heart on the page while
   * only one card's request was outstanding.
   */
  const [likePending, setLikePending] = createSignal<Record<string, true>>({});

  const [inspection, setInspection] = createSignal<InspectionState | null>(null);
  let inspectionTimeout: number | undefined;
  function clearInspection() {
    window.clearTimeout(inspectionTimeout);
    inspectionTimeout = undefined;
    setInspection(null);
  }

  function inspectInstallation(type: "ui" | "sound", slug: string, name: string) {
    const resource = resourceFilter();
    if (
      !props.active ||
      tab() !== "installed" ||
      inspection()?.state === "loading" ||
      !inspectableIdentity(resource, slug)
    )
      return;
    clearInspection();
    const request: InspectionRequest = {
      resource: resource!,
      type,
      slug,
      requestId: `mp-${Date.now().toString(36)}-${++inspectionSequence}`,
    };
    setInspection({ state: "loading", request, name });
    const fail = () => {
      const active = inspection();
      if (active?.request.requestId === request.requestId && active.state === "loading") {
        window.clearTimeout(inspectionTimeout);
        setInspection({ state: "error", request, name });
      }
    };
    inspectionTimeout = window.setTimeout(fail, 15000);
    void fetchNui("marketplaceInspect", request).then((ack) => {
      if (ack === null) fail();
    });
  }

  function inspectionBlocks(type: "ui" | "sound", slug: string) {
    const active = inspection();
    return (
      active?.request.type === type &&
      active.request.slug === slug &&
      (active.state !== "ready" || active.summary.managementBlocked)
    );
  }

  let searchDebounce: number | null = null;
  let browseRequest = 0;
  let installedRequest = 0;
  let browseAbort: AbortController | undefined;
  const pageSize = 50;
  const [pageOffset, setPageOffset] = createSignal(0);
  const [hasNextPage, setHasNextPage] = createSignal(false);

  function invalidateRequests() {
    clearInspection();
    ++browseRequest;
    ++installedRequest;
    browseAbort?.abort();
    if (searchDebounce) window.clearTimeout(searchDebounce);
    searchDebounce = null;
  }

  function setInstallState(slug: string, next: InstallState) {
    setInstallStates((prev) => ({ ...prev, [slug]: next }));
  }

  /**
   * `forTab` exists because a Solid 2 signal write isn't readable through the
   * signal in the same tick. Re-reading `tab()` right after `setTab(next)` got
   * the tab just left, so every browse fetched the wrong type — invisible in
   * tRadio (50 items under both types) but not tRadar (5 and 0).
   */
  async function fetchItems(
    offset = 0,
    forTab?: "uis" | "sounds" | "installed",
    forSort?: "downloads" | "created_at"
  ) {
    const base = baseUrl();
    if (!base || !props.active) {
      // A tab switch or reopen can bail here with `loading` already true;
      // without this the grid sits on "Loading items…" with nothing in flight.
      setLoading(false);
      return;
    }
    const request = ++browseRequest;
    browseAbort?.abort();
    const controller = new AbortController();
    browseAbort = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setPageOffset(offset);
    const shownAt = Date.now();
    setLoading(true);
    setError(null);
    try {
      const activeTab = forTab ?? tab();
      const page = await browseMarketplace(
        {
          type: activeTab === "uis" ? "ui" : activeTab === "sounds" ? "sound" : undefined,
          resource: resourceFilter() ?? undefined,
          search: search() || undefined,
          sort: forSort ?? sort(),
          limit: pageSize,
          cursor: offset,
        },
        controller.signal
      );
      if (request !== browseRequest) return;
      setItems(page.items);
      // Server-reported; inferring it from a full page falsely claimed a next
      // page whenever the catalogue was an exact multiple of the page size.
      setHasNextPage(page.hasMore);
    } catch (e) {
      if (request !== browseRequest) return;
      setError(
        controller.signal.aborted
          ? "Marketplace request timed out"
          : e instanceof Error
            ? e.message
            : String(e)
      );
      setItems([]);
      setHasNextPage(false);
    } finally {
      window.clearTimeout(timeout);
      // Minimum visible time for the spinner, not a delay before showing it —
      // one that appears and vanishes inside ~100ms reads as a glitch. Data is
      // already applied; only the indicator waits.
      const held = Math.max(0, 300 - (Date.now() - shownAt));
      const settle = () => {
        if (request === browseRequest) setLoading(false);
      };
      if (held === 0) settle();
      else window.setTimeout(settle, held);
    }
  }

  /**
   * The whole catalogue for one type, paged at `limit: 100` (the server's own
   * clamp) — a single request used to be the whole implementation, so past the
   * hundredth item an installed layout got no catalogue entry and the
   * Installed tab silently showed its bare directory name.
   *
   * Sequential within a type, parallel across the two types, to stay under
   * `READ_MAX_IN_FLIGHT = 3` in `server/sv_marketplace.lua`. `MAX_PAGES` bounds
   * outbound requests in case a cursor fails to advance. A mid-sequence
   * failure keeps the pages that already arrived rather than discarding them.
   */
  async function catalogueForType(
    type: "ui" | "sound",
    resource: string | undefined,
    request: number
  ): Promise<MarketplaceItem[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;
    const items: MarketplaceItem[] = [];
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      let result: Awaited<ReturnType<typeof browseMarketplace>>;
      try {
        result = await browseMarketplace({ type, resource, limit: PAGE_SIZE, cursor });
      } catch {
        break;
      }
      if (request !== installedRequest) break;
      items.push(...result.items);
      if (!result.hasMore || result.items.length === 0) break;
      const next = result.nextCursor > cursor ? result.nextCursor : cursor + result.items.length;
      if (next <= cursor) break;
      cursor = next;
    }
    return items;
  }

  async function fetchInstalledItems() {
    const base = baseUrl();
    if (!base) return;
    const request = ++installedRequest;
    setInstalledLoading(true);
    try {
      const resource = resourceFilter() ?? undefined;
      // Two sequences, not one unfiltered one: a `ui` and a `sound` may share a
      // slug, and the per-request cap is per type — merging would halve what
      // either can carry in a page.
      const pages = await Promise.all(
        (["ui", "sound"] as const).map((type) => catalogueForType(type, resource, request))
      );
      if (request === installedRequest) setInstalledMarketplaceItems(pages.flat());
      // No `catch`: `catalogueForType` already handles its own failure.
    } finally {
      if (request === installedRequest) setInstalledLoading(false);
    }
  }

  function applyOpenData(data: OpenData) {
    invalidateRequests();
    setBaseUrl(data.baseUrl);
    setResourceFilter(data.resource ?? null);
    setSearch("");
    setOperationError(null);
    setSort("downloads");
    // `initialTab` arrives over NUI as any string (cl_marketplace.lua doesn't
    // validate it); an unrecognised value used to land in this signal and skip
    // every render branch, leaving the category buttons over nothing. Fall
    // back to "uis" rather than refusing.
    const wanted = data.initialTab;
    // Held in a local for the same reason `fetchItems` takes `forTab`: the
    // read at the end of this function can't see this write yet.
    const opening = wanted === "sounds" || wanted === "installed" ? wanted : "uis";
    setTab(opening);
    // `data` is the host's snapshot from open time; `patchInstalledNames`
    // corrects it with installs this session performed, or leaving and
    // returning to the tab offers Install for something already on disk.
    setInstalledLayouts(patchInstalledNames(data.installedLayouts ?? [], "ui"));
    const sounds = data.installedSounds ?? [];
    const soundNames = patchInstalledNames(
      sounds.map((entry) => entry.slug),
      "sound"
    );
    const bySlug = new Map(sounds.map((entry) => [entry.slug, entry]));
    setInstalledSounds(soundNames.map((slug) => bySlug.get(slug) ?? { slug, filename: slug }));
    setInstalledMarketplaceItems([]);
    setPreviewItem(null);
    setPreviewFn(data.previewFn ?? null);
    setPreviewState(data.previewState ?? null);
    setPanelPreviewUrl(data.panelPreviewUrl ?? null);
    // Without this, a like round trip still in flight when the panel is
    // re-fed would leave its slug in here, so the heart on the re-rendered
    // card came back stuck spinning until the old promise settled.
    setLikePending({});

    // Seeds sound slugs only; layout state is derived instead (see
    // `itemInstallState`). Must stay keyed by marketplace slug — it used to
    // carry layout folder names (`QRX-720`), which never matched the slug
    // lookups (`tradio-qrx-720`) and every shipped radio head offered Install
    // for something already on disk.
    const seed: Record<string, InstallState> = {};
    for (const slug of patchInstalledNames(data.installedSlugs ?? [], "sound")) {
      seed[slug] = { state: "installed" };
    }
    setInstallStates(seed);

    if (opening === "installed") void fetchInstalledItems();
    else void fetchItems(0, opening);
  }

  // `applied` is identity, not a deep compare: a fresh object off an NUI
  // message means "something changed"; the same object resent means it didn't.
  let applied: OpenData | null = null;
  // Two-argument form instead of an `untrack` wrapper: in Solid 2 only
  // `compute` tracks, so the handler writing most of this component's signals
  // can't re-trigger itself.
  createEffect(
    () => ({ data: props.data, active: props.active }),
    ({ data, active }) => {
      if (!active || !data) {
        if (applied) {
          applied = null;
          invalidateRequests();
          setPreviewItem(null);
        }
        return;
      }
      if (data === applied) return;
      applied = data;
      applyOpenData(data);
    }
  );

  onCleanup(
    onNuiEvent<unknown>("marketplaceInspectResult", (data) => {
      const active = inspection();
      if (
        !props.active ||
        tab() !== "installed" ||
        !active ||
        active.state !== "loading" ||
        !matchesInspectionReply(active.request, data)
      )
        return;
      window.clearTimeout(inspectionTimeout);
      inspectionTimeout = undefined;
      const summary = data.ok ? summarizeInspection(data.inspection, active.request) : null;
      setInspection(
        summary ? { ...active, state: "ready", summary } : { ...active, state: "error" }
      );
    })
  );

  onCleanup(
    onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string; type?: string }>(
      "marketplaceInstallResult",
      (data) => {
        if (!data || typeof data.slug !== "string" || !props.active) return;
        if (data.resource && data.resource !== resourceFilter()) return;
        clearInspection();
        // Read off the wire (`sv_marketplace.lua`'s reply always carries
        // `type`) rather than from a side-table this component used to keep.
        const type = data.type;
        if (data.ok) {
          setInstallState(data.slug, { state: "installed" });
          if (type === "ui") {
            setInstalledLayouts((prev) => (prev.includes(data.slug) ? prev : [...prev, data.slug]));
          } else if (type === "sound") {
            setInstalledSounds((prev) =>
              prev.some((s) => s.slug === data.slug)
                ? prev
                : [...prev, { slug: data.slug, filename: data.slug }]
            );
          }
        } else {
          setInstallState(data.slug, { state: "done", ok: false, error: data.error });
        }
      }
    )
  );

  onCleanup(
    onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string }>(
      "marketplaceUninstallResult",
      (data) => {
        if (!data || typeof data.slug !== "string" || !props.active) return;
        if (data.resource && data.resource !== resourceFilter()) return;
        clearInspection();
        if (data.ok) {
          setInstallState(data.slug, { state: "idle" });
          setInstalledLayouts((prev) => prev.filter((l) => l !== data.slug));
          setInstalledSounds((prev) => prev.filter((s) => s.slug !== data.slug));
        } else {
          setInstallState(data.slug, { state: "installed" });
          setOperationError(data.error ?? "Could not uninstall this item");
        }
      }
    )
  );

  function handleSearchInput(value: string) {
    invalidateRequests();
    setSearch(value.slice(0, 200));
    // Deliberately no `setLoading(true)` here: firing it on the keystroke,
    // 250ms before the debounced request even starts, replaced the grid with
    // a spinner on every character typed.
    searchDebounce = window.setTimeout(() => void fetchItems(), 250);
  }

  function handleTabSwitch(next: "uis" | "sounds" | "installed") {
    const prev = tab();
    if (next === prev) return;
    invalidateRequests();
    setPreviewItem(null);
    setTab(next);
    if (next === "installed") {
      void fetchInstalledItems();
    } else {
      void fetchItems(0, next);
    }
  }

  /**
   * This catalogue item's state: an operation in flight first, else what's on
   * disk. Layout state is derived, not seeded, because `installedLayouts` is
   * `readdir(layouts/)` (`QRX-720`) while `item.slug` is namespaced and
   * lowercased (`tradio-qrx-720`) — a seed can only hold one spelling.
   * `localInstallKind` compares both and reports which matched: `"managed"`
   * (raw slug is the install target, Delete can address it) or `"builtin"`
   * (only the prefix-stripped spelling is on disk; shipped, not removable).
   * Sounds are NOT derived — `marketplace.upsertSound` writes their installed
   * records from the catalogue slug directly, so there's no second spelling.
   */
  function itemInstallState(item: MarketplaceItem): InstallState {
    const operation = installStates()[item.slug];
    if (operation) return operation;
    if (item.type === "ui") {
      const kind = localInstallKind(item, installedLayouts());
      if (kind === "builtin") return { state: "builtin" };
      if (kind === "managed") return { state: "installed" };
    }
    return { state: "idle" };
  }

  function handleInstall(item: MarketplaceItem) {
    // Defence in depth: `canInstall` and `ItemCard`/`PreviewOverlay` already
    // block a built-in, but a reinstall writes `layouts/<raw slug>/` beside
    // the shipped directory rather than over it, so this guard must survive
    // even if a later refactor re-enables the button.
    if (isBuiltin(itemInstallState(item))) return;
    if ((item.type === "ui" || item.type === "sound") && inspectionBlocks(item.type, item.slug))
      return;
    clearInspection();
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "installing" });
    void fetchNui("marketplaceInstall", {
      type: item.type,
      slug: item.slug,
      version: item.current_version,
      resource: resourceFilter() ?? "",
    });
  }

  function handleUninstall(item: MarketplaceItem) {
    // The more important defence in depth: the uninstaller addresses
    // `<installPath>/<raw slug>` plus an ownership receipt, so a Delete on a
    // shipped built-in can only come back "not installed".
    if (isBuiltin(itemInstallState(item))) return;
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", {
      type: item.type,
      slug: item.slug,
      resource: resourceFilter() ?? "",
    });
  }

  /**
   * Toggle this player's like on one item. Deliberately no optimistic update:
   * the count and filled state are replaced only with what the server
   * answers, since the count may have moved from someone else's like, and the
   * write is idempotent (a second like answers the same count). The pending
   * flag covers the latency instead.
   */
  function handleLike(item: MarketplaceItem, next: boolean) {
    if (likePending()[item.slug]) return;
    setLikePending((prev) => ({ ...prev, [item.slug]: true }));
    setOperationError(null);
    void likeMarketplaceItem(item.slug, next).then(
      (state) => {
        setLikePending((prev) => {
          const { [item.slug]: _done, ...rest } = prev;
          return rest;
        });
        // Patched by slug rather than index or re-fetch: the player may have
        // paged or searched while the round trip was out, and an index write
        // would then corrupt a different card.
        const patch = (list: MarketplaceItem[]) =>
          list.map((entry) =>
            entry.slug === item.slug ? { ...entry, likes: state.likes, liked: state.liked } : entry
          );
        setItems(patch);
        setInstalledMarketplaceItems(patch);
      },
      (e: unknown) => {
        setLikePending((prev) => {
          const { [item.slug]: _done, ...rest } = prev;
          return rest;
        });
        // The host's own message, not a generic one — the marketplace words
        // its refusals (license requirement, rate-limit wait) for a person.
        setOperationError(e instanceof Error ? e.message : "Could not like this item");
      }
    );
  }

  function handleUninstallBySlug(type: "ui" | "sound", slug: string) {
    if (inspectionBlocks(type, slug)) return;
    clearInspection();
    const current = installStates()[slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", { type, slug, resource: resourceFilter() ?? "" });
  }

  // `onInternal` dismisses an open preview in both mounts; `onEscape` hands
  // the key to the host when nothing is open (the embedded mount passes none,
  // so it falls through to the dialog). `depth: 1` sits above a host's own
  // layer at 0. `active` must require something to do — otherwise this layer
  // would claim Escape on an unselected dialog tab with nothing to dismiss,
  // and the dialog would stop closing on Escape while that tab was open.
  const disposeEscapeLayer = createEscapeLayer({
    label: "marketplace-browser",
    depth: 1,
    active: () => props.active && (previewItem() !== null || props.onEscape !== undefined),
    onInternal: () => {
      if (!previewItem()) return false;
      setPreviewItem(null);
      return true;
    },
    onEscape: () => props.onEscape?.(),
  });
  onCleanup(() => {
    disposeEscapeLayer();
    invalidateRequests();
  });

  const isBrowseTab = () => tab() === "uis" || tab() === "sounds";

  return (
    <div class={`mp-root ${props.class ?? ""}`}>
      <div class="mp-header">
        {props.header}

        <Show when={isBrowseTab() && !previewItem()}>
          <div class="mp-toolbar">
            <div class="mp-search">
              <IconSearch class="mp-search-icon" />
              <input
                type="search"
                class="tlib-nui-control tlib-nui-input"
                aria-label="Search marketplace items"
                placeholder="Search items…"
                value={search()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
            </div>
            <MarketplaceSort
              value={sort()}
              onChange={(value) => {
                invalidateRequests();
                setSort(value);
                // Passed, not re-read: same tick, same trap as the tab.
                void fetchItems(0, undefined, value);
              }}
            />
          </div>
        </Show>

        {props.headerActions}
      </div>

      <div class="mp-tabs" aria-label="Marketplace category">
        {(["uis", "sounds", "installed"] as const).map((t) => (
          <NuiButton
            class="mp-tab"
            aria-pressed={tab() === t ? "true" : "false"}
            onClick={() => handleTabSwitch(t)}
          >
            {t === "uis" ? "UIs" : t === "sounds" ? "Sounds" : "Installed"}
          </NuiButton>
        ))}
      </div>

      <Show when={operationError()}>
        <div role="alert" class="mp-error-banner">
          <span>{operationError()}</span>
          <NuiButton onClick={() => setOperationError(null)}>Dismiss</NuiButton>
        </div>
      </Show>

      <div class="flex-1 min-h-0 relative overflow-hidden">
        <Show when={tab() === "installed"}>
          <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
            <InstalledTab
              marketplaceItems={installedMarketplaceItems()}
              installedLayouts={installedLayouts()}
              installedSounds={installedSounds()}
              installStates={installStates()}
              loading={installedLoading()}
              resource={resourceFilter()}
              inspection={inspection()}
              onInspect={inspectInstallation}
              onInstall={handleInstall}
              onUninstallBySlug={handleUninstallBySlug}
            />
          </div>
        </Show>

        <Show when={isBrowseTab()}>
          <Show
            when={previewItem()}
            fallback={
              <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
                <Show
                  when={!loading()}
                  fallback={
                    <div role="status" aria-label="Loading marketplace" class="mp-empty">
                      <IconLoaderCircle class="w-4 h-4 animate-spin" />
                      <span role="status">Loading items…</span>
                    </div>
                  }
                >
                  <Show when={!error()} fallback={<ErrorPane message={error() as string} />}>
                    <Show
                      when={items().length > 0}
                      fallback={
                        <div role="status" class="mp-empty">
                          No items found.
                        </div>
                      }
                    >
                      <div class="mp-grid">
                        <For each={items()}>
                          {(item) => (
                            <ItemCard
                              item={item}
                              installState={itemInstallState(item)}
                              onInstall={() => handleInstall(item)}
                              onUninstall={() => handleUninstall(item)}
                              onPreview={() => setPreviewItem(item)}
                              onLike={(next) => handleLike(item, next)}
                              likePending={likePending()[item.slug] === true}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                  <div class="mp-pagination" aria-label="Marketplace pages">
                    <NuiButton
                      disabled={pageOffset() === 0}
                      onClick={() => void fetchItems(Math.max(0, pageOffset() - pageSize))}
                      class="mp-action"
                    >
                      Previous page
                    </NuiButton>
                    <span>Page {Math.floor(pageOffset() / pageSize) + 1}</span>
                    <NuiButton
                      disabled={!hasNextPage()}
                      onClick={() => void fetchItems(pageOffset() + pageSize)}
                      class="mp-action"
                    >
                      Next page
                    </NuiButton>
                    <Show when={error()}>
                      <NuiButton onClick={() => void fetchItems(pageOffset())} class="mp-action">
                        Retry
                      </NuiButton>
                    </Show>
                  </div>
                </Show>
              </div>
            }
          >
            {(item) => (
              <PreviewOverlay
                item={item()}
                baseUrl={baseUrl()}
                installState={itemInstallState(item())}
                onClose={() => setPreviewItem(null)}
                onInstall={() => handleInstall(item())}
                onUninstall={() => handleUninstall(item())}
                previewFn={previewFn()}
                previewState={previewState()}
                panelPreviewUrl={panelPreviewUrl()}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
