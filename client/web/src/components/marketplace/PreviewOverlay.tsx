import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconDownload from "~icons/lucide/download";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { buildHudPreviewScript } from "../../../../../shared/ts/hud-preview-script";
import { NuiButton } from "../ui/nui-field";
import { InstallError } from "./InstallError";
import { fmtTime, formatBytes, type InstallState, type MarketplaceItem } from "./types";

export function PreviewOverlay(props: {
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
    <div class="mp-preview absolute inset-0 flex flex-col p-3 gap-2">
      <div class="mp-preview-header">
        <NuiButton class="mp-action" onClick={props.onClose}>
          <IconChevronLeft class="w-3 h-3" />
          Back
        </NuiButton>
        <span class="w-px h-3 bg-[hsl(var(--border)/0.6)] shrink-0" />
        <span class="text-sm font-semibold text-[hsl(var(--foreground))] truncate">
          {props.item.name}
        </span>
        <Show when={props.item.creator_name}>
          <span class="text-sm text-[hsl(var(--muted-foreground))] truncate shrink-0">
            by {props.item.creator_name}
          </span>
        </Show>
        <div class="flex-1" />
        <div class="flex items-center gap-1 shrink-0">
          <Show when={isInstalled() || s().state === "uninstalling"}>
            <NuiButton
              class="mp-action mp-delete"
              aria-label="Delete from server"
              disabled={busy()}
              aria-busy={busy()}
              onClick={props.onUninstall}
            >
              <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                <IconLoaderCircle class="w-3 h-3 animate-spin" />
              </Show>
              <Show when={s().state === "uninstalling"}>Deleting…</Show>
            </NuiButton>
          </Show>
          <NuiButton
            class="mp-action"
            tone={s().state === "installed" ? "default" : "primary"}
            disabled={busy()}
            aria-busy={busy()}
            onClick={props.onInstall}
          >
            <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </NuiButton>
        </div>
      </div>

      <InstallError state={s()} />

      <div class="flex-1 min-h-0">
        <Show
          when={props.item.type === "sound"}
          fallback={
            <UiPreviewFrame
              item={props.item}
              baseUrl={props.baseUrl}
              previewFn={props.previewFn}
              previewState={props.previewState}
            />
          }
        >
          <AudioPreviewPlayer item={props.item} baseUrl={props.baseUrl} />
        </Show>
      </div>
    </div>
  );
}

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
      const url = `${props.baseUrl}/api/v1/items/${encodeURIComponent(props.item.slug)}/download?preview=1`;
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
    if (wasPlaying) {
      source?.stop();
      source = null;
      cancelAnimationFrame(raf);
    }
    pausedAt = offset;
    setElapsed(offset);
    if (wasPlaying) {
      startSource(offset);
      tick();
    }
  }

  function onPlayPause() {
    const s = audioState();
    if (s.kind === "idle" || s.kind === "error") {
      void loadAndPlay();
      return;
    }
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
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    void ctx?.close();
  });

  const progress = () => (duration() > 0 ? elapsed() / duration() : 0);
  const isLoading = () => audioState().kind === "loading";
  const hasError = () => audioState().kind === "error";

  return (
    <div class="flex flex-col items-center justify-center h-full gap-4">
      <div class="text-sm text-[hsl(var(--muted-foreground))]">
        {props.item.downloads} installs · {formatBytes(props.item.size_bytes)}
      </div>

      <div class="flex items-center gap-3 w-full max-w-sm px-4 py-3 rounded-lg border border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.3)]">
        <NuiButton
          class="mp-action"
          aria-label={hasError() ? "Retry audio preview" : playing() ? "Pause" : "Play"}
          onClick={onPlayPause}
          disabled={isLoading()}
          title={hasError() ? "Preview unavailable — click to retry" : playing() ? "Pause" : "Play"}
        >
          <Show
            when={isLoading()}
            fallback={
              <Show when={playing()} fallback={<IconPlay class="w-3.5 h-3.5 ml-0.5" />}>
                <IconPause class="w-3.5 h-3.5" />
              </Show>
            }
          >
            <IconLoaderCircle class="w-3.5 h-3.5 animate-spin" />
          </Show>
        </NuiButton>

        <div class="flex-1 min-w-0">
          <div class="mb-1.5 cursor-pointer" onClick={seek}>
            <Show
              when={props.item.preview_waveform?.length ? props.item.preview_waveform : undefined}
              keyed
              fallback={
                <div class="h-1 rounded-full bg-[hsl(var(--border)/0.8)]">
                  <div
                    class="h-full rounded-full bg-[hsl(var(--primary))] transition-[width]"
                    style={{ width: `${(progress() * 100).toFixed(1)}%` }}
                  />
                </div>
              }
            >
              {(peaks) => {
                const n = peaks.length;
                return (
                  <svg
                    viewBox={`0 0 ${n} 1`}
                    preserveAspectRatio="none"
                    style={{ height: "32px", width: "100%", display: "block" }}
                  >
                    <defs>
                      <clipPath id="mp-wf-played">
                        <rect x="0" y="0" width={n * progress()} height="1" />
                      </clipPath>
                    </defs>
                    <For each={peaks}>
                      {(peak, i) => {
                        const x = i() + 0.2;
                        const h = Math.max(0.04, peak * 0.9);
                        const y = (1 - h) / 2;
                        return (
                          <rect
                            x={x}
                            y={y}
                            width={0.6}
                            height={h}
                            rx={0.04}
                            fill="rgba(255,255,255,0.12)"
                          />
                        );
                      }}
                    </For>
                    <g clip-path="url(#mp-wf-played)">
                      <For each={peaks}>
                        {(peak, i) => {
                          const x = i() + 0.2;
                          const h = Math.max(0.04, peak * 0.9);
                          const y = (1 - h) / 2;
                          return (
                            <rect
                              x={x}
                              y={y}
                              width={0.6}
                              height={h}
                              rx={0.04}
                              fill="hsl(var(--primary))"
                            />
                          );
                        }}
                      </For>
                    </g>
                  </svg>
                );
              }}
            </Show>
          </div>
          <div class="flex justify-between text-sm text-[hsl(var(--muted-foreground))]">
            <span>{fmtTime(elapsed())}</span>
            <Show when={duration() > 0}>
              <span>{fmtTime(duration())}</span>
            </Show>
          </div>
        </div>
      </div>

      <Show when={hasError()}>
        <span class="text-sm text-[hsl(var(--muted-foreground))]">
          Preview unavailable for this item
        </span>
      </Show>
    </div>
  );
}

