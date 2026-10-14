/**
 * The store/docs hero image, shared by every t* resource.
 *
 * One dark frame, one off-camera key light, a wordmark, and however many captures the caller
 * stacks behind it. This module owns the frame, the light rig and the guards; each resource's
 * `scripts/thumb.ts` owns only its own words and its own layer placement, because that is the
 * part that genuinely differs between products.
 *
 * Two formats off the same declaration:
 *
 *   thumb    1920×1080   wordmark centred over a stack of captures — store listing, docs OG card
 *   banner   1500×500    wordmark left, captures running off the right edge — README, socials
 *
 * The browser is the NUI Chromium (revision 103), vendored by nui-chromium.ts — not whatever
 * is installed on the machine. The stylesheet below therefore cannot use `oklch()` or
 * `color-mix()`, which arrived in 111 and fail silently there.
 *
 * Rendered and encoded at 1×. A 2× pass downsampled with sharp was measured against this and the
 * two were indistinguishable at display size, so the image library it needed is not here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./nui-chromium.ts";

/** tWeb owns the brand faces; this is the same bold the marketing site sets its headings in. */
const FONT_DIR = path.resolve(
  import.meta.dir,
  "../../../..",
  "internal",
  "tWeb",
  "public",
  "fonts"
);

export interface HeroLayer {
  /** Absolute path to a PNG/WEBP/JPEG. Transparent grounds are fine and get no border radius. */
  file: string;
  /** Placement for this layer: width, left/right, top, transform, filter, box-shadow. */
  css: string;
}

export interface HeroSpec {
  headline: string;
  subtitle: string;
  /** Absolute path. The extension picks the encoding — `.png` for lossless, anything else JPEG. */
  out: string;
  format?: "thumb" | "banner";
  /** Override when a short word would otherwise sit in the frame as a caption. */
  headlineSize?: number;
  /** Extra declarations for the stage box, e.g. a different `top` when a layout needs room. */
  stageCss?: string;
  /** Painted back to front — the first entry is furthest away. */
  layers: HeroLayer[];
  log?: (msg: string) => void;
}

const FORMATS = {
  thumb: { w: 1920, h: 1080, headline: 148, subtitle: 44, stageTop: 392 },
  banner: { w: 1500, h: 500, headline: 92, subtitle: 28, stageTop: 0 },
} as const;

/** Headline and subtitle reach the markup from a CLI flag in most callers. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline every asset. A file:// page cannot fetch siblings without loosening Chromium's file
 *  access, and a font that silently fails to load falls back to Arial — which looks deliberate. */
