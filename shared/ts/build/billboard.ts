/**
 * In-world billboard artwork for the DoItDigital 50 Billboard Package — read at 80mph from
 * 200 metres through GTA's haze, unlike `hero.ts`'s dark product cards (shares only its
 * capture-with-guards). Real boards (Burger Shot, Lifeinvader, Rusty Brown's) all bleed a
 * product/photo off the edge over a saturated flat field with hard-shadowed type and a
 * corner badge — a first pass without that read as a slide deck bolted to a frame.
 *
 * Four layouts, three pastiching those boards: `product` (solid field, cut-out bleeding off
 * the right), `split` (full-bleed art one side, copy panel the other), `pattern` (art tiled
 * edge to edge under huge outlined type). `showcase` is deliberately the odd one out — a
 * full-bleed in-game screenshot, scrimmed, under the store art's light rig and brand face —
 * since an all-pastiche set reads as one joke told four times, and a night shot of a lit
 * Charger wants a scrim and caption, not a flat colour field. The cut-outs it and `product`
 * draw on are real: every t* resource's gallery ships transparent-ground product photography.
 */

import fs from "node:fs";
import path from "node:path";
import { ATMOS_HTML, LIGHT_RIG_CSS, SPILL_HTML, shoot } from "./hero.ts";

const TWEB = path.resolve(import.meta.dir, "../../../..", "internal", "tWeb");
const FONT = path.join(TWEB, "public", "fonts", "alte-haas-grotesk.bold.woff2");
const TIMMYG_MARK = path.join(TWEB, "public", "brand-mark.webp");
/** tRadio's own layout face, embedded so `font: "radio"` does not depend on an install. */
const CREATO = path.resolve(
  import.meta.dir,
  "../../../..",
  "tRadio",
  "layouts",
  "QRX-720",
  "fonts",
  "CreatoDisplay.otf"
);

export type BillboardLayout = "product" | "split" | "pattern" | "showcase" | "notice" | "spec";

/**
 * Headline faces. Half are system fonts, named rather than embedded — fine for build-time
 * art rendered on one machine, the opposite of the NUI rule where a named system font is a
 * silent fallback. A face the machine lacks falls back to Arial and still renders, so
 * `--audit` below measures each against Arial and names any that didn't load.
 */
export type BillboardFont =
  | "condensed" // Haettenschweiler / Impact — the GTA billboard default
  | "black" // Arial Black — loud, wide, poster
  | "brand" // Alte Haas Grotesk — the store art's face
  | "serif" // Georgia — editorial, official, public-notice
  | "mono" // Consolas — datasheet, technical, teletype
  | "techno" // Bahnschrift — condensed geometric, signage
  | "radio"; // CreatoDisplay — the face tRadio's own layouts are set in

const FONT_STACKS: Record<BillboardFont, string> = {
  condensed: `"Haettenschweiler", "Arial Narrow Bold", "Impact", "Alte Haas Grotesk", sans-serif`,
  black: `"Arial Black", "Arial Bold", "Alte Haas Grotesk", sans-serif`,
  brand: `"Alte Haas Grotesk", Arial, sans-serif`,
  serif: `"Georgia", "Times New Roman", serif`,
  mono: `"Consolas", "Courier New", monospace`,
  techno: `"Bahnschrift", "DIN Alternate", "Alte Haas Grotesk", sans-serif`,
  radio: `"CreatoDisplay", "Alte Haas Grotesk", sans-serif`,
};

/** Rough width of a capital em, per face, for the headline auto-fit below. Measured by eye
 *  against a rendered board rather than from the font tables — close enough to stop overflow,
 *  which is all the cap is for. */
const FONT_EM: Record<BillboardFont, number> = {
  condensed: 0.46,
  black: 0.72,
  brand: 0.56,
  serif: 0.62,
  mono: 0.6,
  techno: 0.5,
  radio: 0.58,
};

