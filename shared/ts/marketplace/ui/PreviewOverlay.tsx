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
import IconTrash2 from "~icons/lucide/trash-2";
import { buildHudPreviewScript } from "../../hud-preview-script";
import { NuiButton } from "../../nui-kit/NuiButton";
import {
  BUILTIN_EXPLANATION,
  canInstall,
  canUninstall,
  INSTALL_ACTION_LABEL,
  installAction,
  isBuiltin,
  isInstallBusy,
} from "../install-machine";
import { previewMarketplaceHtml } from "./browse";
import { InstallError } from "./InstallError";
import {
  fitScale,
  PREVIEW_FRAME_ATTRS,
  PREVIEW_FRAME_STYLE,
  parsePreviewCanvasSize,
  previewBoxStyle,
  resolvePreviewState,
} from "./preview-frame";
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
  // From `../install-machine`. This block was a VERBATIM copy of the one in
  // `ItemCard.tsx` — the same union answered the same three questions twice,
  // which is exactly the shape that drifts.
  const busy = () => isInstallBusy(s());
  // `canUninstall`/`canInstall` from `../install-machine` for the same reason the
  // three booleans above moved there: this block was a VERBATIM copy of
  // `ItemCard.tsx`'s, so a built-in excluded in one file and not the other is
  // exactly the drift that put a Delete on a shipped layout in the first place.
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
        <span class="text-sm font-semibold mp-fg truncate">{props.item.name}</span>
        <Show when={props.item.creator_name}>
          <span class="text-sm mp-muted truncate shrink-0">by {props.item.creator_name}</span>
        </Show>
        <div class="flex-1" />
        <div class="flex items-center gap-1 shrink-0">
          <Show when={removable()}>
            <NuiButton
              class="mp-action mp-delete"
              aria-label="Delete from server"
              disabled={busy()}
              aria-busy={busy() ? "true" : "false"}
              onClick={props.onUninstall}
            >
              <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                <IconLoaderCircle class="w-3 h-3 animate-spin" />
              </Show>
              <Show when={s().state === "uninstalling"}>Deleting…</Show>
            </NuiButton>
          </Show>
          {/* See the long note on the same button in `ItemCard.tsx`: a built-in
              keeps a disabled "Built in" rather than disappearing, because the
              preview of a shipped radio with no control and no sentence is the
              same confusion one step quieter. */}
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

      {/*
        One branch per KIND of thing the marketplace sells, because each is a
        different sense: a sound is heard, a theme is seen as colour, a layout is a
        rendered device.

        This used to be a two-way `Show` — sound, else the HTML frame — which meant a
        `theme` item was asked for a preview document it does not have and landed on
        "Preview unavailable". The data was already here: `preview_colors` and
        `thumbnail` ride on every theme listing (see `../item.ts`, where both are
        documented as theme-only), and this overlay simply never read them. The buyer
        was therefore installing a colour scheme sight-unseen.
      */}
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
            <ThemePreview item={props.item} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

type AudioPlayerState = "idle" | "loading" | "ready" | "error";

/**
 * The sound preview, as an `<audio>` element.
 *
 * It used to `fetch` the bytes and decode them through Web Audio, which could
 * not work from here: CEF's origin is `cfx-nui-tLib`, the marketplace host
 * sends no `Access-Control-Allow-Origin`, and so the browser refused to hand
 * this page the body. Being a public, read-only endpoint is not what makes a
 * response readable cross-origin — the header is.
 *
 * An element load is exempt from that rule entirely, which is why this one
 * fix is a deletion rather than a round trip through the game server. The
 * waveform never needed the decoded buffer anyway: it is drawn from the
 * `preview_waveform` peaks the listing already carries, and the only things
 * the AudioBuffer supplied were `duration` and a playback clock, both of which
 * the element exposes directly.
 *
 * Do NOT set `crossOrigin` on the element. That opts the load back in to
 * the CORS check this is deliberately outside of, and the preview breaks again.
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

      <div class="text-sm mp-muted">
        {props.item.downloads} installs · {formatBytes(props.item.size_bytes)}
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
 * A theme, shown as what a theme actually is: its palette, plus the creator's
 * screenshot when they supplied one.
 *
 * There is no rendered-preview path here and there deliberately is not one. A theme
 * is CSS variables applied to the WHOLE panel; the only faithful render is the panel
 * itself restyled, which cannot happen inside a preview that is also the panel. The
 * swatch row is the honest reduction — it is the same reduction tRadio's admin
 * marketplace card already makes, and it is what the backend projects `preview_colors`
 * for.
 *
 * Both fields are optional on the wire, and `../item.ts` is explicit that an optional
 * field is OMITTED rather than set to `undefined` precisely so a presence check like
 * the ones below means what it says. A theme carrying neither falls through to the
 * same "Preview unavailable" line every other empty preview shows, rather than to a
 * blank swatch row that looks like a rendered result.
 */
