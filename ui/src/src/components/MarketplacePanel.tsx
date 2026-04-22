/**
 * MarketplacePanel — in-game browse + install UI for tLib marketplace items.
 *
 * Lifecycle:
 *   Lua opens: SendNUIMessage({ action: 'openMarketplace', data: { type, apiBase } })
 *   Panel fetches GET {apiBase}/items?type=... directly (public endpoint)
 *   Install click: fetchNui('marketplaceInstall', { type, slug, version })
 *   Server → NUI: { action: 'marketplaceInstallResult', data: { ok, slug, error? } }
 *   ESC or backdrop click → fetchNui('marketplaceClose')
 *
 * Browse is client-driven (direct fetch) because it's public and read-only.
 * Install routes through Lua server for ACE check + file-write authority.
 */

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import IconDownload from "~icons/lucide/download";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconSearch from "~icons/lucide/search";
import IconStore from "~icons/lucide/store";
import IconX from "~icons/lucide/x";

interface MarketplaceItem {
  id: string;
  slug: string;
  type: string;
  name: string;
  description: string;
  creator_name: string;
  current_version: string;
  size_bytes: number;
  downloads: number;
  created_at: string;
}

interface OpenData {
  type?: string;
  /** Marketplace site base URL (no /api/v1 suffix). */
  baseUrl: string;
}

type InstallState =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "done"; ok: boolean; error?: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

