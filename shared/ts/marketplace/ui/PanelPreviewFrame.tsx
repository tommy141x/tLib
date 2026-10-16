import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import {
  isPanelPreviewReady,
  PANEL_PREVIEW_CHANNEL,
  PANEL_PREVIEW_LAYOUT,
  type PanelPreviewTheme,
  previewBoxStyle,
} from "./preview-frame";

/**
 * A dispatch-panel theme, shown on the REAL dispatch panel.
 *
 * ── Why there is no drawing of a panel anywhere in here ─────────────────────
 *
 * Because a theme is not a picture. It is a set of CSS variables and — for the
 * ones that actually look different — `data-rd-*` markup that is inert until a
 * dispatch view model is pushed through it. Every surface in this estate used to
 * reduce that to a swatch strip or to the creator's screenshot, so two recolours
 * were indistinguishable and the only way to see what you were installing was to
 * install it.
 *
 * tRadio builds `preview.html` from the same graph as the shipped panel and
 * drives it over `postMessage`. This component is the embedder's half of that
 * protocol and nothing else: it owns no class names, no tokens and no icon pack,
 * same rule as `preview-frame.ts`.
 *
 * ── ⚠️ `sandbox="allow-scripts"` WITHOUT `allow-same-origin` ────────────────
 *
 * Those two together would be no sandbox at all — the frame could reach out and
 * remove its own sandbox attribute. The omission is the point: the panel must run
 * scripts, because it is a Solid app and because a theme's own `jsText` runs
 * inside it, and it must not be able to touch this document, its storage or its
 * session. The in-game NUI makes that bite harder than the web does: the embedder
 * there is `cfx-nui-tLib`, which holds the player's open admin panel.
 *
 * ── ⚠️ The frame is sized at the layout size and SCALED ─────────────────────
 *
 * Never sized to the box. `PANEL_PREVIEW_LAYOUT` is a desk monitor's worth of
 * board; letting it reflow into a 16:9 tile would collapse every column into a
 * stack of chrome that is technically the panel and visually nothing like it.
 */
export function PanelPreviewFrame(props: {
  /**
   * Where the host serves tRadio's offline panel preview. Supplied rather than
   * derived: tWeb vendors the built bundle, tRadio's admin serves it from its own
   * origin, and the NUI browser is handed a `cfx-nui-tRadio` URL by whichever
   * consumer opened it.
   */
  src: string;
  theme: PanelPreviewTheme;
  /**
   * `"cover"` fills the box and crops the overflow. The board is 1600x950 and a
   * card slot is 16:9, so `"contain"` letterboxes on every edge and the panel
   * reads as a postage stamp; cover loses about 5% off the bottom of the call
   * queue and spends every pixel on what the reader is looking at. An overlay
   * that is already large wants the whole board, so it keeps the default.
   */
  fit?: "contain" | "cover";
  title?: string;
  class?: string;
}) {
  let container!: HTMLDivElement;
  let frame: HTMLIFrameElement | undefined;

  const [box, setBox] = createSignal({ w: 0, h: 0 });
  const [ready, setReady] = createSignal(false);

  /**
   * `Math.max` for cover so the smaller axis fills and the larger overflows;
   * `Math.min` for contain. `fitScale` is deliberately not reused here: it caps
   * at 1 unless told otherwise and knows only contain, and a panel preview always
   * wants the opposite of both — the board is larger than every box it is given,
   * so there is nothing to cap, and cover is the common case.
   */
  const scale = createMemo(() => {
    const { w, h } = box();
    if (!(w > 0) || !(h > 0)) return 1;
    const byWidth = w / PANEL_PREVIEW_LAYOUT.w;
    const byHeight = h / PANEL_PREVIEW_LAYOUT.h;
    return props.fit === "cover" ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);
  });

  onSettled(() => {
    const ro = new ResizeObserver(() => {
      setBox({ w: container.clientWidth, h: container.clientHeight });
    });
    ro.observe(container);
    setBox({ w: container.clientWidth, h: container.clientHeight });

    const onMessage = (event: MessageEvent) => {
      // Window identity, never `event.origin`: an opaque-origin frame posts from
      // `"null"`, which is also what every OTHER preview on the page posts from.
      if (!frame || event.source !== frame.contentWindow) return;
      if (!isPanelPreviewReady(event.data)) return;
      setReady(true);
      post(props.theme);
    };
    window.addEventListener("message", onMessage);

    // Solid 2 refuses `onCleanup` inside `onSettled` — one returned teardown.
    return () => {
      ro.disconnect();
      window.removeEventListener("message", onMessage);
    };
  });

  function post(theme: PanelPreviewTheme): void {
    // `"*"` because an opaque origin is unaddressable. Safe: the payload is the
    // definition this surface already fetched, and it reaches only our own frame.
    frame?.contentWindow?.postMessage({ source: PANEL_PREVIEW_CHANNEL, type: "theme", theme }, "*");
  }

  /**
   * Re-push on every change, but only once the frame has said `ready`.
   *
   * There is no pending queue on purpose: the `ready` handler above sends
   * `props.theme` outright, so a frame that boots — or re-boots, which this
   * component cannot observe — gets the CURRENT theme rather than whatever a slot
   * was holding. A held copy is a second copy of state, and the copy is what goes
   * stale. Measured in tWeb as nine of thirteen tiles stuck on stock `dark`.
   *
   * Only `compute` tracks under Solid 2, so both reads are up there; the braces
   * on `apply` are load-bearing, since a returned setter result is taken for a
   * cleanup function and kills the whole reactive graph.
   */
  createEffect(
    () => (ready() ? props.theme : null),
    (theme) => {
      if (theme) post(theme);
    }
  );

  return (
    <div
      ref={container}
      class={props.class}
      style={{ position: "relative", overflow: "hidden", width: "100%", height: "100%" }}
    >
      <div style={previewBoxStyle(PANEL_PREVIEW_LAYOUT, scale(), { center: true })}>
        <iframe
          ref={frame}
          // Never reactive: a changing `src` reloads the frame, so every theme
          // change would cost a full panel boot instead of a `postMessage`.
          src={props.src}
          sandbox="allow-scripts"
          title={props.title ?? "Dispatch panel preview"}
          loading="lazy"
          // A picture of a panel, not a panel: a screen reader walking a grid
          // should not be offered every tile's zone columns and buttons, and a
          // click that opened a menu inside one tile would leave it showing a
          // different screen from the rest.
          aria-hidden="true"
          tabindex={-1}
          style={{
            width: `${PANEL_PREVIEW_LAYOUT.w}px`,
            height: `${PANEL_PREVIEW_LAYOUT.h}px`,
            border: "none",
            display: "block",
            "pointer-events": "none",
            // Held back until the board is seeded, so the first paint is the
            // panel rather than the empty-state card it shows before that.
            opacity: ready() ? "1" : "0",
            transition: "opacity 200ms ease",
          }}
        />
      </div>
    </div>
  );
}
