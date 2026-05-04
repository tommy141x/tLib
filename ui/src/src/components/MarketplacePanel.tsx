/**
 * MarketplacePanel — in-game browse + install UI for tLib marketplace items.
 *
 * Lifecycle:
 *   Lua opens: SendNUIMessage({ action: 'openMarketplace', data: { baseUrl, resource?, initialTab?, installedSlugs? } })
 *   Panel fetches GET {baseUrl}/api/v1/items?type=...&resource=... directly (public endpoint)
 *   Install click: fetchNui('marketplaceInstall', { type, slug, version, resource })
 *   Delete click:  fetchNui('marketplaceUninstall', { type, slug, resource })
 *   Server → NUI: { action: 'marketplaceInstallResult',   data: { ok, slug, error? } }
 *   Server → NUI: { action: 'marketplaceUninstallResult', data: { ok, slug, error? } }
 *   ESC or backdrop click → fetchNui('marketplaceClose')
 *
 * Browse is client-driven (direct fetch) because it's public and read-only.
 * Install/uninstall routes through Lua server for ACE check + file-write authority.
 *
 * Previews:
 *   Sound: GET {baseUrl}/marketplace/api/v1/items/{slug}/download?preview=1 → Web Audio API
 *   UI:    GET {baseUrl}/marketplace/preview/{itemId}/ui.html → iframe srcdoc (relative URLs rewritten to absolute)
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import IconSearch from "~icons/lucide/search";
import IconStore from "~icons/lucide/store";
import IconTrash2 from "~icons/lucide/trash-2";
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

interface InstalledSound {
  filename: string;
  slug: string;
}

interface OpenData {
  type?: string;
  /** Marketplace site base URL (no /api/v1 suffix). */
  baseUrl: string;
  /** Slugs already installed on this server — shown with a delete button at open time. */
  installedSlugs?: string[];
  /** All installed layout names (including built-ins), for the Installed tab. */
  installedLayouts?: string[];
  /** All installed sounds (including built-ins), for the Installed tab. */
  installedSounds?: InstalledSound[];
  /** Filter results to a specific resource name. */
  resource?: string;
  /** Which tab to open on. Defaults to "uis". */
  initialTab?: "uis" | "sounds";
  /** Name of the global update function the preview iframe should call (e.g. "__tdetLayoutUpdate"). */
  previewFn?: string;
  /** Dummy state to feed into the preview update function so the UI renders non-empty. */
  previewState?: Record<string, unknown>;
}

