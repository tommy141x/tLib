/**
 * Does the focus indicator actually PAINT PIXELS?
 *
 *   bun run probe:focus
 *
 * The shared kit draws focus as an `outline`, not as a `ring-*`. That decision
 * rests on one measurement, and this is the thing that takes it: `ring-*`
 * compiles to a `box-shadow` under presetWind3, and a box-shadow painted
 * OUTWARD from an element that fills an `overflow: hidden` ancestor is clipped
 * to nothing. An `outline` at a NEGATIVE offset is drawn inside the box and
 * survives.
 *
 * Everything here is read off the SHIPPED artefacts, so it cannot drift into
 * agreeing with itself:
 *
 *   - the stylesheet is each bundle's real built CSS, not a stylesheet this file
 *     writes. If a bundle has not been built, this exits 1 rather than
 *     measuring nothing;
 *   - every class string is asserted to appear VERBATIM in the real component
 *     source named beside it, so a source edit that changes the spelling fails
 *     this probe instead of leaving it measuring a string nobody ships;
 *   - focus is reached with a real Tab key through CDP's input domain, not with
 *     `el.focus()`. That matters: Chromium's `:focus-visible` heuristic does not
 *     match a programmatic focus on a button, so a probe that called `.focus()`
 *     would measure zero and read exactly like a broken indicator;
 *   - the verdict is a pixel count off `Page.captureScreenshot`, in the pinned
 *     Chromium 103 that CEF actually is -- not `getComputedStyle`. A computed
 *     `outline-color` proves the cascade resolved, which is the half that was
 *     never in doubt.
 *
 * Each case is measured TWICE, indicator off and indicator on, and the verdict
 * is the DELTA. An absolute count would be satisfied by a border that was
 * already there.
 *
 * Two negative controls run per bundle, and they are the reason this is evidence
 * rather than a demonstration:
 *
 *   `ring`    the same geometry with the `box-shadow` that `ring-2 ring-ring`
 *             compiled to, applied inline. REQUIRED to paint 0. If this ever
 *             paints, the clipper is not clipping and every pass here is void.
 *   `outward` the shipped spelling with `outline-offset` forced positive.
 *             REQUIRED to paint 0. This is what isolates the negative offset as
 *             the load-bearing part, rather than "an outline" in general.
 *
 * Every consumer of the kit must be listed in the case table. tUnit was the one
 * that was not, which is how two live `focus-visible:outline-ring` deletions
 * shipped in it unnoticed.
 *
 * NOT in `verify`, for two reasons: it needs tELS, tAFK, tCAD, tUnit and
 * tRadio/server BUILT first and `verify` does not build them, and
 * `shared/ts/build/nui-chromium.ts` is Windows-only (a `Win_x64` snapshot,
 * `chrome-win/chrome.exe`, `powershell Expand-Archive`) while `verify` must run
 * on Linux. `probe:preview` is out for that second reason too.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const TSCRIPTS = resolve(import.meta.dir, "../..");

/** A pixel predicate, so a white indicator and a magenta one share one counter. */
type Ink = "accent" | "white";

