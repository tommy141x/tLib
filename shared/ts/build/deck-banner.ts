/**
 * The Stream Deck integration banner, shared by tRadio, tELS and tRadar.
 *
 * A different composition from `hero.ts` — two stacked logo lockups, the device dead centre,
 * individual keys floating either side of it, and a two-line tagline under the lot — but the
 * same frame, the same light rig and the same capture guards, imported from there rather than
 * copied. Only the layout below is new.
 *
 *   2000×1000   a 2:1 card, the shape the reference artwork uses
 *
 * Inputs come from each resource's own `assets/gallery/deck/`:
 *   deck--mini--<state>.png   the device, rendered on a transparent ground
 *   keys/<name>--<state>.png  one key face, square, also transparent
 *
 * The Elgato mark is a third-party logo used to name the integration. It lives at
 * `internal/tWeb/assets/brand/stream-deck.png` — `assets/`, not `public/`, because it is a
 * build input and nothing should start serving it from timmygstudios.com as a side effect of
 * being here. The artwork is black, so it is inverted to white for this dark frame.
 *
 * The browser is the NUI Chromium (revision 103). No `oklch()` or `color-mix()` — they
 * arrived in 111 and fail silently there.
 */

import fs from "node:fs";
import path from "node:path";
import { ATMOS_HTML, GRAIN_CSS, LIGHT_RIG_CSS, SPILL_HTML, shoot } from "./hero.ts";

const TWEB = path.resolve(import.meta.dir, "../../../..", "internal", "tWeb");
const FONT = path.join(TWEB, "public", "fonts", "alte-haas-grotesk.bold.woff2");
const TIMMYG_MARK = path.join(TWEB, "public", "brand-mark.webp");
const STREAM_DECK = path.join(TWEB, "assets", "brand", "stream-deck.png");

const W = 2000;
const H = 1000;
/** The size the tagline is set at, and therefore what the brand-face guard probes. */
const TAGLINE_PX = 34;

export interface DeckKey {
  /** Absolute path to one key face from `assets/gallery/deck/keys/`. */
  file: string;
  /** Placement: top/left/right and a rotation. Keys are square, so width is enough. */
  css: string;
}

export interface DeckBannerSpec {
  /** Uppercase, e.g. "TOTAL CONTROL." — rendered in white. */
  tagline: string;
  /** The clause after it, in the accent colour. */
  taglineAccent: string;
  /** The dim line under both, e.g. "BUILT FOR DISPATCHERS. BY DEVELOPERS." */
  footnote: string;
  /** Absolute path to a `deck--mini--*.png`. */
  device: string;
  /** Extra declarations for the device, if the default centring needs nudging. */
  deviceCss?: string;
  keys: DeckKey[];
  /** Defaults to the cyan the brand mark is built from. */
  accent?: string;
  out: string;
  log?: (msg: string) => void;
}