function UiPreviewFrame(props: {
  item: MarketplaceItem;
  baseUrl: string;
  previewFn?: string | null;
  previewState?: Record<string, unknown> | null;
}) {
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

    const url = `${props.baseUrl}/api/v1/preview/${encodeURIComponent(props.item.id)}/ui.html`;
    fetch(url, { headers: { Accept: "text/html" } })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.text();
      })
      .then((text) => {
        const base = url.replace(/[^/]+$/, "");
        let rewritten = text.replace(
          /(src|href)=(['"])(?!https?:|\/\/|data:|#|\/)([^'"]+)\2/gi,
          (_: string, attr: string, q: string, p: string) => `${attr}=${q}${base}${p}${q}`
        );
        const centerCss =
          "<style>html,body{margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>";
        rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${centerCss}`);
        if (!/(<head)/i.test(rewritten)) rewritten = centerCss + rewritten;

        // Dummy state, so the layout renders non-empty.
        //
        // Two shapes of layout have to be covered. A layout that ships its own
        // update function (tELS's WCC2, and anything built before the binder)
        // gets that function called by name — the retry loop is for one that
        // registers asynchronously. A purely declarative layout has no script
        // at all, by design: every tDetector and tRadar skin is markup only,
        // because the marketplace's HTML validator rejects script tags outright.
        // For those, `hud-preview-script` applies the full `data-hud-*` grammar
        // inside the frame, so the preview shows a working device rather than
        // every state stacked on top of each other.
        const state = props.previewState;
        if (state) {
          const previewScript = buildHudPreviewScript(props.previewFn, state);
          rewritten = rewritten.replace(/<\/body>/i, `${previewScript}</body>`);
          if (!/<\/body>/i.test(rewritten)) rewritten += previewScript;
        }

        setHtml(rewritten);
      })
      .catch(() => setLoadError(true));
  });

  // Canvas size, in descending order of trust: studio-design metadata, tRadio's
  // data attributes, then the largest explicit pixel dimensions in the CSS.
  const canvasSize = createMemo(() => {
    const h = html();
    if (!h) return { w: 400, h: 400 };

    const sdMatch = h.match(/<!--\s*studio-design:([A-Za-z0-9+/=\s]+)-->/);
    if (sdMatch) {
      try {
        const meta = JSON.parse(atob(sdMatch[1].trim())) as Record<string, unknown>;
        const w = typeof meta.width === "number" ? meta.width : 0;
        const hv = typeof meta.height === "number" ? meta.height : 0;
        if (w > 0 && hv > 0) return { w, h: hv };
      } catch {
        /* ignore */
      }
    }

    const wm = h.match(/data-radio-width="(\d+)"/);
    const hm = h.match(/data-radio-height="(\d+)"/);
    if (wm && hm) return { w: parseInt(wm[1]!, 10), h: parseInt(hm[1]!, 10) };

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
        <span class="text-sm text-[hsl(var(--muted-foreground))]">Loading…</span>
      </Show>
      <Show when={loadError()}>
        <span class="text-sm text-[hsl(var(--muted-foreground))]">Preview unavailable</span>
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
            title={`${props.item.name} preview`}
            srcdoc={html()!}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
        </div>
      </Show>
    </div>
  );
}