interface Case {
  /** Reported name. */
  readonly name: string;
  /** The real component source the class string is lifted from, asserted verbatim. */
  readonly source: string;
  /** The class string under test, exactly as that source spells it. */
  readonly classes: string;
  /**
   * How the indicator is turned on.
   *   `tab`    a real Tab keypress lands focus on the target
   *   `tab-in` a real Tab keypress lands focus on a CHILD (for focus-within)
   *   `attr`   zag's mirrored attribute is set, which is what Ark does
   *   `static` the class string is not conditional on focus at all
   */
  readonly trigger: "tab" | "tab-in" | "attr" | "static";
  /** `input` where the real element is a text field, else `button`/`div`. */
  readonly tag: "button" | "input" | "div";
  /**
   * Mount the target with `tabindex="0"`, because the real element has it.
   *
   * NOT A CONVENIENCE. A `div` is not focusable, so a `tab` trigger on one
   * lands the Tab somewhere else entirely and the case measures zero -- which
   * reads exactly like a broken indicator rather than like a mis-specified
   * probe. tUnit's `ElementList` row is a real `role="option"` div carrying
   * `tabindex={0}` and its OWN `focus-visible:` utilities, so it is genuinely a
   * keyboard-focusable div and must be mounted as one. The `tab-in` trigger is
   * not the same thing: that is for `focus-within`, where the focus lands on a
   * CHILD and the parent never receives it.
   */
  readonly focusable?: boolean;
  /**
   * Skip the `outward` negative control for this case, because its premise does
   * not hold here.
   *
   * NOT A TOLERANCE, and not a way to quiet a control that is telling you
   * something. `outward` forces `outline-offset` positive and REQUIRES 0 ink,
   * which isolates the negative offset as the load-bearing part. That is only
   * true when the target is flush with the `overflow: hidden` clipper on all four
   * sides -- which every case mounting a bare element with no intrinsic box is.
   *
   * `.prop-input` is not: it sets its own `padding: 6px 9px` and takes its
   * intrinsic input height, so its top and bottom edges sit INSIDE the clipper
   * and an outline 2px outward of them is not clipped at all. Measured: 12 px of
   * ink. For that element the negative offset genuinely is not what makes the
   * affordance visible -- its own box is -- so asserting 0 here would be
   * asserting something false about the geometry.
   *
   * The `ring` control still runs, and it is the one that proves the clipper is
   * clipping at all.
   */
  readonly skipOutwardControl?: boolean;
  readonly ink: Ink;
}

interface Bundle {
  readonly name: string;
  /**
   * The built stylesheet. Located by prefix, because the filename is usually
   * content-hashed -- but the hash is optional: see `newestCss`.
   */
  readonly cssDir: string;
  readonly cssPrefix: string;
  /** Theme tokens this bundle's rules read, in the dialect its uno.config sets. */
  readonly tokens: Record<string, string>;
  /**
   * Whether the shared preset's nui blocklist reaches this bundle. False for
   * the one dual-home app, which carries `nuiElevationException: true` and is
   * exempt on purpose -- a ring rule there is reported, not failed.
   */
  readonly blocklisted: boolean;
  readonly cases: readonly Case[];
}

/** 300 100% 50% is magenta: absent from every palette here, so it cannot be mistaken. */
const HSL_TOKENS = {
  "--ring": "300 100% 50%",
  "--primary": "300 100% 50%",
  "--border": "0 0% 20%",
  "--input": "0 0% 10%",
  "--background": "0 0% 0%",
  "--foreground": "0 0% 100%",
};

/** The same magenta, for a bundle whose tokens are whole colours (`colorSyntax: "value"`). */
const VALUE_TOKENS = {
  "--ring": "rgb(255, 0, 255)",
  "--ring-rgb": "255, 0, 255",
  "--accent-raw": "rgb(255, 0, 255)",
  "--primary": "rgb(255, 0, 255)",
  "--border": "rgb(51, 51, 51)",
  "--input": "rgb(26, 26, 26)",
  "--background": "rgb(0, 0, 0)",
  "--foreground": "rgb(255, 255, 255)",
};

const FOCUS_VISIBLE =
  "focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid " +
  "focus-visible:outline-ring/40 focus-visible:-outline-offset-1";

/**
 * tUnit's spelling, which is NOT `FOCUS_VISIBLE` and must not be unified with it.
 *
 * Two real differences, both in the shipped source: there is no
 * `focus-visible:border-ring` (neither element has a border to tint), and the
 * colour is the full-opacity `outline-ring` rather than `outline-ring/40`. Both
 * strings are asserted verbatim against their components, so folding them into
 * one constant would fail the verbatim check rather than tidying anything.
 */
const TUNIT_FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:-outline-offset-1";

