/**
 * The marketplace BODY: toolbar, category tabs, card grid, pagination, preview
 * and the install/uninstall/inspect machinery. Everything except the chrome it
 * is mounted in.
 *
 * This exists because the browser has two mounts, and only one of them is a
 * modal:
 *
 * - `components/MarketplacePanel.tsx` wraps it in `.mp-backdrop` + `.mp-panel`
 *   and is what `exports.tLib:OpenMarketplace` opens. tRadio's in-game path
 *   still uses that.
 * - `components/Dialog.tsx` mounts it INSIDE a dialog tab panel, for a tab
 *   declared `view: "marketplace"`. That is the integrated path: `/tdet` and
 *   `/tradar` open a dialog, and the Marketplace tab has to live in that same
 *   dialog rather than close it and throw a second overlay on top.
 *
 * So nothing here may render a backdrop, a modal surface, or a second focus
 * trap. The host owns those. It also may not close itself — `onEscape` hands
 * the key back to whichever host is mounting it, because "Escape" means
 * "dismiss the modal" in one and "dismiss the dialog" in the other.
 *
 * Why browse/preview/install all go through Lua rather than a direct fetch is
 * explained in `@tlib/shared/marketplace/ui` (`browse.ts`) and in
 * `client/cl_marketplace.lua`: CEF's origin is `cfx-nui-tLib` and the
 * marketplace host sends no Access-Control-Allow-Origin.
 */

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
  type MarketplaceItem,
  matchesInspectionReply,
  type OpenData,
  PreviewOverlay,
  summarizeInspection,
} from "@tlib/shared/marketplace/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconSearch from "~icons/lucide/search";
import { NuiButton } from "../ui/nui-field";
import { MarketplaceSort } from "./MarketplaceSort";

let inspectionSequence = 0;