function dataUri(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`hero: missing input ${file}`);
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".woff2"
      ? "font/woff2"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function document(
  spec: Required<Pick<HeroSpec, "headline" | "subtitle" | "layers">> & {
    w: number;
    h: number;
    headlineSize: number;
    subtitleSize: number;
    stageTop: number;
    stageCss: string;
    banner: boolean;
  }
): string {
  const { w, h, headlineSize, subtitleSize, stageTop, stageCss, banner } = spec;
  const fontBold = dataUri(path.join(FONT_DIR, "alte-haas-grotesk.bold.woff2"));
  const imgs = spec.layers
    .map((l, i) => `<img class="l${i}" src="${dataUri(l.file)}">`)
    .join("\n    ");
  const layerCss = spec.layers.map((l, i) => `.l${i} { ${l.css} }`).join("\n  ");

  return `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "Alte Haas Grotesk";
    src: url("${fontBold}") format("woff2");
    font-weight: 700;
    font-display: block; /* block, not swap: nothing is watching, and a swap can be photographed mid-swap */
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #000; }

  .frame {
    position: relative;
    width: ${w}px;
    height: ${h}px;
    background: radial-gradient(120% 90% at 50% 0%, #15181c 0%, #0a0c0e 45%, #050607 100%);
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700;
    overflow: hidden;
    /* Contains the screen/overlay blend below. Without it the blend reaches past .frame to the
       root and composites against the body, which is black — the spill then does nothing. */
    isolation: isolate;
  }

  /* ── Light rig ──────────────────────────────────────────────────────────────
     Back to front: a key above the frame, haze for its beams to be visible in,
     the beams themselves, and the spill where those beams land on the captures.
     .atmos is the light in the air; .spill is the same light on the subject.
     They share one geometry block and differ only in z-index and in what each
     beam paints, so the two sets cannot drift apart. Both carry the same inset
     so the percentage offsets resolve against the same box. */
  .atmos, .spill { position: absolute; inset: -25%; pointer-events: none; }
  .atmos { z-index: 1; }
  /* Overlay against white doubles dark values and leaves light ones alone, which is an exposure
     lift that keeps the captures' contrast. Screen greys a dark UI out instead, and
     backdrop-filter clips to the element box in 103 — both read as a sheet laid over the picture
     rather than as light falling on it. */
  .spill { z-index: 4; mix-blend-mode: overlay; }

  /* The source sits above the top edge so only its falloff is in frame. An emitter you can see
     reads as a blob; one you cannot reads as a light. */
  .key {
    position: absolute;
    left: 50%;
    top: -26%;
    width: 140%;
    height: 90%;
    transform: translateX(-50%);
    background: radial-gradient(50% 50% at 50% 50%,
      rgba(216,234,255,.20) 0%, rgba(188,212,246,.06) 40%, rgba(0,0,0,0) 68%);
  }

  /* Airborne haze. Beams are only visible because of what they shine through. */
  .haze {
    position: absolute;
    left: -10%;
    right: -10%;
    top: 24%;
    height: 42%;
    background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(178,203,238,.06) 46%, rgba(0,0,0,0) 100%);
    filter: blur(90px);
  }

  .beams { position: absolute; inset: 0; }
  .beams i {
    position: absolute;
    top: -40%;
    height: 180%;
    background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(228,240,255,.55) 50%, rgba(255,255,255,0) 100%);
    transform-origin: 50% 0;
    /* No mask. mask-clip is border-box, so a fade along the length would cut the blur off square
       at the un-blurred rectangle's edge and put hard sides back on every beam. Not needed
       anyway — each spans far past both frame edges, so its ends are off-camera. */
  }
  /* Blur is ~half the width on every beam, and that ratio is the trick: at a fixed blur a wide
     beam keeps a flat lit core with two straight sides, which is a rectangle however soft its
     edges are. Widths and angles are uneven so they do not read as a pattern. */
  .beams i:nth-child(1) { left: 53%; width: 200px; opacity: .62; transform: rotate(19deg); filter: blur(100px); }
  .beams i:nth-child(2) { left: 66%; width: 84px;  opacity: .92; transform: rotate(13deg); filter: blur(44px); }
  .beams i:nth-child(3) { left: 71%; width: 150px; opacity: .40; transform: rotate(16deg); filter: blur(76px); }
  .beams i:nth-child(4) { left: 26%; width: 320px; opacity: .16; transform: rotate(25deg); filter: blur(160px); }
  .beams i:nth-child(5) { left: 44%; width: 46px;  opacity: .58; transform: rotate(21deg); filter: blur(26px); }

  /* Overlay doubles what it lands on, so white here goes further than the same white in the air. */
  .spill i {
    background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.52) 50%, rgba(255,255,255,0) 100%);
  }

  .wordmark {
    position: absolute;
    z-index: 3;
    ${banner ? "left: 86px; right: 52%; top: 50%; transform: translateY(-50%); text-align: left;" : "left: 0; right: 0; top: 74px; text-align: center;"}
  }
  h1 {
    font-size: ${headlineSize}px;
    line-height: 1;
    letter-spacing: -.035em;
    color: #fff;
    text-shadow: 0 0 90px rgba(150,190,255,.18);
  }
  p {
    margin-top: ${banner ? 18 : 34}px;
    font-size: ${subtitleSize}px;
    line-height: 1.2;
    letter-spacing: -.012em;
    color: rgba(255,255,255,.93);
  }

  /* The captures, near-flat and at different depths — the look is depth separation, not a steep
     3D tilt. */
  .stage {
    position: absolute;
    top: ${stageTop}px;
    left: 0;
    right: 0;
    height: ${h - stageTop}px;
    perspective: 2600px;
    perspective-origin: 50% 0%;
    /* Above .atmos. At auto the airborne beams paint in FRONT of the captures — a white wash over
       the whole composition, which makes them look muted and behind a sheet of light. */
    z-index: 2;
    ${stageCss}
  }
  .stage img {
    position: absolute;
    display: block;
    border-radius: 14px;
    transform-style: preserve-3d;
  }
  ${layerCss}

  /* Vignette over everything, so the captures fall away into the frame edges instead of ending. */
  .vignette {
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    background:
      radial-gradient(86% 80% at 50% 40%, rgba(5,6,7,0) 58%, rgba(5,6,7,.42) 100%),
      /* The left edge pulls back hard on a banner: the wordmark is left-aligned there, and the
         16:9 falloff — sized for centred text with captures running to the edge — eats it. */
      ${
        banner
          ? "linear-gradient(90deg, rgba(5,6,7,.55) 0%, rgba(5,6,7,0) 7%, rgba(5,6,7,0) 93%, rgba(5,6,7,.7) 100%)"
          : "linear-gradient(90deg, rgba(5,6,7,.95) 0%, rgba(5,6,7,0) 16%, rgba(5,6,7,0) 90%, rgba(5,6,7,.8) 100%)"
      },
      linear-gradient(0deg, rgba(5,6,7,.55) 0%, rgba(5,6,7,0) 22%);
  }

  /* Grain, last. Atmosphere is the reason it is here, but it also pays for itself: the frame is
     mostly one wide dark gradient, and an 8-bit JPEG of that bands visibly in the falloff. A few
     counts of noise dither the steps away for less than the banding costs. */
  .grain {
    position: absolute;
    inset: 0;
    z-index: 6;
    pointer-events: none;
    opacity: .055;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
</style>
<div class="frame">
  <div class="atmos">
    <div class="key"></div>
    <div class="haze"></div>
    <div class="beams"><i></i><i></i><i></i><i></i><i></i></div>
  </div>
  <div class="wordmark">
    <h1>${esc(spec.headline)}</h1>
    <p>${esc(spec.subtitle)}</p>
  </div>
  <div class="stage">
    ${imgs}
  </div>
  <div class="spill"><div class="beams"><i></i><i></i><i></i><i></i><i></i></div></div>
  <div class="vignette"></div>
  <div class="grain"></div>
</div>`;
}