function ThemePreview(props: { item: MarketplaceItem }) {
  const [thumbFailed, setThumbFailed] = createSignal(false);
  const colors = () => props.item.preview_colors ?? [];
  const thumb = () => (thumbFailed() ? undefined : props.item.thumbnail);
  const hasAnything = () => !!thumb() || colors().length > 0;

  return (
    <div class="w-full h-full flex flex-col items-center justify-center gap-3 bg-black rounded overflow-hidden p-3">
      <Show when={!hasAnything()}>
        <span class="text-sm mp-muted">Preview unavailable</span>
      </Show>

      <Show when={thumb()}>
        {(src) => (
          <img
            src={src()}
            alt={`${props.item.name} preview`}
            class="max-w-full min-h-0 flex-1 object-contain rounded"
            // A dead screenshot URL must not take the palette down with it: drop to
            // the swatches rather than leaving a broken-image glyph as the preview.
            onError={() => setThumbFailed(true)}
          />
        )}
      </Show>

      <Show when={colors().length > 0}>
        <div class="w-full h-12 shrink-0 flex rounded overflow-hidden">
          <For each={colors()}>
            {(color) => <div class="flex-1 h-full" style={{ background: color }} title={color} />}
          </For>
        </div>
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

  /**
   * Has the FRAME finished, as opposed to has the string arrived?
   *
   * These are not the same moment, and the gap between them is the lag players
   * actually report. `html()` being set only means the document crossed the NUI
   * boundary; the iframe then has to parse it and decode its images, which is
   * measured at 44–97 ms for tRadio's heads and 440 ms for tels-wcc in the
   * pinned Chromium 103 that CEF is — longer on a low-end machine, and that
   * figure is 85–95% image decode. Gating the indicator on `html()` alone
   * therefore swapped "Loading…" for an EMPTY BLACK BOX for the entire
   * expensive part, which reads as a freeze rather than as progress.
   *
   * The `load` event is the right signal because it fires after subresource
   * decode, not merely after parse.
   */
  const [frameReady, setFrameReady] = createSignal(false);

  /**
   * A new document means we are waiting again.
   *
   * The braces are load-bearing. `createEffect(compute, apply)` treats
   * `apply`'s RETURN VALUE as a cleanup function, and a Solid setter returns
   * the value it just set — so `() => setFrameReady(false)` hands the effect
   * `false` and dies with `TypeError: r is not a function`, taking the whole
   * reactive graph down with it. Only `compute` tracks, which is why the read
   * of `html()` is up there and not in the body.
   */
  createEffect(html, () => {
    setFrameReady(false);
  });

  let containerRef!: HTMLDivElement;
  const [containerW, setContainerW] = createSignal(700);
  const [containerH, setContainerH] = createSignal(400);

  // `onSettled` is Solid 2's `onMount`. The observer's teardown is RETURNED at
  // the bottom rather than registered with a nested `onCleanup`, which
  // `onSettled` refuses outright. The fetch below is deliberately NOT awaited
  // here — its `.then` resolves after this callback has returned, so it cannot
  // contribute to the cleanup and never did.
  onSettled(() => {
    const ro = new ResizeObserver(() => {
      setContainerW(containerRef.clientWidth);
      setContainerH(containerRef.clientHeight);
    });
    ro.observe(containerRef);

    // The document arrives as TEXT, brokered by the game server — see
    // `./browse.ts`. It cannot simply be an `<iframe src>`: everything below
    // this line reads the markup, and a cross-origin frame cannot be read or
    // scripted by its parent.
    previewMarketplaceHtml(props.item.slug)
      .then((text) => {
        // Relative assets inside the document still resolve against the v1
        // preview directory, which is where they are actually served from and
        // is addressed by item id, not slug. Those are element loads, so they
        // need no header and no broker.
        const base = `${props.baseUrl}/api/v1/preview/${encodeURIComponent(props.item.id)}/`;
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
        /**
         * `resolvePreviewState` and NOT `if (state)`, which is the fix for the
         * reported blank previews.
         *
         * `previewState` is optional all the way down and the binder used to be
         * injected only when a host supplied one — so "this host has no preset"
         * and "render this layout unbound" were the same code path. Surveyed
         * 2026-10-07, exactly three resources supply a preset, each as a
         * hand-written Lua table: tRadio (`cl_bridge.lua`'s
         * `MARKETPLACE_PREVIEW_STATE`), tRadar and tDetector. **tELS supplies
         * none**, so every tELS layout previewed here rendered with every
         * `data-hud-show` element visible at once and every readout left at
         * whatever placeholder its author typed.
         *
         * A resource's own preset still wins, and should — tRadio derives one
         * through `deriveBinderState` + `RADIO_PREVIEW_SCENARIOS`, which can only
         * express states the engine can actually produce. This is what a surface
         * gets when it has nothing, instead of a dead device.
         */
        const state = resolvePreviewState(props.previewState);
        const previewScript = buildHudPreviewScript(props.previewFn, state);
        rewritten = rewritten.replace(/<\/body>/i, `${previewScript}</body>`);
        if (!/<\/body>/i.test(rewritten)) rewritten += previewScript;

        setHtml(rewritten);
      })
      .catch(() => setLoadError(true));

    return () => ro.disconnect();
  });

  // Canvas size, in descending order of trust: studio-design metadata, tRadio's
  // data attributes, then the largest explicit pixel dimensions in the CSS. The
  // tiers live in `./preview-canvas` so the admin panels can share them instead of
  // re-deriving a weaker version — see that file for why each tier is where it is.
  const canvasSize = createMemo(() => {
    const h = html();
    return h ? parsePreviewCanvasSize(h) : { w: 400, h: 400 };
  });

  // The same `fitScale` tRadio's admin grid uses, so the two surfaces cannot
  // drift on the geometry again. `allowUpscale` is left at its default `false`
  // here: this is a full-size overlay, and blowing a 200px skin up to fill a
  // 1080p dialog shows nothing but interpolation artefacts. The grid passes
  // `true`, because its box is smaller than most canvases — the two call sites
  // genuinely want different answers, which is why it is a parameter.
  const scale = createMemo(() => fitScale(canvasSize(), { w: containerW(), h: containerH() }));

  return (
    <div
      ref={containerRef!}
      class="relative w-full h-full flex items-center justify-center bg-black rounded overflow-hidden"
    >
      {/* Shown until the FRAME is ready, not until the string arrives — see
          `frameReady`. It sits as a sibling of the frame rather than replacing
          it, because the frame has to be in the document to load at all. */}
      <Show when={!frameReady() && !loadError()}>
        <span class="absolute inline-flex items-center gap-2 text-sm mp-muted">
          <IconLoaderCircle class="w-4 h-4 animate-spin" />
          Loading preview…
        </span>
      </Show>
      <Show when={loadError()}>
        <span class="text-sm mp-muted">Preview unavailable</span>
      </Show>
      <Show when={html()}>
        {/* The `overflow: hidden` + `flex-shrink: 0` pair this file already had
            is now `previewBoxStyle`, because tRadio's grid was missing both and
            therefore grew scrollbars inside its previews where this surface
            never did. Shared so that cannot recur. */}
        <div style={previewBoxStyle(canvasSize(), scale())}>
          <iframe
            title={`${props.item.name} preview`}
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
