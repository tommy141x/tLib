/**
 * In-game browse and install UI for marketplace items.
 *
 * Browse fetches {baseUrl}/api/v1/items directly, since that endpoint is public
 * and read-only. Install and uninstall go through the Lua server instead, which
 * is where the ACE check and file-write authority live; their results come back
 * as 'marketplaceInstallResult' / 'marketplaceUninstallResult'.
 *
 * Previews are /api/v1/items/{slug}/download?preview=1 for sound, decoded
 * through the Web Audio API, and /api/v1/preview/{itemId}/ui.html for a UI,
 * rendered in an iframe srcdoc with relative URLs rewritten to absolute. Both
 * sit under /api/v1 rather than a /marketplace prefix because the marketplace
 * backend's own public pages live at that prefix and would shadow them.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import { ErrorPane } from "./marketplace/InstallError";
import { InstalledTab } from "./marketplace/InstalledTab";
import { ItemCard } from "./marketplace/ItemCard";
import {
  type InspectionRequest,
  inspectableIdentity,
  matchesInspectionReply,
  summarizeInspection,
} from "./marketplace/inspection";
import { MarketplaceSort } from "./marketplace/MarketplaceSort";
import { PreviewOverlay } from "./marketplace/PreviewOverlay";
import type {
  InspectionState,
  InstalledSound,
  InstallState,
  MarketplaceItem,
  OpenData,
} from "./marketplace/types";
import { NuiButton } from "./ui/nui-field";
import "./marketplace/marketplace.css";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconSearch from "~icons/lucide/search";
import IconStore from "~icons/lucide/store";
import IconX from "~icons/lucide/x";

let inspectionSequence = 0;

export default function MarketplacePanel() {
  const [open, setOpen] = createSignal(false);
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
      !open() ||
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
    if (!base || !open()) return;
    const request = ++browseRequest;
    browseAbort?.abort();
    const controller = new AbortController();
    browseAbort = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setPageOffset(offset);
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      const activeTab = tab();
      if (activeTab === "uis") qs.set("type", "ui");
      else if (activeTab === "sounds") qs.set("type", "sound");
      if (resourceFilter()) qs.set("resource", resourceFilter() as string);
      if (search()) qs.set("search", search());
      qs.set("sort", sort());
      qs.set("limit", String(pageSize));
      qs.set("cursor", String(offset));
      const resp = await fetch(`${base}/api/v1/items?${qs}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!resp.ok) {
        let code = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          // non-JSON body — keep the HTTP fallback
        }
        throw new Error(code);
      }
      const body = (await resp.json()) as { items: MarketplaceItem[] };
      if (request !== browseRequest) return;
      if (!Array.isArray(body.items)) throw new Error("Invalid marketplace response");
      setItems(body.items);
      setHasNextPage(body.items.length === pageSize);
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
      const resource = resourceFilter();
      const makeQs = (type: string) => {
        const qs = new URLSearchParams({ type, limit: "100" });
        if (resource) qs.set("resource", resource);
        return qs.toString();
      };
      const [uiResp, soundResp] = await Promise.all([
        fetch(`${base}/api/v1/items?${makeQs("ui")}`, { headers: { Accept: "application/json" } }),
        fetch(`${base}/api/v1/items?${makeQs("sound")}`, {
          headers: { Accept: "application/json" },
        }),
      ]);
      const [uiBody, soundBody] = await Promise.all([
        uiResp.ok
          ? (uiResp.json() as Promise<{ items: MarketplaceItem[] }>)
          : Promise.resolve({ items: [] as MarketplaceItem[] }),
        soundResp.ok
          ? (soundResp.json() as Promise<{ items: MarketplaceItem[] }>)
          : Promise.resolve({ items: [] as MarketplaceItem[] }),
      ]);
      if (request === installedRequest)
        setInstalledMarketplaceItems([...(uiBody.items ?? []), ...(soundBody.items ?? [])]);
    } catch {
      if (request === installedRequest) setInstalledMarketplaceItems([]);
    } finally {
      if (request === installedRequest) setInstalledLoading(false);
    }
  }

  onNuiEvent<OpenData>("openMarketplace", (data) => {
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

    setOpen(true);
    void fetchItems();
  });

  onNuiEvent("closeMarketplace", () => {
    invalidateRequests();
    setOpen(false);
  });

  onNuiEvent<unknown>("marketplaceInspectResult", (data) => {
    const active = inspection();
    if (
      !open() ||
      tab() !== "installed" ||
      !active ||
      active.state !== "loading" ||
      !matchesInspectionReply(active.request, data)
    )
      return;
    window.clearTimeout(inspectionTimeout);
    inspectionTimeout = undefined;
    const summary = data.ok ? summarizeInspection(data.inspection, active.request) : null;
    setInspection(summary ? { ...active, state: "ready", summary } : { ...active, state: "error" });
  });

  onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string }>(
    "marketplaceInstallResult",
    (data) => {
      if (!data || typeof data.slug !== "string" || !open()) return;
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
  );

  onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string }>(
    "marketplaceUninstallResult",
    (data) => {
      if (!data || typeof data.slug !== "string" || !open()) return;
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
  );

  function handleClose() {
    invalidateRequests();
    setPreviewItem(null);
    setOpen(false);
    void fetchNui("marketplaceClose", {});
  }

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
    if (next === "installed" && next !== prev) {
      void fetchInstalledItems();
    } else if ((next === "uis" || next === "sounds") && next !== prev) {
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open() && !e.defaultPrevented) {
      e.preventDefault();
      if (previewItem()) {
        setPreviewItem(null);
      } else {
        handleClose();
      }
    }
  }
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    invalidateRequests();
  });

  const isBrowseTab = () => tab() === "uis" || tab() === "sounds";

  return (
    <Show when={open()}>
      <div
        class="mp-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <div
          class="tlib-nui-surface mp-panel"
          role="dialog"
          aria-label="Marketplace"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="mp-header">
            <span class="mp-title">
              <IconStore class="w-3 h-3 opacity-60" />
              Marketplace
              <Show when={resourceFilter()}>
                <span class="mp-resource">{resourceFilter()}</span>
              </Show>
            </span>

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

            <NuiButton class="mp-close" aria-label="Close marketplace" onClick={handleClose}>
              <IconX class="w-3 h-3" />
            </NuiButton>
          </div>

          <div class="mp-tabs" aria-label="Marketplace category">
            {(["uis", "sounds", "installed"] as const).map((t) => (
              <NuiButton
                class="mp-tab"
                aria-pressed={tab() === t}
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
                          <NuiButton
                            onClick={() => void fetchItems(pageOffset())}
                            class="mp-action"
                          >
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
      </div>
    </Show>
  );
}