export async function renderHero(spec: HeroSpec): Promise<void> {
  const log = spec.log ?? console.log;
  const fmt = FORMATS[spec.format ?? "thumb"];
  const banner = (spec.format ?? "thumb") === "banner";
  const headlineSize = spec.headlineSize ?? fmt.headline;

  const html = document({
    headline: spec.headline,
    subtitle: spec.subtitle,
    layers: spec.layers,
    w: fmt.w,
    h: fmt.h,
    headlineSize,
    subtitleSize: fmt.subtitle,
    stageTop: fmt.stageTop,
    stageCss: spec.stageCss ?? "",
    banner,
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t-hero-"));
  const page = path.join(tmp, "hero.html");
  fs.writeFileSync(page, html);

  const browser = await launch({ headless: true, log });
  try {
    await browser.page.send("Emulation.setDeviceMetricsOverride", {
      width: fmt.w,
      height: fmt.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.page.navigate(`file:///${page.replace(/\\/g, "/")}`);

    // Wait on the font and every decode explicitly. `load` fires before either, and a shot taken
    // then is the fallback face over half-painted images — which still writes a plausible file.
    const probe = await browser.page.evaluate<string>(
      `(async () => {
         await document.fonts.load('700 ${headlineSize}px "Alte Haas Grotesk"');
         await document.fonts.ready;
         await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
         const el = document.createElement('span');
         el.style.cssText = 'position:absolute;white-space:pre;font:700 ${headlineSize}px "Alte Haas Grotesk";';
         el.textContent = 'Database Radio';
         document.body.appendChild(el);
         const brand = el.getBoundingClientRect().width;
         el.style.font = '700 ${headlineSize}px Arial';
         const fallback = el.getBoundingClientRect().width;
         el.remove();
         return JSON.stringify({ brand, fallback, images: [...document.images].map((i) => i.naturalWidth) });
       })()`
    );
    const state = JSON.parse(probe) as { brand: number; fallback: number; images: number[] };
    // The brand face measures differently from Arial at this size; equal widths means it never
    // loaded and the headline is about to be photographed in the fallback.
    if (Math.abs(state.brand - state.fallback) < 1) {
      throw new Error(
        `hero: brand face did not load — headline would render in Arial (both ${state.brand}px)`
      );
    }
    if (state.images.length !== spec.layers.length || state.images.some((w) => w === 0)) {
      throw new Error(
        `hero: a layer failed to decode — widths ${state.images.join(", ") || "(none)"}`
      );
    }

    const png = path.extname(spec.out).toLowerCase() === ".png";
    const { data } = await browser.page.send<{ data: string }>("Page.captureScreenshot", {
      format: png ? "png" : "jpeg",
      ...(png ? {} : { quality: 92 }),
      clip: { x: 0, y: 0, width: fmt.w, height: fmt.h, scale: 1 },
      captureBeyondViewport: false,
    });
    const shot = Buffer.from(data, "base64");

    fs.mkdirSync(path.dirname(spec.out), { recursive: true });
    fs.writeFileSync(spec.out, shot);
    log(
      `[hero] ${path.basename(spec.out)} ${fmt.w}×${fmt.h} ${(shot.length / 1024).toFixed(0)} KB`
    );
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