export interface MarketplaceBrowserProps {
  /** The open payload. `null` means nothing has been provided yet. */
  data: OpenData | null;
  /**
   * Whether this mount is visible and allowed to issue requests. Going false
   * aborts anything in flight; going true again re-applies `data` from scratch,
   * so leaving and returning to the tab re-browses rather than showing a stale
   * page.
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
  const pendingInstallTypes: Record<string, string> = {};
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

  async function fetchItems(offset = 0) {
    const base = baseUrl();
    if (!base || !props.active) return;
    const request = ++browseRequest;
    browseAbort?.abort();
    const controller = new AbortController();
    browseAbort = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setPageOffset(offset);
    setLoading(true);
    setError(null);
    try {
      const activeTab = tab();
      const page = await browseMarketplace(
        {
          type: activeTab === "uis" ? "ui" : activeTab === "sounds" ? "sound" : undefined,
          resource: resourceFilter() ?? undefined,
          search: search() || undefined,
          sort: sort(),
          limit: pageSize,
          cursor: offset,
        },
        controller.signal
      );
      if (request !== browseRequest) return;
      setItems(page.items);
      // The server reports this now. Previously it was inferred from a full
      // page, which claimed a next page whenever the catalogue happened to be
      // an exact multiple of the page size.
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
      if (request === browseRequest) setLoading(false);
    }
  }

  async function fetchInstalledItems() {
    const base = baseUrl();
    if (!base) return;
    const request = ++installedRequest;
    setInstalledLoading(true);
    try {
      const resource = resourceFilter() ?? undefined;
      // Two calls rather than one unfiltered call: the Installed tab matches
      // catalogue entries to what is on disk by slug, and a `ui` and a `sound`
      // may share one. Kept as-is through the transport change — the browse
      // cap is per request, so merging them would halve what either can carry.
      const pages = await Promise.all(
        (["ui", "sound"] as const).map((type) =>
          browseMarketplace({ type, resource, limit: 100 }).catch(() => ({
            items: [] as MarketplaceItem[],
          }))
        )
      );
      if (request === installedRequest)
        setInstalledMarketplaceItems(pages.flatMap((page) => page.items));
    } catch {
      if (request === installedRequest) setInstalledMarketplaceItems([]);
    } finally {
      if (request === installedRequest) setInstalledLoading(false);
    }
  }

  function applyOpenData(data: OpenData) {
    invalidateRequests();
    for (const slug of Object.keys(pendingInstallTypes)) delete pendingInstallTypes[slug];
    setBaseUrl(data.baseUrl);
    setResourceFilter(data.resource ?? null);
    setSearch("");
    setOperationError(null);
    setSort("downloads");
    setTab(data.initialTab ?? "uis");
    setInstalledLayouts(data.installedLayouts ?? []);
    setInstalledSounds(data.installedSounds ?? []);
    setInstalledMarketplaceItems([]);
    setPreviewItem(null);
    setPreviewFn(data.previewFn ?? null);
    setPreviewState(data.previewState ?? null);

    const seed: Record<string, InstallState> = {};
    for (const slug of data.installedSlugs ?? []) {
      seed[slug] = { state: "installed" };
    }
    setInstallStates(seed);

    if (tab() === "installed") void fetchInstalledItems();
    else void fetchItems();
  }

  // The only entry point. `applied` is identity, not a deep compare: every
  // payload arrives as a fresh object off an NUI message, and a host that
  // re-sends the same object means "nothing changed".
  let applied: OpenData | null = null;
  // The two-argument form replaces the `untrack` that used to wrap the body:
  // in Solid 2 only `compute` tracks, so the resets below — which write most of
  // the signals in this component — cannot re-trigger this effect, and the
  // phase split states that rather than relying on a wrapper to enforce it.
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
    onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string }>(
      "marketplaceInstallResult",
      (data) => {
        if (!data || typeof data.slug !== "string" || !props.active) return;
        if (data.resource && data.resource !== resourceFilter()) return;
        clearInspection();
        const type = pendingInstallTypes[data.slug];
        delete pendingInstallTypes[data.slug];
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
    setLoading(true);
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
      void fetchItems();
    }
  }

  function handleInstall(item: MarketplaceItem) {
    if ((item.type === "ui" || item.type === "sound") && inspectionBlocks(item.type, item.slug))
      return;
    clearInspection();
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "installing" });
    pendingInstallTypes[item.slug] = item.type;
    void fetchNui("marketplaceInstall", {
      type: item.type,
      slug: item.slug,
      version: item.current_version,
      resource: resourceFilter() ?? "",
    });
  }

  function handleUninstall(item: MarketplaceItem) {
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", {
      type: item.type,
      slug: item.slug,
      resource: resourceFilter() ?? "",
    });
  }

  function handleUninstallBySlug(type: "ui" | "sound", slug: string) {
    if (inspectionBlocks(type, slug)) return;
    clearInspection();
    const current = installStates()[slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", { type, slug, resource: resourceFilter() ?? "" });
  }

  // A preview is dismissed here in BOTH mounts, because it is this component's
  // own layer. Only the outer Escape — nothing open, dismiss the host — differs,
  // and that is `onEscape`'s whole job. The embedded mount passes none, so the
  // key falls through to the dialog and closes it, exactly as on any other tab.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !props.active || e.defaultPrevented) return;
    if (previewItem()) {
      e.preventDefault();
      setPreviewItem(null);
    } else if (props.onEscape) {
      e.preventDefault();
      props.onEscape();
    }
  }
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
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
                void fetchItems();
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
                              installState={installStates()[item.slug] ?? { state: "idle" }}
                              onInstall={() => handleInstall(item)}
                              onUninstall={() => handleUninstall(item)}
                              onPreview={() => setPreviewItem(item)}
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
                installState={installStates()[item().slug] ?? { state: "idle" }}
                onClose={() => setPreviewItem(null)}
                onInstall={() => handleInstall(item())}
                onUninstall={() => handleUninstall(item())}
                previewFn={previewFn()}
                previewState={previewState()}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

export default MarketplaceBrowser;