export interface BillboardSpec {
  /** Exact pixel size of the texture slot this fills. */
  width: number;
  height: number;
  layout?: BillboardLayout;
  /** Headline face. Defaults per layout — condensed for the pastiche ones, brand for showcase. */
  font?: BillboardFont;
  /**
   * Force the headline's case. Defaults by FACE, not layout — condensed/black poster faces
   * are drawn for caps, serif/brand aren't; following layout made the same sentence-case
   * line shout on one board and not another.
   */
  caps?: boolean;
  /** Big line. Two to four words per line; newlines are honoured. */
  headline: string;
  subhead?: string;
  /** Small line above the headline. */
  kicker?: string;
  /** The joke in the small print. */
  fineprint?: string;
  /** Circular starburst, e.g. "NEW" or "$0.00". Skipped when absent. */
  badge?: string;
  /** `notice` only: the rotated rubber stamp across the corner. */
  stamp?: string;
  /** `spec` only: the datasheet row along the bottom. */
  specs?: { k: string; v: string }[];
  /** Absolute path to a cut-out or photo. Required by `split`. */
  art?: string;
  /**
   * Tiles for the `pattern` layout, cycled to fill the frame. A list of individual faces, not
   * one image — tiling a gallery's contact sheet instead read fine until you noticed
   * `control-audio-master-up` captioned under every key; those sheets carry debug labels.
   */
  tiles?: string[];
  /** Tile edge in px. Defaults to a twelfth of the long side. */
  tilePx?: number;
  /** Extra CSS on the art element — size and position are layout defaults otherwise. */
  artCss?: string;
  /** Opt out of the cover-crop guard, when a tight detail crop is the intent. */
  allowTightCrop?: boolean;
  bg: string;
  fg?: string;
  accent?: string;
  onAccent?: string;
  /** Bottom-left lockup text beside the TIMMYG mark. Defaults to the URL. */
  brand?: string;
  footer?: string;
  out: string;
  log?: (msg: string) => void;
}

function dataUri(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`billboard: missing input ${file}`);
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".woff2"
      ? "font/woff2"
      : ext === ".otf"
        ? "font/otf"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Intrinsic size of a PNG, WEBP or JPEG, read from its header. Placement needs this — a
 * hand-written `artCss` per advert produced a detector 95% off the right edge and a 288px
 * Stream Deck key stretched to half a board.
 */
function imageSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const tag = b.toString("ascii", 12, 16);
    if (tag === "VP8X")
      return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (tag === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (tag === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  throw new Error(`billboard: cannot read the size of ${path.basename(file)}`);
}

/** Newlines in copy are intentional line breaks — a billboard headline is hand-broken. */
function lines(s: string): string {
  return esc(s).replace(/\n/g, "<br>");
}

export async function renderBillboard(spec: BillboardSpec): Promise<void> {
  const { width: W, height: H } = spec;
  const layout = spec.layout ?? "product";
  const fg = spec.fg ?? "#fff8ec";
  const accent = spec.accent ?? "#ffd21f";
  const onAccent = spec.onAccent ?? "#1a1205";
  const portrait = H > W * 1.4;
  const strip = W > H * 3;

  if (layout === "split" && !spec.art) throw new Error("billboard: split layout needs art");
  if (layout === "showcase" && !spec.art) throw new Error("billboard: showcase layout needs art");

  /*
   * `object-fit: cover` silently destroys art it has to magnify — `both.webp` (1280x383) in a
   * 1024x2048 portrait blows up 5.3x into an unrecognisable grey blur, with the board still
   * rendering and every other guard passing. The gate measures the scale factor, not area kept:
   * an early version measured area and failed good split boards at 35% crop, when the real rule
   * is about magnification, not how much is cropped away.
   */
  if ((layout === "showcase" || layout === "split") && spec.art && !spec.allowTightCrop) {
    const a = imageSize(spec.art);
    const boxW = layout === "split" ? Math.round(W * 0.46) : W;
    const scale = Math.max(boxW / a.w, H / a.h);
    if (scale > 2.5) {
      throw new Error(
        `billboard: ${path.basename(spec.art)} is ${a.w}x${a.h} and this slot wants ${boxW}x${H} — ` +
          `cover would magnify it ${scale.toFixed(1)}x and it will render as mush. Use a source ` +
          `closer to the slot's aspect, a different layout, or pass allowTightCrop.`
      );
    }
  }
  if (layout === "pattern" && !spec.tiles?.length) {
    throw new Error("billboard: pattern layout needs tiles");
  }

  /** Enough repeats to cover the frame with one row to spare. */
  const tilePx = spec.tilePx ?? Math.round(Math.max(W, H) / 12);
  const tileCount =
    layout === "pattern" ? (Math.ceil(W / tilePx) + 1) * (Math.ceil(H / tilePx) + 1) : 0;
  const tiles = spec.tiles ?? [];
  const tileImgs =
    layout === "pattern"
      ? Array.from(
          { length: tileCount },
          (_, i) => `<img src="${dataUri(tiles[i % tiles.length])}">`
        ).join("")
      : "";

  // Type scales off the short side — slots run 16:1 to 1:8, so sizing off the long side is
  // unreadable on one and overflows the other. A strip gets a bigger short-side share since
  // it only ever fits one line.
  const unit = Math.min(W, H);
  const pad = Math.round(unit * 0.06);
  // Scales down as lines grow: fixed size made a 5-line headline 80% of a square board
  // ("ONE RESOURCE / WHOLE DATABASE") with the product squeezed to a margin. Tuned at 3 lines.
  const headlineLines = spec.headline.split("\n");
  const lineScale = Math.min(1, Math.max(0.62, 3 / headlineLines.length));

  // How wide the copy gets — not the frame's short side. Sizing against `unit` on a square
  // `split` board set the headline at 317px in a 1100px column, running the last letters off
  // the right edge.
  const copyW =
    layout === "split"
      ? Math.round(W * 0.54) - pad * 2
      : layout === "spec"
        ? Math.round(W * 0.52) - pad * 2
        : layout === "notice"
          ? // Must match the copy box below — a mismatch sized the headline for full width and a
            // portrait notice ran off both edges as "RDINANCE / VIOLATION". Only the landscape
            // stamp eats horizontal room; a tall board's stamp sits above the copy instead.
            W - pad * 4 - (spec.stamp && !portrait ? Math.round(Math.min(W, H) * 0.3) : 0)
          : layout === "showcase"
            ? Math.round(W * (portrait ? 0.9 : 0.56)) - pad * 2
            : layout === "product" && !portrait && spec.art
              ? Math.round(W * 0.6) - pad * 2
              : W - pad * 2;

  // Then capped so the longest line fits: condensed caps average ~0.46em, so
  // width ≈ chars × 0.46 × size; `showcase`'s wider brand face needs more.
  const font: BillboardFont =
    spec.font ??
    (layout === "showcase"
      ? "brand"
      : layout === "notice"
        ? "serif"
        : layout === "spec"
          ? "mono"
          : "condensed");
  const emRatio = FONT_EM[font];
  const caps =
    spec.caps ?? (font === "condensed" || font === "black" || font === "techno" || font === "mono");
  const longest = Math.max(...headlineLines.map((l) => l.length), 1);
  const fitPx = Math.floor(copyW / (longest * emRatio));
  // Strip share rises with how extreme the strip is — flat 0.3 on a 16:1 ribbon (the Maze,
  // Legion Square screens) sat the headline in the top third with the rest black.
  const stripShare = Math.min(0.52, 0.3 + (W / H - 3) * 0.02);
  const designPx = Math.round(unit * (strip ? stripShare : portrait ? 0.17 : 0.155) * lineScale);
  const headlinePx = Math.max(24, Math.min(designPx, fitPx));
  const subPx = Math.round(headlinePx * 0.3);
  const kickerPx = Math.round(headlinePx * 0.17);
  const finePx = Math.round(headlinePx * 0.12);
  const shadow = Math.max(2, Math.round(headlinePx * 0.055));
  // Against the copy column, not the frame — sizing off a 2048px short side ran a square
  // `split` lockup off the end of a 1100px column as "timmygstudios.c".
  const markH = Math.round(Math.min(unit, copyW * 0.9) * 0.075);

  /** Copy occupies a column on `product`, the far side on `split`, the whole frame on `pattern`. */
  const copyBox =
    layout === "split"
      ? `left: ${Math.round(W * 0.46) + pad}px; right: ${pad}px; top: ${pad}px; bottom: ${pad + markH * 2}px;`
      : layout === "notice"
        ? // Centred inside the rules; the right edge pulls in when there's a stamp, since a
          // full-width centred headline ran underneath the top-right stamp before this
          // ("THIS OFFICER IS" with the IS covered).
          `left: ${pad * 2}px; right: ${pad * 2 + (spec.stamp && !portrait ? Math.round(unit * 0.3) : 0)}px; top: ${pad * 2 + (spec.stamp && portrait ? Math.round(H * 0.26) : 0)}px; bottom: ${pad * 2 + markH * 2}px; align-items: center; text-align: center;`
        : layout === "spec"
          ? `left: ${pad}px; right: ${Math.round(W * 0.46)}px; top: ${pad}px; bottom: ${pad + markH * 3}px;`
          : layout === "showcase"
            ? // Over the photograph, in the scrimmed corner — bottom-left on wide, bottom on tall,
              // matching where the scrim below puts its darkest end.
              `left: ${pad}px; right: ${portrait ? pad : Math.round(W * 0.42)}px; top: ${pad}px; bottom: ${pad + markH * 2}px; justify-content: flex-end;`
            : layout === "pattern"
              ? `left: ${pad}px; right: ${pad}px; top: ${pad}px; bottom: ${pad + markH * 2}px; align-items: center; text-align: center;`
              : portrait
                ? // Portrait `product` stacks copy over product; the box must stop above the
                  // art or it centres over the whole frame, leaving the top third empty.
                  `left: ${pad}px; right: ${pad}px; top: ${pad}px; bottom: ${Math.round(H * 0.44)}px;`
                : // `product` reserves the right 40% for the cut-out; with no art a type-only
                  // board gets the whole width, for resources whose UI carries no photo.
                  `left: ${pad}px; right: ${spec.art ? Math.round(W * 0.4) : pad}px; top: ${pad}px; bottom: ${pad + markH * 2}px;`;

  // `product` sizes the cut-out from its own aspect so it bleeds off one edge and still reads —
  // wide objects want width, tall ones want height; sizing everything by height shoved wide
  // ones off the frame and left tall ones tiny.
  let productArt = "";
  if ((layout === "product" || layout === "spec") && spec.art) {
    const a = imageSize(spec.art);
    const wide = a.w / a.h > 1.3;
    if (portrait) {
      const pw = Math.round(W * (wide ? 1.06 : 0.78));
      productArt = `left: 50%; bottom: ${-Math.round(H * 0.035)}px; width: ${pw}px; height: auto; transform: translateX(-50%) rotate(-3deg);`;
    } else if (wide) {
      // Wide objects run off the right corner, scaled up with width — a 3:1 radar head at the
      // 2:1 size was a 340px sliver with the upper right empty (the SLX-1100's first landing).
      const veryWide = a.w / a.h > 2.5;
      const pw = Math.round(W * (veryWide ? 0.66 : 0.52));
      const bottom = veryWide ? Math.round(H * 0.12) : -Math.round(H * 0.06);
      productArt = `right: ${-Math.round(W * 0.05)}px; bottom: ${bottom}px; width: ${pw}px; height: auto; transform: rotate(-5deg);`;
    } else {
      const ph = Math.round(H * 1.04);
      productArt = `right: ${Math.round(W * 0.02)}px; bottom: ${-Math.round(H * 0.07)}px; height: ${ph}px; width: auto; transform: rotate(-4deg);`;
    }
  }

  const artDefault =
    layout === "split"
      ? `left: 0; top: 0; width: ${Math.round(W * 0.46)}px; height: ${H}px; object-fit: cover;`
      : layout === "pattern" || layout === "showcase"
        ? `inset: 0; width: ${W}px; height: ${H}px; object-fit: cover;`
        : productArt;

  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "CreatoDisplay";
    src: url("${dataUri(CREATO)}") format("opentype");
    font-weight: 700;
    font-display: block;
  }
  @font-face {
    font-family: "Alte Haas Grotesk";
    src: url("${dataUri(FONT)}") format("woff2");
    font-weight: 700;
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  .b { isolation: isolate; }

  .b {
    position: relative;
    width: ${W}px;
    height: ${H}px;
    background: ${spec.bg};
    overflow: hidden;
    font-family: ${FONT_STACKS[font]};
  }

  /* Vinyl tooth. A perfectly flat fill reads as a screenshot pasted on a frame, and it also
     dithers the gradients before the DXT compressor turns a smooth ramp into visible steps. */
  .b::after {
    content: "";
    position: absolute; inset: 0; z-index: 9; pointer-events: none; opacity: .06;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  .art {
    position: absolute;
    z-index: 1;
    display: block;
    ${artDefault}
    ${spec.artCss ?? ""}
  }
  /* The cut-outs are lit for a dark UI card, not for daylight vinyl. A drop shadow glues them to
     the field and a little contrast stops them going muddy once DXT has had them. */
  .art.cutout { filter: drop-shadow(0 ${Math.round(unit * 0.02)}px ${Math.round(unit * 0.035)}px rgba(0,0,0,.55)) contrast(1.08) saturate(1.1); }

  .tiles {
    position: absolute; inset: 0; z-index: 1;
    display: flex; flex-wrap: wrap;
    gap: ${Math.round(tilePx * 0.08)}px;
    padding: ${Math.round(tilePx * 0.04)}px;
  }
  .tiles img { width: ${tilePx}px; height: ${tilePx}px; display: block; }

  /* The pattern layout darkens its own field so type survives whatever is tiled underneath. */
  .scrim { position: absolute; inset: 0; z-index: 2; }

  ${
    layout === "notice"
      ? `/* Notice.
     A citation nailed to a board. No photograph, no product: the joke is the
     form itself, so the whole design is rules, centred serif and a stamp. */
  .b { background: ${spec.bg}; }
  .rule { position: absolute; left: ${pad}px; right: ${pad}px; height: ${Math.max(3, Math.round(unit * 0.008))}px; background: ${fg}; opacity: .85; z-index: 3; }
  .rule.t { top: ${pad}px; }
  .rule.b2 { bottom: ${pad}px; }
  .rule.t2 { top: ${pad + Math.round(unit * 0.022)}px; height: ${Math.max(1, Math.round(unit * 0.003))}px; }
  .b h1 { letter-spacing: .01em; line-height: 1.02; text-shadow: none; }
  .b .kicker { color: ${accent}; letter-spacing: .34em; }
  .b .sub { font-family: ${FONT_STACKS.serif}; color: ${fg}; opacity: .88; }
  .b .fine { font-family: ${FONT_STACKS.mono}; letter-spacing: 0; }
  /* Rubber stamp: outlined, rotated, deliberately crude. */
  .stamp {
    position: absolute; z-index: 5;
    right: ${Math.round(W * 0.06)}px; top: ${Math.round(H * 0.16)}px;
    transform: rotate(-14deg);
    border: ${Math.max(3, Math.round(unit * 0.009))}px solid ${accent};
    color: ${accent};
    padding: ${Math.round(unit * 0.018)}px ${Math.round(unit * 0.03)}px;
    font-family: ${FONT_STACKS.condensed};
    font-size: ${Math.round(unit * 0.09)}px;
    letter-spacing: .06em;
    text-transform: uppercase;
    opacity: .9;
  }`
      : ""
  }

  ${
    layout === "spec"
      ? `/* Spec.
     A datasheet, not an advert. Mono type on a faint grid, the hardware on the
     right, and the numbers along the bottom where a spec sheet puts them. */
  .grid {
    position: absolute; inset: 0; z-index: 1; opacity: .18;
    background-image:
      linear-gradient(${accent} 1px, transparent 1px),
      linear-gradient(90deg, ${accent} 1px, transparent 1px);
    background-size: ${Math.round(unit * 0.06)}px ${Math.round(unit * 0.06)}px;
  }
  .b h1 { letter-spacing: -.01em; line-height: 1.04; text-shadow: none; }
  .b .kicker { color: ${accent}; letter-spacing: .3em; }
  .b .sub { font-family: ${FONT_STACKS.mono}; color: ${accent}; }
  .b .fine { font-family: ${FONT_STACKS.mono}; }
  .specs {
    position: absolute; z-index: 4;
    left: ${pad}px; right: ${Math.round(W * 0.42)}px; bottom: ${pad + Math.round(markH * 1.5)}px;
    display: flex; gap: ${Math.round(unit * 0.045)}px;
    border-top: 1px solid ${accent};
    padding-top: ${Math.round(unit * 0.022)}px;
    font-family: ${FONT_STACKS.mono};
  }
  .specs div { display: flex; flex-direction: column; gap: ${Math.round(unit * 0.008)}px; }
  .specs b { font-size: ${Math.round(unit * 0.042)}px; color: ${fg}; font-weight: 700; }
  .specs span { font-size: ${Math.round(unit * 0.021)}px; color: ${accent}; letter-spacing: .14em; text-transform: uppercase; }`
      : ""
  }

  ${layout === "showcase" ? LIGHT_RIG_CSS : ""}
  ${
    layout === "showcase"
      ? `/* Showcase.
     The store art's look, over a photograph. Three things make it that rather
     than "a screenshot with words on": the scrim, so type sits on something
     dark enough to read at distance; tLib's light rig, which is the same rig
     the thumbs and banners use; and the brand face instead of the condensed
     caps the pastiche layouts set. */
  .b { font-family: "Alte Haas Grotesk", Arial, sans-serif; }
  .b .scrim {
    background:
      linear-gradient(${portrait ? "0deg" : "90deg"}, rgba(4,6,9,.94) 0%, rgba(4,6,9,.78) ${portrait ? "34%" : "38%"}, rgba(4,6,9,.12) ${portrait ? "62%" : "72%"}, rgba(4,6,9,.45) 100%),
      linear-gradient(0deg, rgba(4,6,9,.6) 0%, rgba(4,6,9,0) 26%);
  }
  .b h1 {
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    letter-spacing: -.03em;
    line-height: .98;
    text-shadow: 0 ${Math.round(headlinePx * 0.02)}px ${Math.round(headlinePx * 0.09)}px rgba(0,0,0,.75);
  }
  .b .kicker { letter-spacing: .24em; }
  .b .sub { color: ${fg}; opacity: .92; }
  .atmos { z-index: 3; }
  .spill { z-index: 3; opacity: .5; }
  .copy, .brand, .badge { z-index: 4; }`
      : ""
  }

  .copy {
    position: absolute;
    ${copyBox}
    display: flex; flex-direction: column; justify-content: center;
    z-index: 3;
  }

  .kicker {
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700; font-size: ${kickerPx}px;
    letter-spacing: .2em; text-transform: uppercase;
    color: ${accent};
    margin-bottom: ${Math.round(kickerPx * 0.8)}px;
  }
  h1 {
    font-size: ${headlinePx}px;
    line-height: .88;
    letter-spacing: -.015em;
    text-transform: ${caps ? "uppercase" : "none"};
    color: ${fg};
    /* Hard offset, not a blur. Every board in the game does this and it is most of why they read
       at distance — a soft shadow disappears the moment the compressor and the haze get it. */
    text-shadow: ${shadow}px ${shadow}px 0 rgba(0,0,0,.42);
  }
  ${
    layout === "pattern"
      ? `h1 { -webkit-text-stroke: ${Math.round(headlinePx * 0.055)}px rgba(0,0,0,.72); paint-order: stroke fill; text-shadow: none; }`
      : ""
  }
  .sub {
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700; font-size: ${subPx}px; line-height: 1.14;
    margin-top: ${Math.round(subPx * 0.65)}px;
    color: ${accent};
  }
  .fine {
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700; font-size: ${finePx}px; line-height: 1.25;
    margin-top: ${Math.round(finePx * 1.5)}px;
    color: ${fg}; opacity: .62;
  }

  /* Brand lockup, bottom left, the way Burger Shot's sits under the copy. */
  /* Bottom left everywhere except the split layout, whose left half is the artwork — the lockup
     landed on a dark screenshot there and simply could not be read. The copy box reserves its
     height (see .copy's bottom), because otherwise the fineprint prints straight through it. */
  .brand {
    position: absolute; z-index: 4;
    ${layout === "split" ? `left: ${Math.round(W * 0.46) + pad}px;` : `left: ${pad}px;`}
    /* Clear of the notice's bottom rule, which sits one pad from the edge. */
    bottom: ${Math.round(layout === "notice" ? pad * 1.9 : pad * 0.8)}px;
    display: flex; align-items: center; gap: ${Math.round(markH * 0.34)}px;
  }
  .brand img { height: ${markH}px; width: ${markH}px; display: block; }
  .brand span {
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700; font-size: ${Math.round(markH * 0.62)}px;
    letter-spacing: .04em; color: ${fg};
    text-shadow: 0 ${Math.round(markH * 0.04)}px 0 rgba(0,0,0,.35);
  }

  /* Starburst. Rotated square badges are the cheapest possible "this is an advert" signal. */
  .badge {
    position: absolute; z-index: 5;
    ${layout === "split" ? `left: ${Math.round(W * 0.4)}px;` : `right: ${Math.round(W * 0.03)}px;`}
    top: ${Math.round(H * 0.06)}px;
    width: ${Math.round(unit * 0.26)}px; height: ${Math.round(unit * 0.26)}px;
    border-radius: 50%;
    background: ${accent};
    color: ${onAccent};
    display: flex; align-items: center; justify-content: center; text-align: center;
    font-family: "Alte Haas Grotesk", Arial, sans-serif;
    font-weight: 700; font-size: ${Math.round(unit * 0.062)}px; line-height: 1;
    letter-spacing: -.01em;
    transform: rotate(-12deg);
    box-shadow: 0 ${Math.round(unit * 0.012)}px 0 rgba(0,0,0,.3);
  }
</style>
<div class="b">
  ${spec.art && layout !== "pattern" ? `<img class="art${layout === "product" ? " cutout" : ""}" src="${dataUri(spec.art)}">` : ""}
  ${layout === "pattern" ? `<div class="tiles">${tileImgs}</div>` : ""}
  ${layout === "pattern" ? `<div class="scrim" style="background: rgba(0,0,0,.18)"></div>` : ""}
  ${layout === "showcase" ? `<div class="scrim"></div>${ATMOS_HTML}${SPILL_HTML}` : ""}
  ${layout === "notice" ? `<div class="rule t"></div><div class="rule t2"></div><div class="rule b2"></div>` : ""}
  ${layout === "spec" ? `<div class="grid"></div>` : ""}
  <div class="copy">
    ${spec.kicker ? `<div class="kicker">${esc(spec.kicker)}</div>` : ""}
    <h1>${lines(spec.headline)}</h1>
    ${spec.subhead ? `<div class="sub">${lines(spec.subhead)}</div>` : ""}
    ${spec.fineprint ? `<div class="fine">${lines(spec.fineprint)}</div>` : ""}
  </div>
  ${spec.badge ? `<div class="badge">${lines(spec.badge)}</div>` : ""}
  ${layout === "notice" && spec.stamp ? `<div class="stamp">${esc(spec.stamp)}</div>` : ""}
  ${
    layout === "spec" && spec.specs?.length
      ? `<div class="specs">${spec.specs.map((x) => `<div><b>${esc(x.v)}</b><span>${esc(x.k)}</span></div>`).join("")}</div>`
      : ""
  }
  <div class="brand"><img src="${dataUri(TIMMYG_MARK)}"><span>${esc(spec.brand ?? spec.footer ?? "timmygstudios.com")}</span></div>
</div>`;

  await shoot({
    html,
    width: W,
    height: H,
    fontSizePx: Math.max(16, subPx),
    // The mark, plus either one art element or every tile.
    expectImages: 1 + (layout === "pattern" ? tileCount : spec.art ? 1 : 0),
    out: spec.out,
    label: "billboard",
    log: spec.log ?? console.log,
  });
}
