import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconDownload from "~icons/lucide/download";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPause from "~icons/lucide/pause";
import IconPlay from "~icons/lucide/play";
import { buildHudPreviewScript } from "../../hud-preview-script";
import { NuiButton } from "../../nui-kit/NuiButton";
import { DeleteFromServer } from "./DeleteFromServer";
import { cardIdentity } from "../card-model";
import {
  BUILTIN_EXPLANATION,
  canInstall,
  canUninstall,
  INSTALL_ACTION_LABEL,
  installAction,
  isBuiltin,
  isInstallBusy,
} from "../install-machine";
import { marketplaceThemeDefinition, previewMarketplaceHtml } from "./browse";
import { InstallError } from "./InstallError";
import { PanelPreviewFrame } from "./PanelPreviewFrame";
import {
  fitScale,
  injectBeforeBodyEnd,
  type PanelThemeDefinition,
  PREVIEW_FRAME_ATTRS,
  PREVIEW_FRAME_STYLE,
  parsePreviewCanvasSize,
  previewBoxStyle,
  previewKind,
  resolvePreviewState,
  toPanelPreviewTheme,
} from "./preview-frame";
import { fmtTime, formatBytes, type InstallState, type MarketplaceItem } from "./types";

/**
 * The name to show, through `card-model`'s empty-name fallback. Three places in this file
 * render it, two as a11y strings (screenshot `alt`, frame `title`) — a no-name listing
 * used to give a screen reader `" preview"` with nothing in front of it.
 */
const displayName = (item: MarketplaceItem) => cardIdentity(item).name;

/**
 * One waveform bar's height, as a fraction of the 0..1 viewBox. Clamped at the top: an
 * out-of-range `preview_waveform` peak (it's server-normalised but arrives through
 * `numArray`, which keeps any finite number) gave `y = (1 - h) / 2` a negative value and
 * drew the bar outside the viewBox with no error. The floor keeps a silent sample a visible
 * tick. Both bar passes (unplayed grey, clipped accent) share this call on purpose.
 */
const barHeight = (peak: number) => Math.min(1, Math.max(0.04, peak * 0.9));