type InstallState =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "uninstalling" }
  | { state: "installed" }
  | { state: "done"; ok: boolean; error?: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function MarketplacePanel() {
  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal<"uis" | "sounds" | "installed">("uis");
  const [resourceFilter, setResourceFilter] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal<string>("");
  const [search, setSearch] = createSignal("");
  const [items, setItems] = createSignal<MarketplaceItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [installStates, setInstallStates] = createSignal<Record<string, InstallState>>({});
  const pendingInstallTypes: Record<string, string> = {};
  const [installedLayouts, setInstalledLayouts] = createSignal<string[]>([]);
  const [installedSounds, setInstalledSounds] = createSignal<InstalledSound[]>([]);
  const [sort, setSort] = createSignal<"downloads" | "created_at">("downloads");
  const [installedMarketplaceItems, setInstalledMarketplaceItems] = createSignal<MarketplaceItem[]>([]);
  const [installedLoading, setInstalledLoading] = createSignal(false);
  const [previewItem, setPreviewItem] = createSignal<MarketplaceItem | null>(null);
  const [previewFn, setPreviewFn] = createSignal<string | null>(null);
  const [previewState, setPreviewState] = createSignal<Record<string, unknown> | null>(null);

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
      const activeTab = tab();
      if (activeTab === "uis") qs.set("type", "ui");
      else if (activeTab === "sounds") qs.set("type", "sound");
      if (resourceFilter()) qs.set("resource", resourceFilter() as string);
      if (search()) qs.set("search", search());
      qs.set("sort", sort());
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

  async function fetchInstalledItems() {
    const base = baseUrl();
    if (!base) return;
    setInstalledLoading(true);
    try {
      const resource = resourceFilter();
      const makeQs = (type: string) => {
        const qs = new URLSearchParams({ type, limit: "200" });
        if (resource) qs.set("resource", resource);
        return qs.toString();
      };
      const [uiResp, soundResp] = await Promise.all([
        fetch(`${base}/api/v1/items?${makeQs("ui")}`, { headers: { Accept: "application/json" } }),
        fetch(`${base}/api/v1/items?${makeQs("sound")}`, { headers: { Accept: "application/json" } }),
      ]);
      const [uiBody, soundBody] = await Promise.all([
        uiResp.ok ? (uiResp.json() as Promise<{ items: MarketplaceItem[] }>) : Promise.resolve({ items: [] as MarketplaceItem[] }),
        soundResp.ok ? (soundResp.json() as Promise<{ items: MarketplaceItem[] }>) : Promise.resolve({ items: [] as MarketplaceItem[] }),
      ]);
      setInstalledMarketplaceItems([...(uiBody.items ?? []), ...(soundBody.items ?? [])]);
    } catch {
      setInstalledMarketplaceItems([]);
    } finally {
      setInstalledLoading(false);
    }
  }

  onNuiEvent<OpenData>("openMarketplace", (data) => {
    setBaseUrl(data.baseUrl);
    setResourceFilter(data.resource ?? null);
    setSearch("");
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

  onNuiEvent("closeMarketplace", () => setOpen(false));

  onNuiEvent<{ ok: boolean; slug: string; error?: string }>("marketplaceInstallResult", (data) => {
    if (!data || typeof data.slug !== "string") return;
    const type = pendingInstallTypes[data.slug];
    delete pendingInstallTypes[data.slug];
    if (data.ok) {
      setInstallState(data.slug, { state: "installed" });
      if (type === "ui") {
        setInstalledLayouts((prev) => prev.includes(data.slug) ? prev : [...prev, data.slug]);
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
  });

  onNuiEvent<{ ok: boolean; slug: string; error?: string }>("marketplaceUninstallResult", (data) => {
    if (!data || typeof data.slug !== "string") return;
    if (data.ok) {
      setInstallState(data.slug, { state: "idle" });
      setInstalledLayouts((prev) => prev.filter((l) => l !== data.slug));
      setInstalledSounds((prev) => prev.filter((s) => s.slug !== data.slug));
    } else {
      setInstallState(data.slug, { state: "installed" });
    }
  });

  function handleClose() {
    setPreviewItem(null);
    setOpen(false);
    void fetchNui("marketplaceClose", {});
  }

  function handleSearchInput(value: string) {
    setSearch(value);
    if (searchDebounce) window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => void fetchItems(), 250);
  }

  function handleTabSwitch(next: "uis" | "sounds" | "installed") {
    const prev = tab();
    setPreviewItem(null);
    setTab(next);
    if (next === "installed" && next !== prev) {
      void fetchInstalledItems();
    } else if ((next === "uis" || next === "sounds") && next !== prev) {
      void fetchItems();
    }
  }

  function handleInstall(item: MarketplaceItem) {
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
    const current = installStates()[slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", { type, slug, resource: resourceFilter() ?? "" });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open()) {
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
    if (searchDebounce) window.clearTimeout(searchDebounce);
  });

  const isBrowseTab = () => tab() === "uis" || tab() === "sounds";

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
              <Show when={resourceFilter()}>
                <span class="ml-1 px-1.5 py-0.5 text-[9px] rounded bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] font-normal">
                  {resourceFilter()}
                </span>
              </Show>
            </span>

            {/* Search + sort — shown on browse tabs only, hidden when previewing */}
            <Show when={isBrowseTab() && !previewItem()}>
              <div class="flex items-center gap-2 flex-1 max-w-lg">
                <div class="flex-1 relative">
                  <IconSearch class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 opacity-50 pointer-events-none" />
                  <input
                    type="search"
                    class="w-full pl-7 pr-2 py-1 text-[10px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:border-[hsl(var(--ring))]"
                    placeholder="Search items…"
                    value={search()}
                    onInput={(e) => handleSearchInput(e.currentTarget.value)}
                  />
                </div>
                <select
                  class="py-1 px-2 text-[9px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--muted-foreground))] focus:outline-none focus:border-[hsl(var(--ring))] cursor-pointer shrink-0"
                  value={sort()}
                  onChange={(e) => {
                    setSort(e.currentTarget.value as "downloads" | "created_at");
                    void fetchItems();
                  }}
                >
                  <option value="downloads">Most Downloads</option>
                  <option value="created_at">Recently Added</option>
                </select>
              </div>
            </Show>

            <button
              class="flex items-center justify-center w-5 h-5 rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0"
              onClick={handleClose}
            >
              <IconX class="w-3 h-3" />
            </button>
          </div>

          {/* Tab bar */}
          <div class="flex border-b border-[hsl(var(--border)/0.6)] px-3">
            {(["uis", "sounds", "installed"] as const).map((t) => (
              <button
                class="px-3 py-1.5 text-[10px] font-mono border-b-2 -mb-px transition-colors"
                classList={{
                  "border-[hsl(var(--ring))] text-[hsl(var(--foreground))]": tab() === t,
                  "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]":
                    tab() !== t,
                }}
                onClick={() => handleTabSwitch(t)}
              >
                {t === "uis" ? "UIs" : t === "sounds" ? "Sounds" : "Installed"}
              </button>
            ))}
          </div>

          {/* Body */}
          <div class="flex-1 min-h-0 relative overflow-hidden">
            {/* Installed tab */}
            <Show when={tab() === "installed"}>
              <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
                <InstalledTab
                  marketplaceItems={installedMarketplaceItems()}
                  installedLayouts={installedLayouts()}
                  installedSounds={installedSounds()}
                  installStates={installStates()}
                  loading={installedLoading()}
                  onInstall={handleInstall}
                  onUninstallBySlug={handleUninstallBySlug}
                />
              </div>
            </Show>

            {/* Browse tabs */}
            <Show when={isBrowseTab()}>
              {/* Preview overlay */}
              <Show
                when={previewItem()}
                fallback={
                  <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
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
                                  onUninstall={() => handleUninstall(item)}
                                  onPreview={() => setPreviewItem(item)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
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

// ─── Preview overlay ──────────────────────────────────────────────────────────

function PreviewOverlay(props: {
  item: MarketplaceItem;
  baseUrl: string;
  installState: InstallState;
  onClose: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  previewFn?: string | null;
  previewState?: Record<string, unknown> | null;
}) {
  const s = () => props.installState;
  const busy = () => s().state === "installing" || s().state === "uninstalling";
  const isInstalled = () => s().state === "installed";

  const installLabel = () => {
    const st = s();
    if (st.state === "installing") return "Installing…";
    if (st.state === "installed") return "Reinstall";
    if (st.state === "done" && !st.ok) return "Retry";
    return "Install";
  };

  return (
    <div class="absolute inset-0 flex flex-col p-3 gap-2">
      {/* Overlay header */}
      <div class="flex items-center gap-2 shrink-0">
        <button
          class="flex items-center gap-1 text-[9px] font-mono text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0"
          onClick={props.onClose}
        >
          <IconChevronLeft class="w-3 h-3" />
          Back
        </button>
        <span class="w-px h-3 bg-[hsl(var(--border)/0.6)] shrink-0" />
        <span class="text-[10px] font-mono font-semibold text-[hsl(var(--foreground))] truncate">
          {props.item.name}
        </span>
        <Show when={props.item.creator_name}>
          <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.6)] truncate shrink-0">
            by {props.item.creator_name}
          </span>
        </Show>
        <div class="flex-1" />
        {/* Action buttons */}
        <div class="flex items-center gap-1 shrink-0">
          <Show when={isInstalled() || s().state === "uninstalling"}>
            <button
              class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
              classList={{
                "bg-destructive/20 text-destructive hover:bg-destructive/30": s().state !== "uninstalling",
                "bg-secondary/60 text-muted-foreground": s().state === "uninstalling",
              }}
              disabled={busy()}
              onClick={props.onUninstall}
            >
              <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                <IconLoaderCircle class="w-3 h-3 animate-spin" />
              </Show>
              <Show when={s().state === "uninstalling"}>Deleting…</Show>
            </button>
          </Show>
          <button
            class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
            classList={{
              "bg-primary text-primary-foreground hover:bg-primary/90": s().state !== "installing" && s().state !== "installed",
              "bg-secondary/60 text-muted-foreground": s().state === "installing",
              "bg-green-600/80 text-white hover:bg-green-600/90": s().state === "installed",
            }}
            disabled={busy()}
            onClick={props.onInstall}
          >
            <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </button>
        </div>
      </div>

      {/* Preview content */}
      <div class="flex-1 min-h-0">
        <Show
          when={props.item.type === "sound"}
          fallback={<UiPreviewFrame item={props.item} baseUrl={props.baseUrl} previewFn={props.previewFn} previewState={props.previewState} />}
        >
          <AudioPreviewPlayer item={props.item} baseUrl={props.baseUrl} />
        </Show>
      </div>
    </div>
  );
}

// ─── Audio preview ────────────────────────────────────────────────────────────

type AudioPlayerState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; buffer: AudioBuffer };

function AudioPreviewPlayer(props: { item: MarketplaceItem; baseUrl: string }) {
  const [audioState, setAudioState] = createSignal<AudioPlayerState>({ kind: "idle" });
  const [playing, setPlaying] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);

  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let startedAt = 0;
  let pausedAt = 0;
  let raf = 0;

  function duration(): number {
    const s = audioState();
    return s.kind === "ready" ? s.buffer.duration : 0;
  }

  function startSource(offset: number) {
    const s = audioState();
    if (s.kind !== "ready" || !ctx) return;
    source = ctx.createBufferSource();
    source.buffer = s.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (playing()) {
        setPlaying(false);
        pausedAt = 0;
        setElapsed(0);
        cancelAnimationFrame(raf);
      }
    };
    startedAt = ctx.currentTime - offset;
    source.start(0, offset);
  }

  function tick() {
    if (!ctx) return;
    setElapsed(Math.min(ctx.currentTime - startedAt, duration()));
    raf = requestAnimationFrame(tick);
  }

  async function loadAndPlay() {
    setAudioState({ kind: "loading" });
    try {
      const url = `${props.baseUrl}/marketplace/api/v1/items/${encodeURIComponent(props.item.slug)}/download?preview=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      ctx ??= new AudioContext();
      const buffer = await ctx.decodeAudioData(ab);
      setAudioState({ kind: "ready", buffer });
      startSource(0);
      setPlaying(true);
      tick();
    } catch {
      setAudioState({ kind: "error" });
    }
  }

  function seek(e: MouseEvent) {
    const bar = e.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const offset = fraction * duration();
    const wasPlaying = playing();
    if (wasPlaying) { source?.stop(); source = null; cancelAnimationFrame(raf); }
    pausedAt = offset;
    setElapsed(offset);
    if (wasPlaying) { startSource(offset); tick(); }
  }

  function onPlayPause() {
    const s = audioState();
    if (s.kind === "idle" || s.kind === "error") { void loadAndPlay(); return; }
    if (s.kind === "loading") return;
    if (playing()) {
      source?.stop();
      source = null;
      pausedAt = ctx ? ctx.currentTime - startedAt : 0;
      setPlaying(false);
      cancelAnimationFrame(raf);
    } else {
      if (ctx?.state === "suspended") void ctx.resume();
      startSource(pausedAt);
      setPlaying(true);
      tick();
    }
  }

  onCleanup(() => {
    cancelAnimationFrame(raf);
    try { source?.stop(); } catch { /* already stopped */ }
    void ctx?.close();
  });

  const progress = () => duration() > 0 ? elapsed() / duration() : 0;
  const isLoading = () => audioState().kind === "loading";
  const hasError = () => audioState().kind === "error";

  return (
    <div class="flex flex-col items-center justify-center h-full gap-4">
      <div class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
        {props.item.downloads} installs · {formatBytes(props.item.size_bytes)}
      </div>

      <div class="flex items-center gap-3 w-full max-w-sm px-4 py-3 rounded-lg border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.3)]">
        <button
          class="flex items-center justify-center w-8 h-8 rounded-full shrink-0 transition-colors"
          classList={{
            "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary)/0.85)]": !isLoading() && !hasError(),
            "bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]": isLoading(),
            "bg-destructive/20 text-destructive": hasError(),
          }}
          onClick={onPlayPause}
          disabled={isLoading()}
          title={hasError() ? "Preview unavailable — click to retry" : playing() ? "Pause" : "Play"}
        >
          <Show when={isLoading()} fallback={
            <Show when={playing()} fallback={<IconPlay class="w-3.5 h-3.5 ml-0.5" />}>
              <IconPause class="w-3.5 h-3.5" />
            </Show>
          }>
            <IconLoaderCircle class="w-3.5 h-3.5 animate-spin" />
          </Show>
        </button>

        <div class="flex-1 min-w-0">
          <div
            class="mb-1.5 h-1 rounded-full bg-[hsl(var(--border)/0.8)] cursor-pointer"
            onClick={seek}
          >
            <div
              class="h-full rounded-full bg-[hsl(var(--primary))] transition-[width]"
              style={{ width: `${(progress() * 100).toFixed(1)}%` }}
            />
          </div>
          <div class="flex justify-between text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
            <span>{fmtTime(elapsed())}</span>
            <Show when={duration() > 0}>
              <span>{fmtTime(duration())}</span>
            </Show>
          </div>
        </div>
      </div>

      <Show when={hasError()}>
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
          Preview unavailable for this item
        </span>
      </Show>
    </div>
  );
}

// ─── UI preview (iframe srcdoc) ───────────────────────────────────────────────

function UiPreviewFrame(props: { item: MarketplaceItem; baseUrl: string; previewFn?: string | null; previewState?: Record<string, unknown> | null }) {
  const [html, setHtml] = createSignal<string | null>(null);
  const [loadError, setLoadError] = createSignal(false);

  let containerRef!: HTMLDivElement;
  const [containerW, setContainerW] = createSignal(700);
  const [containerH, setContainerH] = createSignal(400);

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setContainerW(containerRef.clientWidth);
      setContainerH(containerRef.clientHeight);
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());

    const url = `${props.baseUrl}/marketplace/preview/${encodeURIComponent(props.item.id)}/ui.html`;
    fetch(url, { headers: { Accept: "text/html" } })
      .then((r) => { if (!r.ok) throw new Error(); return r.text(); })
      .then((text) => {
        const base = url.replace(/[^/]+$/, "");
        let rewritten = text.replace(
          /(src|href)=(['"])(?!https?:|\/\/|data:|#|\/)([^'"]+)\2/gi,
          (_: string, attr: string, q: string, p: string) => `${attr}=${q}${base}${p}${q}`,
        );
        // Center the content inside the iframe viewport.
        const centerCss = "<style>html,body{margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>";
        rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${centerCss}`);
        if (!/(<head)/i.test(rewritten)) rewritten = centerCss + rewritten;

        // Inject dummy state so the layout renders non-empty in the preview.
        const fn = props.previewFn;
        const state = props.previewState;
        if (fn && state) {
          const stateJson = JSON.stringify(state);
          // Retry loop handles layouts that register their update fn asynchronously.
          const previewScript = `<script>(function(){var fn=${JSON.stringify(fn)},s=${stateJson},t=0;function run(){if(typeof window[fn]==='function'){window[fn](s);}else if(++t<40){setTimeout(run,100);}}setTimeout(run,50);})()</script>`;
          rewritten = rewritten.replace(/<\/body>/i, previewScript + "</body>");
          if (!/<\/body>/i.test(rewritten)) rewritten += previewScript;
        }

        setHtml(rewritten);
      })
      .catch(() => setLoadError(true));
  });

  // Detect canvas size from the preview HTML using several strategies.
  const canvasSize = createMemo(() => {
    const h = html();
    if (!h) return { w: 400, h: 400 };

    // studio-design base64 metadata may carry explicit dimensions.
    const sdMatch = h.match(/<!--\s*studio-design:([A-Za-z0-9+/=\s]+)-->/);
    if (sdMatch) {
      try {
        const meta = JSON.parse(atob(sdMatch[1].trim())) as Record<string, unknown>;
        const w = typeof meta.width === "number" ? meta.width : 0;
        const hv = typeof meta.height === "number" ? meta.height : 0;
        if (w > 0 && hv > 0) return { w, h: hv };
      } catch { /* ignore */ }
    }

    // tRadio-style explicit data attributes.
    const wm = h.match(/data-radio-width="(\d+)"/);
    const hm = h.match(/data-radio-height="(\d+)"/);
    if (wm && hm) return { w: parseInt(wm[1]!, 10), h: parseInt(hm[1]!, 10) };

    // Largest explicit pixel dimensions found anywhere in CSS/inline styles.
    const allW = [...h.matchAll(/\bwidth:\s*(\d+)px/gi)].map((m) => parseInt(m[1]!, 10));
    const allH = [...h.matchAll(/\bheight:\s*(\d+)px/gi)].map((m) => parseInt(m[1]!, 10));
    const maxW = allW.length > 0 ? Math.max(...allW) : 0;
    const maxH = allH.length > 0 ? Math.max(...allH) : 0;
    if (maxW > 0 && maxH > 0) return { w: maxW, h: maxH };

    return { w: 400, h: 400 };
  });

  const scale = createMemo(() => {
    const { w, h } = canvasSize();
    return Math.min(containerW() / w, containerH() / h, 1);
  });

  return (
    <div
      ref={containerRef!}
      class="w-full h-full flex items-center justify-center bg-black rounded overflow-hidden"
    >
      <Show when={!html() && !loadError()}>
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">Loading…</span>
      </Show>
      <Show when={loadError()}>
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">Preview unavailable</span>
      </Show>
      <Show when={html()}>
        <div
          style={{
            width: `${canvasSize().w}px`,
            height: `${canvasSize().h}px`,
            transform: `scale(${scale()})`,
            "transform-origin": "center center",
            overflow: "hidden",
            "flex-shrink": "0",
          }}
        >
          <iframe
            srcdoc={html()!}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
        </div>
      </Show>
    </div>
  );
}