const BUNDLES: readonly Bundle[] = [
  {
    name: "tELS/client/web",
    blocklisted: true,
    cssDir: `${TSCRIPTS}/tELS/client/ui/assets`,
    cssPrefix: "index-",
    tokens: HSL_TOKENS,
    cases: [
      {
        name: "select trigger, real Tab",
        source: "tELS/client/web/src/components/ui/select.tsx",
        classes: `outline-none ${FOCUS_VISIBLE}`,
        trigger: "tab",
        tag: "button",
        ink: "accent",
      },
      {
        name: "LED drag-over indicator (static)",
        source: "tELS/client/web/src/components/LEDList.tsx",
        classes: "outline-2 outline-solid outline-primary -outline-offset-2",
        trigger: "static",
        tag: "div",
        ink: "accent",
      },
      {
        name: "community config name field, real Tab",
        source: "tELS/client/web/src/components/CommunityConfigsPanel.tsx",
        classes:
          "outline-none focus:border-ring focus:outline-2 focus:outline-solid " +
          "focus:outline-ring/40 focus:-outline-offset-1",
        trigger: "tab",
        tag: "input",
        ink: "accent",
      },
    ],
  },
  {
    name: "tAFK/client/web",
    blocklisted: true,
    cssDir: `${TSCRIPTS}/tAFK/client/ui/assets`,
    cssPrefix: "index-",
    tokens: HSL_TOKENS,
    cases: [
      {
        /*
         * RETARGETED. This case used to name
         * `tAFK/client/web/src/components/ui/input.tsx` and a six-utility focus
         * string. That file is GONE -- tAFK's Input converged into
         * `@tlib/shared/ui/input`, whose affordance is one hand-written class,
         * `.prop-input` in `@tlib/shared/css/surface.css`, not a utility string.
         * So the old case could not pass: the probe reads `source` off disk and
         * threw ENOENT before tCAD, tUnit and tRadio's bundles were reached at
         * all.
         *
         * It is still tAFK's real input, and the rule is still in tAFK's built
         * sheet (`.prop-input` is emitted there), so the paint measurement is
         * unchanged in substance -- it just measures the class the control
         * actually carries. `:focus` with `outline: 2px solid hsl(var(--ring)/0.4)`
         * at `outline-offset: -1px`, which is the same affordance the deleted
         * utility string spelt.
         */
        name: "input, real Tab",
        source: "tLib/shared/css/surface.css",
        classes: "prop-input",
        trigger: "tab",
        tag: "input",
        ink: "accent",
        skipOutwardControl: true,
      },
      {
        name: "editor bar button, real Tab",
        source: "tAFK/client/web/src/components/EditorHud.tsx",
        classes: `outline-none ${FOCUS_VISIBLE}`,
        trigger: "tab",
        tag: "button",
        ink: "accent",
      },
      {
        name: "sequence row, focus-within via a real Tab into its child",
        source: "tAFK/client/web/src/components/EditorHud.tsx",
        classes:
          "focus-within:border-ring focus-within:outline-2 focus-within:outline-solid " +
          "focus-within:outline-ring/40 focus-within:-outline-offset-1",
        trigger: "tab-in",
        tag: "div",
        ink: "accent",
      },
    ],
  },
  {
    name: "tCAD/client/web",
    blocklisted: true,
    cssDir: `${TSCRIPTS}/tCAD/client/ui/assets`,
    cssPrefix: "index-",
    tokens: HSL_TOKENS,
    cases: [
      {
        name: "selected call marker (static)",
        source: "tCAD/client/web/src/screens/dispatch/map/panel.tsx",
        classes: "border-white outline-1 outline-solid outline-white -outline-offset-1",
        trigger: "static",
        tag: "button",
        ink: "white",
      },
    ],
  },
  {
    /*
     * tUnit WAS NOT COVERED HERE UNTIL 2026-10-07, AND THAT IS WHY ITS TWO
     * DEFECTS WENT UNNOTICED.
     *
     * Both were the same `unocss-merge` 0.10.0 fault, in the outline namespace:
     * a POSITIVE `outline-offset-*` and an outline COLOUR are filed into one
     * conflict group and the colour is deleted. `ElementList.tsx`'s rows and
     * `CharacterEditor.tsx`'s slot chips each shipped without
     * `focus-visible:outline-ring` and painted focus in `currentColor` instead
     * of `--ring`. Every class involved is real and resolves to CSS, so nothing
     * reported it and no review would have.
     *
     * THIS PROBE WOULD NOT HAVE CAUGHT THEM EITHER, AND SAYING SO IS THE
     * POINT OF THIS NOTE. It measures the class string the component really
     * ships; both defects were in the MERGED OUTPUT of `cn()`, so the shipped
     * string was already the broken one and this probe would have measured it
     * faithfully and reported a visible indicator in `currentColor`. The gate
     * for that is the `outline-*` shield in `shared/ts/cn.ts` and its contract
     * suite. What this covers is the half that shield cannot: that the settled
     * spelling, in tUnit's OWN built stylesheet, paints pixels in Chromium 103
     * inside a clipping ancestor. Both halves are needed; neither is the other.
     *
     * Tokens are the HSL dialect (`--ring:211 80% 55%` in the built sheet, read
     * through `hsl(var(--ring))`), and `uno.config.ts` sets `target: "nui"` with
     * no `nuiElevationException`, so the ring blocklist applies and is asserted.
     */
    name: "tUnit/client/web",
    blocklisted: true,
    cssDir: `${TSCRIPTS}/tUnit/client/ui/assets`,
    cssPrefix: "index-",
    tokens: HSL_TOKENS,
    cases: [
      {
        // A `role="option"` div with `tabindex={0}` and its own `focus-visible:`
        // utilities — hence `focusable`. The offset is the NEGATIVE spelling, which
        // is what this case exists to keep honest.
        name: "element list row, real Tab onto a focusable div",
        source: "tUnit/client/web/src/components/ElementList.tsx",
        classes: TUNIT_FOCUS,
        trigger: "tab",
        tag: "div",
        focusable: true,
        ink: "accent",
      },
      {
        name: "character slot chip, real Tab",
        source: "tUnit/client/web/src/components/CharacterEditor.tsx",
        classes: TUNIT_FOCUS,
        trigger: "tab",
        tag: "button",
        ink: "accent",
      },
    ],
  },
  {
    name: "tRadio/server/web",
    blocklisted: false,
    // The PROMOTED artefact, not `dist/_vite_temp`. `sync-ui-assets.ts dispatch`
    // moves vite's output into `dist/` and removes the temp dir, so the temp
    // path exists only between those two steps -- reading it made this probe
    // fail after a correct full build.
    cssDir: `${TSCRIPTS}/tRadio/server/dist/assets`,
    cssPrefix: "cef-",
    tokens: VALUE_TOKENS,
    cases: [
      {
        name: "button, real Tab",
        source: "tRadio/server/web/src/components/ui/button.tsx",
        classes:
          "outline-none focus-visible:border-ring focus-visible:outline-2 " +
          "focus-visible:outline-solid focus-visible:outline-[rgba(var(--ring-rgb),0.4)] " +
          "focus-visible:-outline-offset-1",
        trigger: "tab",
        tag: "button",
        ink: "accent",
      },
      {
        // The one that was DEAD before this migration: an Ark `*.Control` is a
        // div, Ark focuses a hidden input, and `focus-visible:` on the part
        // compiled to a selector nothing could ever match.
        name: "switch control, zag's mirrored attribute",
        source: "tRadio/server/web/src/components/ui/switch.tsx",
        classes:
          "outline-none data-[focus-visible]:border-ring data-[focus-visible]:outline-2 " +
          "data-[focus-visible]:outline-solid " +
          "data-[focus-visible]:outline-[rgba(var(--ring-rgb),0.4)] " +
          "data-[focus-visible]:-outline-offset-1",
        trigger: "attr",
        tag: "div",
        ink: "accent",
      },
      {
        name: "911 popout row, focused (static)",
        source: "tRadio/server/web/src/components/PopoutCall911.tsx",
        classes: "outline-2 outline-solid outline-[var(--accent-raw)] -outline-offset-2",
        trigger: "static",
        tag: "div",
        ink: "accent",
      },
    ],
  },
];