export default function MarketplacePanel() {
  const [open, setOpen] = createSignal(false);
  const [typeFilter, setTypeFilter] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal<string>("");
  const [search, setSearch] = createSignal("");
  const [items, setItems] = createSignal<MarketplaceItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [installStates, setInstallStates] = createSignal<Record<string, InstallState>>({});

  let searchDebounce: number | null = null;

  function setInstallState(slug: string, next: InstallState) {
    setInstallStates((prev) => ({ ...prev, [slug]: next }));
  }

  async function fetchItems() {
    const base = baseUrl();
    if (!base) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (typeFilter()) qs.set("type", typeFilter() as string);
      if (search()) qs.set("search", search());
      qs.set("limit", "50");
      const resp = await fetch(`${base}/api/v1/items?${qs}`, {
        headers: { Accept: "application/json" },
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
      setItems(body.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  onNuiEvent<OpenData>("openMarketplace", (data) => {
    setBaseUrl(data.baseUrl);
    setTypeFilter(data.type ?? null);
    setSearch("");
    setInstallStates({});
    setOpen(true);
    void fetchItems();
  });

  onNuiEvent("closeMarketplace", () => setOpen(false));

  onNuiEvent<{ ok: boolean; slug: string; error?: string }>("marketplaceInstallResult", (data) => {
    if (!data || typeof data.slug !== "string") return;
    setInstallState(data.slug, { state: "done", ok: data.ok, error: data.error });
  });

  function handleClose() {
    setOpen(false);
    void fetchNui("marketplaceClose", {});
  }

  function handleSearchInput(value: string) {
    setSearch(value);
    if (searchDebounce) window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => void fetchItems(), 250);
  }

  function handleInstall(item: MarketplaceItem) {
    const current = installStates()[item.slug]?.state;
    if (current === "installing") return;
    setInstallState(item.slug, { state: "installing" });
    void fetchNui("marketplaceInstall", {
      type: item.type,
      slug: item.slug,
      version: item.current_version,
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open()) {
      e.preventDefault();
      handleClose();
    }
  }
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    if (searchDebounce) window.clearTimeout(searchDebounce);
  });

  const filterBadge = createMemo(() => typeFilter());

  return (
    <Show when={open()}>
      <div
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <div
          class="settings-panel flex flex-col overflow-hidden pointer-events-auto"
          style={{ width: "880px", height: "600px", "max-width": "92vw", "max-height": "90vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border)/0.6)] gap-3">
            <span class="flex items-center gap-1.5 text-[10px] font-mono font-semibold text-[hsl(var(--muted-foreground))] shrink-0">
              <IconStore class="w-3 h-3 opacity-60" />
              Marketplace
              <Show when={filterBadge()}>
                <span class="ml-1 px-1.5 py-0.5 text-[9px] rounded bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] font-normal">
                  {filterBadge()}
                </span>
              </Show>
            </span>

            {/* Search */}
            <div class="flex-1 relative max-w-md">
              <IconSearch class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 opacity-50 pointer-events-none" />
              <input
                type="search"
                class="w-full pl-7 pr-2 py-1 text-[10px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:border-[hsl(var(--ring))]"
                placeholder="Search items…"
                value={search()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
            </div>

            <button
              class="flex items-center justify-center w-5 h-5 rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0"
              onClick={handleClose}
            >
              <IconX class="w-3 h-3" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 overflow-y-auto settings-scroll p-3">
            <Show
              when={!loading()}
              fallback={
                <div class="flex items-center justify-center h-full text-[hsl(var(--muted-foreground))]">
                  <IconLoaderCircle class="w-4 h-4 animate-spin" />
                </div>
              }
            >
              <Show when={!error()} fallback={<ErrorPane message={error() as string} />}>
                <Show
                  when={items().length > 0}
                  fallback={
                    <div class="flex items-center justify-center h-full text-[10px] font-mono text-[hsl(var(--muted-foreground)/0.6)]">
                      No items found.
                    </div>
                  }
                >
                  <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">
                    <For each={items()}>
                      {(item) => (
                        <ItemCard
                          item={item}
                          installState={installStates()[item.slug] ?? { state: "idle" }}
                          onInstall={() => handleInstall(item)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

function ErrorPane(props: { message: string }) {
  return (
    <div class="flex flex-col items-center justify-center h-full text-[10px] font-mono gap-1">
      <span class="text-[hsl(var(--destructive))]">Failed to load marketplace</span>
      <span class="text-[hsl(var(--muted-foreground)/0.6)]">{props.message}</span>
    </div>
  );
}

function ItemCard(props: {
  item: MarketplaceItem;
  installState: InstallState;
  onInstall: () => void;
}) {
  const s = () => props.installState;
  const buttonLabel = () => {
    const st = s();
    if (st.state === "installing") return "Installing…";
    if (st.state === "done" && st.ok) return "Installed";
    if (st.state === "done" && !st.ok) return "Retry";
    return "Install";
  };
  const disabled = () => s().state === "installing";
  const tone = () => {
    const st = s();
    if (st.state === "installing") return "neutral" as const;
    if (st.state === "done" && st.ok) return "success" as const;
    if (st.state === "done" && !st.ok) return "error" as const;
    return "primary" as const;
  };

  return (
    <div class="flex flex-col gap-2 p-2 rounded border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--background)/0.4)]">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <span class="text-[11px] font-mono font-semibold text-[hsl(var(--foreground))] truncate">
            {props.item.name}
          </span>
          <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.7)] truncate">
            by {props.item.creator_name} · v{props.item.current_version}
          </span>
        </div>
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)] shrink-0">
          {formatBytes(props.item.size_bytes)}
        </span>
      </div>

      <Show when={props.item.description}>
        <p class="text-[9px] font-mono text-[hsl(var(--muted-foreground))] line-clamp-2">
          {props.item.description}
        </p>
      </Show>

      <div class="flex items-center justify-between mt-auto">
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
          {props.item.downloads} installs
        </span>
        <button
          class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
          classList={{
            "bg-primary text-primary-foreground hover:bg-primary/90": tone() === "primary",
            "bg-secondary/60 text-muted-foreground": tone() === "neutral",
            "bg-green-600/80 text-white": tone() === "success",
            "bg-destructive text-destructive-foreground hover:bg-destructive/90":
              tone() === "error",
          }}
          disabled={disabled()}
          onClick={props.onInstall}
          title={s().state === "done" && !s().ok ? (s() as { error?: string }).error : undefined}
        >
          <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
            <IconLoaderCircle class="w-3 h-3 animate-spin" />
          </Show>
          {buttonLabel()}
        </button>
      </div>
    </div>
  );
}