// ─── Installed tab ────────────────────────────────────────────────────────────

interface InstalledEntry {
  key: string;
  displayName: string;
  item: MarketplaceItem | null;
  slug: string | null;
  installState: InstallState;
}

function InstalledTab(props: {
  marketplaceItems: MarketplaceItem[];
  installedLayouts: string[];
  installedSounds: InstalledSound[];
  installStates: Record<string, InstallState>;
  loading: boolean;
  onInstall: (item: MarketplaceItem) => void;
  onUninstallBySlug: (type: "ui" | "sound", slug: string) => void;
}) {
  const mpBySlug = () => new Map(props.marketplaceItems.map((i) => [i.slug, i]));

  const uiEntries = (): InstalledEntry[] => {
    const bySlug = mpBySlug();
    const states = props.installStates;
    return props.installedLayouts
      .filter((name) => {
        const s = states[name];
        return !s || s.state !== "idle";
      })
      .map((name) => ({
        key: name,
        displayName: bySlug.get(name)?.name ?? name,
        item: bySlug.get(name) ?? null,
        slug: name in states ? name : null,
        installState: states[name] ?? { state: "installed" },
      }));
  };

  const soundEntries = (): InstalledEntry[] => {
    const bySlug = mpBySlug();
    const states = props.installStates;
    return props.installedSounds
      .filter((s) => {
        if (!s.slug) return true;
        const st = states[s.slug];
        return !st || st.state !== "idle";
      })
      .map((s) => ({
        key: s.filename,
        displayName: bySlug.get(s.slug)?.name ?? s.filename,
        item: bySlug.get(s.slug) ?? null,
        slug: s.slug || null,
        installState: (s.slug ? states[s.slug] : null) ?? { state: "installed" },
      }));
  };

  const hasAnything = () => uiEntries().length > 0 || soundEntries().length > 0;

  return (
    <Show
      when={!props.loading}
      fallback={
        <div class="flex items-center justify-center h-40 text-[hsl(var(--muted-foreground))]">
          <IconLoaderCircle class="w-4 h-4 animate-spin" />
        </div>
      }
    >
      <Show
        when={hasAnything()}
        fallback={
          <div class="flex items-center justify-center h-40 text-[10px] font-mono text-[hsl(var(--muted-foreground)/0.6)]">
            Nothing installed.
          </div>
        }
      >
        <div class="flex flex-col gap-5">
          <Show when={uiEntries().length > 0}>
            <section class="flex flex-col gap-2">
              <span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">UIs</span>
              <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">
                <For each={uiEntries()}>
                  {(e) => {
                    const mpItem = e.item;
                    return (
                      <InstalledItemCard
                        name={e.displayName}
                        item={mpItem}
                        installState={e.installState}
                        onInstall={mpItem ? () => props.onInstall(mpItem) : undefined}
                        onDelete={e.slug ? () => props.onUninstallBySlug("ui", e.slug as string) : undefined}
                      />
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>

          <Show when={soundEntries().length > 0}>
            <section class="flex flex-col gap-2">
              <span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">Sounds</span>
              <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">
                <For each={soundEntries()}>
                  {(e) => {
                    const mpItem = e.item;
                    return (
                      <InstalledItemCard
                        name={e.displayName}
                        item={mpItem}
                        installState={e.installState}
                        onInstall={mpItem ? () => props.onInstall(mpItem) : undefined}
                        onDelete={e.slug ? () => props.onUninstallBySlug("sound", e.slug as string) : undefined}
                      />
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

// ─── Installed item card (no preview button — previewing installed items isn't useful) ──

function InstalledItemCard(props: {
  name: string;
  item: MarketplaceItem | null;
  installState: InstallState;
  onInstall?: () => void;
  onDelete?: () => void;
}) {
  const s = () => props.installState;
  const busy = () => s().state === "installing" || s().state === "uninstalling";

  return (
    <div class="flex flex-col gap-2 p-2 rounded border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--background)/0.4)]">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <span class="text-[11px] font-mono font-semibold text-[hsl(var(--foreground))] truncate">
            {props.name}
          </span>
          <Show when={props.item}>
            {(item) => (
              <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.7)] truncate">
                by {item().creator_name}{item().current_version ? ` · v${item().current_version}` : ""}
              </span>
            )}
          </Show>
        </div>
        <Show when={props.item?.size_bytes}>
          {(size) => (
            <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)] shrink-0">
              {formatBytes(size())}
            </span>
          )}
        </Show>
      </div>

      <Show when={props.item?.description}>
        {(desc) => (
          <p class="text-[9px] font-mono text-[hsl(var(--muted-foreground))] line-clamp-2">{desc()}</p>
        )}
      </Show>

      <div class="flex items-center justify-between mt-auto gap-1">
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
          {props.item ? `${props.item.downloads} installs` : ""}
        </span>
        <div class="flex items-center gap-1">
          <Show when={props.onDelete}>
            {(onDelete) => (
              <button
                class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
                classList={{
                  "bg-destructive/20 text-destructive hover:bg-destructive/30": s().state !== "uninstalling",
                  "bg-secondary/60 text-muted-foreground": s().state === "uninstalling",
                }}
                disabled={busy()}
                onClick={onDelete}
                title="Delete from server"
              >
                <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                  <IconLoaderCircle class="w-3 h-3 animate-spin" />
                </Show>
                <Show when={s().state === "uninstalling"}>Deleting…</Show>
              </button>
            )}
          </Show>
          <Show when={props.onInstall}>
            {(onInstall) => (
              <button
                class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors bg-green-600/80 text-white hover:bg-green-600/90"
                disabled={busy()}
                onClick={onInstall}
              >
                <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
                  <IconLoaderCircle class="w-3 h-3 animate-spin" />
                </Show>
                {s().state === "installing" ? "Installing…" : "Reinstall"}
              </button>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

// ─── Browse tab item card ─────────────────────────────────────────────────────

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
  onUninstall: () => void;
  onPreview: () => void;
}) {
  const s = () => props.installState;
  const busy = () => s().state === "installing" || s().state === "uninstalling";
  const isInstalled = () => s().state === "installed";

  const installLabel = () => {
    const st = s();
    if (st.state === "installing") return "Installing…";
    if (st.state === "installed") return "Reinstall";
    if (st.state === "done" && !st.ok) return "Retry";
    return "Install";
  };

  const installTone = () => {
    const st = s();
    if (st.state === "installing") return "neutral" as const;
    if (st.state === "installed") return "success" as const;
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
            by {props.item.creator_name}{props.item.current_version ? ` · v${props.item.current_version}` : ""}
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

      <div class="flex items-center justify-between mt-auto gap-1">
        <span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)]">
          {props.item.downloads} installs
        </span>

        <div class="flex items-center gap-1">
          {/* Preview button */}
          <button
            class="flex items-center justify-center w-6 h-6 rounded text-[hsl(var(--muted-foreground)/0.7)] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--secondary))] transition-colors"
            onClick={props.onPreview}
            title={props.item.type === "sound" ? "Play preview" : "Show preview"}
          >
            <Show when={props.item.type === "sound"} fallback={<IconEye class="w-3 h-3" />}>
              <IconPlay class="w-3 h-3 ml-px" />
            </Show>
          </button>

          {/* Delete button */}
          <Show when={isInstalled() || s().state === "uninstalling"}>
            <button
              class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
              classList={{
                "bg-destructive/20 text-destructive hover:bg-destructive/30": s().state !== "uninstalling",
                "bg-secondary/60 text-muted-foreground": s().state === "uninstalling",
              }}
              disabled={busy()}
              onClick={props.onUninstall}
              title="Delete from server"
            >
              <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                <IconLoaderCircle class="w-3 h-3 animate-spin" />
              </Show>
              <Show when={s().state === "uninstalling"}>Deleting…</Show>
            </button>
          </Show>

          {/* Install / Reinstall button */}
          <button
            class="flex items-center gap-1 px-2 py-1 text-[9px] font-mono rounded transition-colors"
            classList={{
              "bg-primary text-primary-foreground hover:bg-primary/90": installTone() === "primary",
              "bg-secondary/60 text-muted-foreground": installTone() === "neutral",
              "bg-green-600/80 text-white hover:bg-green-600/90": installTone() === "success",
              "bg-destructive text-destructive-foreground hover:bg-destructive/90": installTone() === "error",
            }}
            disabled={busy()}
            onClick={props.onInstall}
            title={s().state === "done" && !s().ok ? (s() as { error?: string }).error : undefined}
          >
            <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </button>
        </div>
      </div>
    </div>
  );
}