// A PNG reader, because the verdict is pixels
//
// Deliberately NOT `sharp`: that is a native binary, it is pinned in tRadio for
// a documented reason, and tLib must stay installable without it. Chromium's
// own screenshots are 8-bit, non-interlaced, colour type 2 or 6, which is all
// this needs to read. Anything else throws rather than being guessed at.
interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly data: Uint8Array;
}

function decodePng(bytes: Uint8Array): Bitmap {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(
      bytes[off + 4],
      bytes[off + 5],
      bytes[off + 6],
      bytes[off + 7]
    );
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const depth = bytes[off + 16];
      colourType = bytes[off + 17];
      const interlace = bytes[off + 20];
      if (depth !== 8) throw new Error(`PNG bit depth ${depth}, expected 8`);
      if (interlace !== 0) throw new Error("interlaced PNG");
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(`PNG colour type ${colourType}, expected 2 or 6`);
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const channels = colourType === 6 ? 4 : 3;
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b)))));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    line.set(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[x] = (line[x] + a) & 0xff;
          break;
        case 2:
          line[x] = (line[x] + b) & 0xff;
          break;
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error(`PNG filter ${filter}`);
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

function countInk(bmp: Bitmap, ink: Ink): number {
  let n = 0;
  for (let i = 0; i < bmp.data.length; i += 4) {
    const r = bmp.data[i];
    const g = bmp.data[i + 1];
    const b = bmp.data[i + 2];
    if (ink === "accent") {
      // Magenta at any opacity over black, and nothing else in the sheet.
      if (r > 40 && b > 40 && g < 40) n++;
    } else if (r > 200 && g > 200 && b > 200) n++;
  }
  return n;
}

// The page
//
// The target FILLS the clipper exactly, which is the whole geometry of the
// defect: an outward stroke then lies entirely outside the clipper's padding box
// and is clipped away, while an inward one lies inside it.
const CLIP_W = 160;
const CLIP_H = 44;

function pageHtml(css: string, tokens: Record<string, string>): string {
  const vars = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
<style>
  html, body { margin: 0; background: #000; }
  :root { ${vars} }
  /* The clipper. Nothing about it is a utility: it is the hostile ancestor. */
  #clip { position: absolute; left: 40px; top: 40px; width: ${CLIP_W}px; height: ${CLIP_H}px; overflow: hidden; background: #000; }
  #target { box-sizing: border-box; width: 100%; height: 100%; display: block; margin: 0; padding: 0;
            background: #000; color: #fff; border: 1px solid transparent; font: 12px monospace; }
  /* A focus stop BEFORE the target, so one Tab from the body lands on it. */
  #before, #inner { position: absolute; left: -9999px; }
</style>
</head><body>
<button id="before" type="button">before</button>
<div id="clip"></div>
<script>
  const clip = document.getElementById("clip");
  window.probe = {
    mount(tag, classes, withInner, focusable) {
      clip.innerHTML = "";
      const el = document.createElement(tag === "input" ? "input" : tag);
      el.id = "target";
      if (tag === "input") el.type = "text";
      // The real element's own tabindex. See \`Case.focusable\`: without it a
      // \`tab\` trigger on a div lands nowhere near the target and measures 0.
      if (focusable) el.setAttribute("tabindex", "0");
      el.className = classes;
      if (withInner) {
        const inner = document.createElement("button");
        inner.id = "inner";
        inner.type = "button";
        el.appendChild(inner);
      }
      clip.appendChild(el);
      document.getElementById("before").focus();
      return true;
    },
    /** Applies a named control to the mounted target, as an inline override. */
    control(kind) {
      const el = document.getElementById("target");
      if (kind === "ring") {
        // What \`ring-2 ring-ring\` compiled to under presetWind3: an OUTWARD,
        // zero-blur box-shadow. Spelled out here rather than classed, because
        // the whole point is that the class is gone from the sheet.
        el.style.outline = "none";
        el.style.boxShadow = "0 0 0 2px rgba(255, 0, 255, 0.4)";
      } else if (kind === "outward") {
        el.style.setProperty("outline-offset", "2px", "important");
      }
      return true;
    },
    attr(on) {
      const el = document.getElementById("target");
      if (on) el.setAttribute("data-focus-visible", "");
      else el.removeAttribute("data-focus-visible");
      return true;
    },
    strip() {
      // Indicator OFF for a static case: drop the outline utilities, keep the rest.
      const el = document.getElementById("target");
      el.className = el.className
        .split(/\\s+/)
        .filter((c) => !/outline/.test(c))
        .join(" ");
      return true;
    },
    activeId() { return document.activeElement ? document.activeElement.id : null; },
  };
</script></body></html>`;
}

// Harness

const failures: string[] = [];
const lines: string[] = [];
function check(ok: boolean, msg: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
}

/**
 * The built stylesheet for one bundle.
 *
 * The hash in the filename is OPTIONAL, and that is not a tolerance -- it is the
 * estate's two real spellings. Most bundles emit vite's default `index-<hash>.css`;
 * `tELS/client/web` sets `assetFileNames: "assets/[name][extname]"` deliberately
 * (see its vite.config.ts: a renamed bundle 404s off FiveM's file table until a
 * `refresh`, and FiveM keys its cache on the file hash, not the name), so it emits
 * a bare `index.css`. Matching only `<prefix>*` made this probe throw
 * "expected exactly one index-*.css ... found 0" on a CORRECT tELS build, so
 * `bun run probe:focus` exited 1 and tELS's cases could never run at all --
 * a gate that cannot pass, which is worse than no gate.
 */
function newestCss(dir: string, prefix: string): string {
  if (!existsSync(dir)) {
    throw new Error(`no built assets at ${dir} -- build the bundle first`);
  }
  // A trailing '-' in the prefix is the hash separator, so it is part of what is
  // optional. `[^.]+` rather than `\w+` because a vite hash can itself contain '-'
  // (tRadio ships `cef-Brz-C1Wx.css`).
  const base = prefix.replace(/-$/, "");
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-[^.]+)?\\.css$`);
  const names = [...new Set(readdirSyncSafe(dir))].filter((n) => pattern.test(n));
  if (names.length !== 1) {
    throw new Error(
      `expected exactly one ${base}.css or ${base}-<hash>.css in ${dir}, ` +
        `found ${names.length}: ${names.join(", ") || "(none)"}`
    );
  }
  return resolve(dir, names[0]);
}

function readdirSyncSafe(dir: string): string[] {
  // `node:fs` readdir, imported lazily so the bracketed repo path is never globbed.
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir);
}