export function PreviewOverlay(props: {
  item: MarketplaceItem;
  baseUrl: string;
  installState: InstallState;
  onClose: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  previewFn?: string | null;
  previewState?: Record<string, unknown> | null;
  /**
   * Where this host serves tRadio's offline dispatch panel, for a `theme` item.
   * Absent is the honest state for a consumer that is not tRadio — see
   * `previewKind`'s `panelPreview`.
   */
  panelPreviewUrl?: string | null;
}) {
  const s = () => props.installState;
  // These three read through `../install-machine` rather than reimplementing the union —
  // this block was a verbatim copy of `ItemCard.tsx`'s, and that drift is what put a
  // Delete button on a shipped layout in the first place.
  const busy = () => isInstallBusy(s());
  const removable = () => canUninstall(s());
  const builtin = () => isBuiltin(s());
  const installLabel = () => INSTALL_ACTION_LABEL[installAction(s())];

  return (
    <div class="mp-preview absolute inset-0 flex flex-col p-3 gap-2">
      <div class="mp-preview-header">
        <NuiButton class="mp-action" onClick={props.onClose}>
          <IconChevronLeft class="w-3 h-3" />
          Back
        </NuiButton>
        <span class="mp-sep w-px h-3 shrink-0" />
        <span class="text-sm font-semibold mp-fg truncate">{displayName(props.item)}</span>
        <Show when={props.item.creator_name}>
          <span class="text-sm mp-muted truncate shrink-0">by {props.item.creator_name}</span>
        </Show>
        <div class="flex-1" />
        <div class="flex items-center gap-1 shrink-0">
          <Show when={removable()}>
            <DeleteFromServer
              disabled={busy()}
              uninstalling={s().state === "uninstalling"}
              onConfirm={() => props.onUninstall?.()}
            />
          </Show>
          {/* See the note on the same button in `ItemCard.tsx`: built-in stays a disabled
              "Built in" rather than disappearing. */}
          <NuiButton
            class="mp-action"
            tone={s().state === "installed" || builtin() ? "default" : "primary"}
            disabled={!canInstall(s())}
            aria-busy={busy() ? "true" : "false"}
            onClick={builtin() ? undefined : props.onInstall}
            title={builtin() ? BUILTIN_EXPLANATION : undefined}
          >
            <Show
              when={s().state === "installing"}
              fallback={
                <Show when={!builtin()}>
                  <IconDownload class="w-3 h-3" />
                </Show>
              }
            >
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </NuiButton>
        </div>
      </div>

      <InstallError state={s()} />

      {/* One branch per kind: sound is heard, theme is seen as colour, else rendered HTML.
          Used to be a two-way Show (sound, else HTML frame), so a theme item was asked for
          a preview document it doesn't have and fell to "Preview unavailable" — the data
          (`preview_colors`, `thumbnail`, theme-only per `../item.ts`) was already there. */}
      <div class="flex-1 min-h-0">
        <Switch
          fallback={
            <UiPreviewFrame
              item={props.item}
              baseUrl={props.baseUrl}
              previewFn={props.previewFn}
              previewState={props.previewState}
            />
          }
        >
          <Match when={props.item.type === "sound"}>
            <AudioPreviewPlayer item={props.item} baseUrl={props.baseUrl} />
          </Match>
          <Match when={props.item.type === "theme"}>
            <ThemePreview item={props.item} panelPreviewUrl={props.panelPreviewUrl} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

type AudioPlayerState = "idle" | "loading" | "ready" | "error";

/**
 * The sound preview, as an `<audio>` element. Used to `fetch` + decode via Web Audio, which
 * CEF's `cfx-nui-tLib` origin can't do against a host sending no `Access-Control-Allow-Origin`
 * — an element load is exempt from that CORS check. The waveform was already drawn from
 * `preview_waveform` peaks, not the decoded buffer, so this needed no round trip through the
 * game server. Do not set `crossOrigin` — it opts back into the CORS check and breaks this.
 */
function AudioPreviewPlayer(props: { item: MarketplaceItem; baseUrl: string }) {
  const [audioState, setAudioState] = createSignal<AudioPlayerState>("idle");
  const [playing, setPlaying] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);
  const [duration, setDuration] = createSignal(0);

  let audio!: HTMLAudioElement;
  let raf = 0;

  // v2 listings carry an absolute `preview_url`. The v1 fallback is for a
  // listing that predates it; as an element load it is exempt from CORS too.
  const src = () =>
    props.item.preview_url ||
    `${props.baseUrl}/api/v1/items/${encodeURIComponent(props.item.slug)}/download?preview=1`;

  // `timeupdate` only fires about four times a second, which visibly steps the
  // waveform. Reading the element's own clock on a frame keeps it smooth.
  function tick() {
    setElapsed(audio.currentTime);
    raf = requestAnimationFrame(tick);
  }
  function stopTick() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function seek(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const offset = fraction * duration();
    if (!Number.isFinite(offset)) return;
    audio.currentTime = offset;
    setElapsed(offset);
  }

  function onPlayPause() {
    if (audioState() === "loading") return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audioState() === "error") {
      // A failed load leaves the element latched on its error; reloading is
      // what makes the retry button actually retry.
      setAudioState("idle");
      audio.load();
    }
    if (audioState() === "idle") setAudioState("loading");
    audio.play().catch(() => setAudioState("error"));
  }

  onCleanup(() => {
    stopTick();
    audio.pause();
  });

  const progress = () => (duration() > 0 ? elapsed() / duration() : 0);
  const isLoading = () => audioState() === "loading";
  const hasError = () => audioState() === "error";

  return (
    <div class="flex flex-col items-center justify-center h-full gap-4">
      {/* Nothing is fetched until the user presses play, which is what the
          old load-on-demand did. No `crossOrigin` — see this component's note. */}
      {/* biome-ignore lint/a11y/useMediaCaption: there is no dialogue to caption —
          these are siren tones and radio effects, and the marketplace has no
          field to author a track in. The item's name and waveform are the
          non-audio representation. */}
      <audio
        ref={audio!}
        src={src()}
        preload="none"
        onLoadedMetadata={() => {
          setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
          setAudioState("ready");
        }}
        onWaiting={() => setAudioState((s) => (s === "error" ? s : "loading"))}
        onPlaying={() => {
          setAudioState("ready");
          setPlaying(true);
          if (!raf) tick();
        }}
        onPause={() => {
          setPlaying(false);
          stopTick();
          setElapsed(audio.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          stopTick();
          setElapsed(0);
          audio.currentTime = 0;
        }}
        onError={() => {
          setAudioState("error");
          setPlaying(false);
          stopTick();
        }}
      />

      {/* `size_bytes` is `num()`-normalised, so 0 means "unmeasured" as often as zero bytes —
          dropped rather than shown as a false `0B`. Same rule as `cardStatsOf`. */}
      <div class="text-sm mp-muted">
        {props.item.downloads} installs
        <Show when={props.item.size_bytes > 0}> · {formatBytes(props.item.size_bytes)}</Show>
      </div>

      <div class="flex items-center gap-3 w-full max-w-sm px-4 py-3 rounded-lg mp-audio">
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
                <div class="mp-scrub h-1 rounded-full">
                  <div
                    class="mp-scrub-fill h-full rounded-full transition-[width]"
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
                        const h = barHeight(peak);
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
                          const h = barHeight(peak);
                          const y = (1 - h) / 2;
                          return (
                            <rect
                              x={x}
                              y={y}
                              width={0.6}
                              height={h}
                              rx={0.04}
                              fill="var(--nui-accent)"
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
          <div class="flex justify-between text-sm mp-muted">
            <span>{fmtTime(elapsed())}</span>
            <Show when={duration() > 0}>
              <span>{fmtTime(duration())}</span>
            </Show>
          </div>
        </div>
      </div>

      <Show when={hasError()}>
        <span class="text-sm mp-muted">Preview unavailable for this item</span>
      </Show>
    </div>
  );
}

/**
 * A theme, shown on the dispatch panel it restyles. Used to be a screenshot over swatches
 * on the theory that a faithful render can't happen inside a preview that is also the
 * panel — false once tRadio shipped an offline panel from the same graph, since this frame
 * is `cfx-nui-tLib`, not the panel itself. `previewKind` now prefers `panel` over
 * `thumbnail`; the screenshot stays the fallback for a non-tRadio host with no panel to mount.
 */
function ThemePreview(props: { item: MarketplaceItem; panelPreviewUrl?: string | null }) {
  const [definition, setDefinition] = createSignal<PanelThemeDefinition | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [thumbFailed, setThumbFailed] = createSignal(false);
  const colors = () => props.item.preview_colors ?? [];

  // `failed` drops a theme whose definition fetch failed back to the same chain every
  // other host walks, rather than leaving an unpostable frame empty.
  const kind = createMemo(() =>
    previewKind(props.item, {
      panelPreview: !!props.panelPreviewUrl && !failed(),
      thumbFailed: thumbFailed(),
    })
  );

  // Solid 2: only `compute` tracks, so slug/URL are read there. Braces on `apply` are
  // load-bearing — a bare setter-call return is taken for a cleanup function and takes
  // the reactive graph down with it.
  createEffect(
    () => (props.panelPreviewUrl ? props.item.slug : null),
    (slug) => {
      if (!slug) return;
      let cancelled = false;
      marketplaceThemeDefinition(slug).then(
        (value) => {
          if (!cancelled) setDefinition(value);
        },
        // Drops to swatches rather than an error — the palette is still a true answer.
        () => {
          if (!cancelled) setFailed(true);
        }
      );
      return () => {
        cancelled = true;
      };
    }
  );

  const theme = createMemo(() => {
    const value = definition();
    return value ? toPanelPreviewTheme(props.item.slug, value, displayName(props.item)) : null;
  });

  return (
    <div class="w-full h-full flex flex-col items-center justify-center gap-3 bg-black rounded overflow-hidden p-3">
      <Switch>
        <Match when={kind() === "panel"}>
          <Show
            when={theme()}
            fallback={
              <span class="inline-flex items-center gap-2 text-sm mp-muted">
                <IconLoaderCircle class="w-4 h-4 animate-spin" />
                Loading preview…
              </span>
            }
          >
            {(value) => (
              <PanelPreviewFrame
                // biome-ignore lint/style/noNonNullAssertion: kind() is "panel" only with a URL
                src={props.panelPreviewUrl!}
                theme={value()}
                title={`${displayName(props.item)} preview`}
              />
            )}
          </Show>
        </Match>

        <Match when={kind() === "thumbnail"}>
          <img
            // biome-ignore lint/style/noNonNullAssertion: previewKind returns "thumbnail" only with a thumbnail
            src={props.item.thumbnail!}
            alt={`${displayName(props.item)} preview`}
            class="max-w-full min-h-0 flex-1 object-contain rounded"
            // A dead screenshot URL falls through to swatches, not a broken-image glyph.
            onError={() => setThumbFailed(true)}
          />
        </Match>

        <Match when={kind() === "swatches"}>
          <div class="w-full h-12 shrink-0 flex rounded overflow-hidden">
            <For each={colors()}>
              {(color) => <div class="flex-1 h-full" style={{ background: color }} title={color} />}
            </For>
          </div>
        </Match>

        <Match when={kind() === "none"}>
          <span class="text-sm mp-muted">Preview unavailable</span>
        </Match>
      </Switch>
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
  /**
   * The reason (not a boolean) plus a retry. Was `createSignal(false)` + a bare
   * "Preview unavailable", discarding the broker's person-worded reason
   * (`request_timed_out`, `preview_too_large`, `http_404`) — the first of which a
   * second press fixes, and without this the only retry path was Back + re-find + re-press,
   * which also lost the grid's scroll position.
   */
  const [loadError, setLoadError] = createSignal<string | null>(null);

  /**
   * Whether the frame finished, not whether the string arrived — `html()` only means the
   * document crossed the NUI boundary; the iframe still has to parse and decode images,
   * measured at 44-97ms for tRadio's heads and 440ms for tls-wcc (Chromium 103, CEF's
   * pinned version; 85-95% of that is image decode). Gating on `html()` alone swapped
   * "Loading…" for an empty black box for that whole span. `load` fires after decode.
   */
  const [frameReady, setFrameReady] = createSignal(false);

  /**
   * A new document means waiting again. The braces are load-bearing: `createEffect(compute,
   * apply)` treats `apply`'s return value as a cleanup function, and a Solid setter returns
   * the value it just set — a bare `() => setFrameReady(false)` hands back `false` and dies
   * with `TypeError: r is not a function`, taking the whole reactive graph down.
   */
  createEffect(html, () => {
    setFrameReady(false);
  });

  let containerRef!: HTMLDivElement;
  const [containerW, setContainerW] = createSignal(700);
  const [containerH, setContainerH] = createSignal(400);

  // `onSettled` is Solid 2's `onMount`; it refuses a nested `onCleanup`, so the observer's
  // teardown is returned instead. `load()` is not awaited — its `.then` resolves after
  // this callback returns, so it never contributes to the cleanup.
  onSettled(() => {
    const ro = new ResizeObserver(() => {
      setContainerW(containerRef.clientWidth);
      setContainerH(containerRef.clientHeight);
    });
    ro.observe(containerRef);

    load();

    return () => ro.disconnect();
  });

  // The document arrives as text, brokered by `./browse.ts` — not an `<iframe src>`,
  // since a cross-origin frame can't be read/scripted by its parent and the code below
  // reads the markup. A named function so Retry has something to call; `./browse.ts`
  // drops a rejected entry, so retry genuinely re-reaches the bridge.
  function load() {
    setLoadError(null);
    previewMarketplaceHtml(props.item.slug)
      .then((text) => {
        // Relative assets resolve against the v1 preview directory (addressed by item id,
        // not slug) — element loads, so no CORS header or broker needed.
        const base = `${props.baseUrl}/api/v1/preview/${encodeURIComponent(props.item.id)}/`;
        let rewritten = text.replace(
          /(src|href)=(['"])(?!https?:|\/\/|data:|#|\/)([^'"]+)\2/gi,
          (_: string, attr: string, q: string, p: string) => `${attr}=${q}${base}${p}${q}`
        );
        const centerCss =
          "<style>html,body{margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>";
        rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${centerCss}`);
        if (!/(<head)/i.test(rewritten)) rewritten = centerCss + rewritten;

        // Two layout shapes: one with its own update function (tLS's WCC2, pre-binder
        // builds) called by name via the retry loop, and purely declarative markup
        // (every tDetector/tRadar skin — the marketplace HTML validator rejects script
        // tags) which `hud-preview-script` drives through the `data-hud-*` grammar so the
        // preview shows one working state, not every state stacked on top of itself.
        //
        // `resolvePreviewState`, not `if (state)`: `previewState` is optional end to end,
        // and only tRadio/tRadar/tDetector supply a preset — tLS supplies none, so an
        // `if (state)` check rendered every tLS layout with every `data-hud-show` element
        // visible and every readout at its placeholder text. A host preset still wins.
        const state = resolvePreviewState(props.previewState);
        const previewScript = buildHudPreviewScript(props.previewFn, state);
        // A marketplace layout is a fragment, so a naive `</body>` match usually hits
        // one inside a script or comment and ends it early — injectBeforeBodyEnd avoids that.
        rewritten = injectBeforeBodyEnd(rewritten, previewScript);

        setHtml(rewritten);
      })
      .catch((e: unknown) =>
        setLoadError(e instanceof Error && e.message ? e.message : "Preview unavailable")
      );
  }

  // Trust order: studio-design metadata, tRadio's data attributes, largest explicit CSS
  // pixel dimensions. Tiers live in `./preview-canvas`, shared with the admin panels.
  const canvasSize = createMemo(() => {
    const h = html();
    return h ? parsePreviewCanvasSize(h) : { w: 400, h: 400 };
  });

  // Same `fitScale` as tRadio's admin grid, so the two surfaces can't drift on geometry.
  // `allowUpscale` stays `false` here (a full-size overlay would just show interpolation
  // artefacts blowing up a 200px skin); the grid passes `true` since its box is smaller.
  const scale = createMemo(() => fitScale(canvasSize(), { w: containerW(), h: containerH() }));

  return (
    <div
      ref={containerRef!}
      class="relative w-full h-full flex items-center justify-center bg-black rounded overflow-hidden"
    >
      {/* Gated on `frameReady`, not the string arriving. Sits as a sibling of the frame,
          not a replacement — the frame has to be in the document to load. */}
      <Show when={!frameReady() && !loadError()}>
        <span class="absolute inline-flex items-center gap-2 text-sm mp-muted">
          <IconLoaderCircle class="w-4 h-4 animate-spin" />
          Loading preview…
        </span>
      </Show>
      <Show when={loadError()}>
        {(message) => (
          <div class="flex flex-col items-center gap-2">
            <span class="text-sm mp-muted">Preview unavailable</span>
            <span class="text-sm mp-muted">{message()}</span>
            <NuiButton class="mp-action" onClick={load}>
              Try again
            </NuiButton>
          </div>
        )}
      </Show>
      <Show when={html()}>
        {/* `overflow: hidden` + `flex-shrink: 0` is now `previewBoxStyle`, shared because
            tRadio's grid was missing both and grew scrollbars inside its previews. */}
        <div style={previewBoxStyle(canvasSize(), scale())}>
          <iframe
            title={`${displayName(props.item)} preview`}
            srcdoc={html()!}
            onLoad={() => setFrameReady(true)}
            {...PREVIEW_FRAME_ATTRS}
            style={PREVIEW_FRAME_STYLE}
          />
        </div>
      </Show>
    </div>
  );
}