function dataUri(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`deck-banner: missing input ${file}`);
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".woff2"
      ? "font/woff2"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".svg"
          ? "image/svg+xml"
          : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function renderDeckBanner(spec: DeckBannerSpec): Promise<void> {
  const accent = spec.accent ?? "#2fd8e4";
  const keyImgs = spec.keys
    .map((k, i) => `<img class="k k${i}" src="${dataUri(k.file)}">`)
    .join("\n  ");
  const keyCss = spec.keys.map((k, i) => `.k${i} { ${k.css} }`).join("\n  ");

  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "Alte Haas Grotesk";
    src: url("${dataUri(FONT)}") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }

  .frame {
    position: relative;
    width: ${W}px;
    height: ${H}px;
    background: radial-gradient(110% 80% at 50% 38%, #10161a 0%, #080b0d 48%, #040506 100%);
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700;
    overflow: hidden;
    isolation: isolate;
  }
${LIGHT_RIG_CSS}

  /* The one thing the shared rig does not provide: a colour. The rig is neutral white so it can
     light any product; this pools the brand's cyan behind the device so the frame is not just
     grey. Behind everything, and wide enough that no edge of it is visible. */
  .pool {
    position: absolute;
    left: 50%;
    top: 46%;
    width: 1500px;
    height: 900px;
    transform: translate(-50%, -50%);
    z-index: 1;
    background: radial-gradient(50% 50% at 50% 50%, ${accent}1f 0%, ${accent}0a 45%, rgba(0,0,0,0) 72%);
  }

  /* Everything legible sits above .atmos (z-index 1), or the airborne beams wash over it. */
  .brand, .sd, .stage, .tag { position: absolute; z-index: 3; }

  .brand {
    top: 62px; left: 0; right: 0;
    display: flex; align-items: center; justify-content: center; gap: 22px;
  }
  .brand img { width: 62px; height: 62px; display: block; }
  .brand span { font-size: 62px; line-height: 1; letter-spacing: -.02em; color: #fff; }

  .sd {
    top: 168px; left: 0; right: 0;
    display: flex; align-items: center; justify-content: center;
  }
  /* The supplied artwork is black-on-transparent, so it is inverted rather than recoloured —
     a filter keeps the mark and the wordmark locked together at their authored spacing. */
  .sd img { height: 62px; display: block; filter: invert(1); }

  .stage { inset: 0; }
  .stage img { position: absolute; display: block; }

  /* Deliberately a sibling of .stage rather than a child of it, so that a device shot WITHOUT an
     alpha channel can key its black ground out with mix-blend-mode screen (tRadar's deck
     gallery renders on solid #000; tRadio's and tELS's are RGBA). A blend only composites
     against its own stacking context, and .stage makes one by having a z-index — nested, the
     device would screen against nothing and keep its black box. */
  .device {
    position: absolute;
    display: block;
    z-index: 3;
    width: 760px;
    left: 50%;
    top: 286px;
    transform: translateX(-50%);
    filter: drop-shadow(0 46px 70px rgba(0,0,0,.95));
    ${spec.deviceCss ?? ""}
  }

  /* Loose keys. Square faces, so each only needs a width and a corner to hang from. They read as
     the deck's own buttons lifted off it, which is why they keep the device's drop shadow rather
     than getting a border. */
  .k {
    width: 132px;
    filter: drop-shadow(0 18px 28px rgba(0,0,0,.9));
    opacity: .96;
  }
  ${keyCss}

  .tag { bottom: 104px; left: 0; right: 0; text-align: center; }
  .tag b {
    display: block;
    font-size: ${TAGLINE_PX}px;
    letter-spacing: .26em;
    color: #fff;
  }
  .tag b em { font-style: normal; color: ${accent}; }
  .tag small {
    display: block;
    margin-top: 22px;
    font-size: 19px;
    letter-spacing: .22em;
    color: rgba(255,255,255,.42);
  }

  .vignette {
    position: absolute; inset: 0; z-index: 5; pointer-events: none;
    background:
      radial-gradient(82% 78% at 50% 44%, rgba(4,5,6,0) 54%, rgba(4,5,6,.62) 100%),
      linear-gradient(0deg, rgba(4,5,6,.5) 0%, rgba(4,5,6,0) 20%);
  }
${GRAIN_CSS}
</style>
<div class="frame">
  <div class="pool"></div>
  ${ATMOS_HTML}
  <div class="brand"><img src="${dataUri(TIMMYG_MARK)}"><span>TIMMYG Studios</span></div>
  <div class="sd"><img src="${dataUri(STREAM_DECK)}"></div>
  <img class="device" src="${dataUri(spec.device)}">
  <div class="stage">
    ${keyImgs}
  </div>
  ${SPILL_HTML}
  <div class="tag">
    <b>${esc(spec.tagline)} <em>${esc(spec.taglineAccent)}</em></b>
    <small>${esc(spec.footnote)}</small>
  </div>
  <div class="vignette"></div>
  <div class="grain"></div>
</div>`;

  await shoot({
    html,
    width: W,
    height: H,
    fontSizePx: TAGLINE_PX,
    // Both logos and the device, plus a key each.
    expectImages: spec.keys.length + 3,
    out: spec.out,
    label: "deck-banner",
    log: spec.log ?? console.log,
  });
}