const { launch } = await import("../shared/ts/build/nui-chromium.ts");
const browser = await launch({ headless: true, log: () => {} });
const { page } = browser;

try {
  await page.send("Runtime.enable");
  await page.send("Page.enable");

  for (const bundle of BUNDLES) {
    console.log(`\n── ${bundle.name}`);
    const cssPath = newestCss(bundle.cssDir, bundle.cssPrefix);
    const css = readFileSync(cssPath, "utf8");
    console.log(`     stylesheet: ${cssPath.slice(TSCRIPTS.length + 1)} (${css.length} bytes)`);

    // The sheet must have left the ring namespace behind. A `.ring` emitted from
    // prose is dead CSS, and dead CSS is what makes "search the build for a
    // box-shadow" cry wolf -- so it is reported, not ignored.
    // Both spellings. MEASURED: a class-only pattern reported 0 for tELS while
    // its sheet still carried `[-ring=""]{--un-ring-width:-3px; …}` -- 375 bytes
    // of the full ring box-shadow machinery, emitted through attributify mode
    // from text nobody wrote as a class. Dead CSS that a class-shaped search
    // cannot see is exactly what this check exists to catch.
    const ringRules =
      [...css.matchAll(/\.(?:[a-z-]+\\:)*-?ring(?:\\\/|-|\{|,|\[)/g)].length +
      [...css.matchAll(/\[[a-z:\\-]*-?ring[a-z0-9:\\/-]*=""\]/g)].length;
    if (bundle.blocklisted) {
      check(
        ringRules === 0,
        `${bundle.name}: no ring-namespace rule in the built sheet (${ringRules})`
      );
    } else {
      console.log(`     ring-namespace rules: ${ringRules} (exempt bundle, reported not asserted)`);
    }

    const html = pageHtml(css, bundle.tokens);
    await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const ready = await page.evaluate<boolean>("!!window.probe");
    if (!ready) throw new Error(`${bundle.name}: probe page did not initialise`);

    for (const c of bundle.cases) {
      // The class string must be what the component really ships.
      const src = readFileSync(resolve(TSCRIPTS, c.source), "utf8");
      const spelt = c.classes
        .split(/\s+/)
        .filter((t) => t !== "outline-none")
        .every((t) => src.includes(t));
      check(spelt, `${c.name}: every utility is spelt verbatim in ${c.source.split("/").pop()}`);

      const shoot = async (): Promise<number> => {
        const res = await page.send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { x: 40, y: 40, width: CLIP_W, height: CLIP_H, scale: 1 },
          captureBeyondViewport: false,
        });
        return countInk(decodePng(Buffer.from(res.data, "base64")), c.ink);
      };

      const tab = async (): Promise<void> => {
        for (const type of ["keyDown", "keyUp"] as const) {
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
          });
        }
        await new Promise((r) => setTimeout(r, 60));
      };

      const mount = async (control?: "ring" | "outward"): Promise<void> => {
        await page.evaluate(
          `window.probe.mount(${JSON.stringify(c.tag)}, ${JSON.stringify(c.classes)}, ${c.trigger === "tab-in"}, ${c.focusable === true})`
        );
        if (control) await page.evaluate(`window.probe.control(${JSON.stringify(control)})`);
        await new Promise((r) => setTimeout(r, 60));
      };

      const turnOn = async (): Promise<void> => {
        // One Tab, for both: `mount` leaves focus on #before, and the next
        // focusable is the target itself or -- when the target is not focusable
        // -- the child mounted inside it. Two presses stepped out of the
        // document entirely and the row measured zero, which reads exactly like
        // a broken indicator.
        if (c.trigger === "tab" || c.trigger === "tab-in") await tab();
        else if (c.trigger === "attr") await page.evaluate("window.probe.attr(true)");
        await new Promise((r) => setTimeout(r, 120)); // the outline-color transition
      };

      // The measurement. OFF then ON; the verdict is the delta.
      await mount();
      const off =
        c.trigger === "static"
          ? await (async () => {
              await page.evaluate("window.probe.strip()");
              await new Promise((r) => setTimeout(r, 60));
              return shoot();
            })()
          : await shoot();
      if (c.trigger === "static") await mount();
      await turnOn();
      if (c.trigger === "tab" || c.trigger === "tab-in") {
        const active = await page.evaluate<string | null>("window.probe.activeId()");
        const want = c.trigger === "tab-in" ? "inner" : "target";
        check(active === want, `${c.name}: a real Tab landed on #${want} (landed on #${active})`);
      }
      const on = await shoot();
      const delta = on - off;
      lines.push(
        `${bundle.name.padEnd(19)} ${c.name.padEnd(52)} ${String(off).padStart(5)} -> ${String(on).padStart(5)}  (+${delta})`
      );
      check(delta > 0, `${c.name}: the indicator PAINTS -- ${off} -> ${on} px (+${delta})`);

      // Control 1: the outward box-shadow the ring compiled to. Must be 0.
      await mount("ring");
      const ringOff = await shoot();
      await turnOn();
      const ringOn = await shoot();
      check(
        ringOn - ringOff === 0,
        `${c.name}: CONTROL the outward box-shadow a ring compiles to paints 0 inside the clipper (${ringOn - ringOff})`
      );

      // Control 2: the same outline, pushed outward. Must be 0.
      //
      // Skipped only where the target is not flush with the clipper, in which case
      // nothing is clipped and 0 would be the wrong assertion -- see
      // `Case.skipOutwardControl`. Reported either way, so a skip is never silent.
      if (c.skipOutwardControl) {
        console.log(
          `  skip  ${c.name}: CONTROL positive offset -- target is not flush with the clipper`
        );
      } else {
        await mount("outward");
        const outOff = await shoot();
        await turnOn();
        const outOn = await shoot();
        check(
          outOn - outOff === 0,
          `${c.name}: CONTROL the same outline at a POSITIVE offset paints 0 (${outOn - outOff})`
        );
      }
    }
  }
} finally {
  await browser.close();
}

console.log(`\nAccent pixels inside a clipping ancestor, indicator off -> on:`);
for (const l of lines) console.log(`  ${l}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} focus-paint check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: focus paints, in Chromium 103, inside an overflow-hidden ancestor`);
