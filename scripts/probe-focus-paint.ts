/**
 * Does the focus indicator actually PAINT PIXELS? `bun run probe:focus`
 *
 * The shared kit draws focus as a negative-offset `outline`, not a `ring-*`:
 * `ring-*` compiles to an outward `box-shadow` under presetWind3, which an
 * `overflow: hidden` ancestor clips to nothing, while an inward outline
 * survives. Everything here reads the SHIPPED artefacts: the real built CSS
 * per bundle (exits 1 if unbuilt), class strings asserted verbatim against
 * their component source, focus reached via a real CDP Tab keypress (not
 * `.focus()`, which Chromium's `:focus-visible` heuristic ignores on a
 * button), and the verdict is a pixel count off `Page.captureScreenshot` in
 * the pinned Chromium 103 CEF actually runs -- not `getComputedStyle`, which
 * only proves the cascade resolved.
 *
 * Each case is measured off vs on; the verdict is the delta, so a
 * pre-existing border can't fake a pass. Two per-case negative controls must
 * paint 0: `ring` (the box-shadow a ring compiles to, inline) proves the
 * clipper clips; `outward` (same outline, positive offset) isolates the
 * negative offset as what matters. tUnit was missing from the case table
 * until 2026-10-07, which is how two live `focus-visible:outline-ring`
 * deletions shipped there unnoticed -- every consumer must be listed.
 *
 * Not in `verify`: needs tLS/tAFK/tCAD/tUnit/tRadio-server built first, and
 * `shared/ts/build/nui-chromium.ts` is Windows-only, while `verify` runs on
 * Linux. `probe:preview` is excluded for the same Windows-only reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const TSCRIPTS = resolve(import.meta.dir, "../..");

/** A pixel predicate, so a white indicator and a magenta one share one counter. */
type Ink = "accent" | "white";

interface Case {
  readonly name: string;
  /** Real component source the class string is lifted from, asserted verbatim. */
  readonly source: string;
  readonly classes: string;
  /**
   * How the indicator is turned on: `tab`/`tab-in` a real Tab keypress lands
   * on the target or (for focus-within) a CHILD; `attr` sets zag's mirrored
   * attribute, as Ark does; `static` is not focus-conditional at all.
   */
  readonly trigger: "tab" | "tab-in" | "attr" | "static";
  readonly tag: "button" | "input" | "div";
  /**
   * Mount with `tabindex="0"` because the real element has it -- a plain
   * `div` isn't focusable, so `tab` lands elsewhere and measures a false 0.
   * tUnit's `ElementList` row is a real `role="option"` div with its own
   * `tabindex={0}` and `focus-visible:` utilities.
   */
  readonly focusable?: boolean;
  /**
   * Skip the `outward` control (which requires 0 ink at a positive offset)
   * when the target isn't flush with the clipper on all sides. `.prop-input`'s
   * own padding keeps its edges inside the clipper, so a positive offset there
   * measured 12px of real ink -- a true 0 could not be asserted. `ring` still
   * runs for that case.
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
 * tUnit's spelling, not `FOCUS_VISIBLE`: no `border-ring` (neither element
 * has a border to tint) and full-opacity `outline-ring` not `outline-ring/40`.
 * Both are asserted verbatim against their components, so unifying them would
 * fail that check.
 */
const TUNIT_FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:-outline-offset-1";

const BUNDLES: readonly Bundle[] = [
  {
    name: "tLS/client/web",
    blocklisted: true,
    cssDir: `${TSCRIPTS}/tLS/client/ui/assets`,
    cssPrefix: "index-",
    tokens: HSL_TOKENS,
    cases: [
      {
        name: "select trigger, real Tab",
        source: "tLS/client/web/src/components/ui/select.tsx",
        classes: `outline-none ${FOCUS_VISIBLE}`,
        trigger: "tab",
        tag: "button",
        ink: "accent",
      },
      {
        name: "LED drag-over indicator (static)",
        source: "tLS/client/web/src/components/LEDList.tsx",
        classes: "outline-2 outline-solid outline-primary -outline-offset-2",
        trigger: "static",
        tag: "div",
        ink: "accent",
      },
      {
        name: "community config name field, real Tab",
        source: "tLS/client/web/src/components/CommunityConfigsPanel.tsx",
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
        // Retargeted from tAFK's own input.tsx utility string: that file is
        // gone, Input converged into @tlib/internal/ui/input's `.prop-input`
        // class in shared/css/surface.css. Same affordance, different source.
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
    // tUnit was missing from this table until 2026-10-07: `unocss-merge` 0.10.0
    // files a positive `outline-offset-*` and an outline colour into one conflict
    // group and drops the colour, so ElementList's rows and CharacterEditor's slot
    // chips shipped without `focus-visible:outline-ring` and painted in
    // `currentColor`. This probe would not have caught that either -- it measures
    // the shipped class string faithfully, and that string was already the merged,
    // broken one. The `outline-*` shield in shared/ts/cn.ts covers the merge.
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
        // DEAD before this migration: an Ark `*.Control` is a div, Ark focuses a
        // hidden input, and `focus-visible:` on the part compiled to a selector
        // nothing could ever match.
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

// A PNG reader, because the verdict is pixels. NOT `sharp`: a native binary, and
// tLib must stay installable without it. Chromium's own screenshots are 8-bit,
// non-interlaced, colour type 2 or 6; anything else throws rather than being
// guessed at.
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
 * The built stylesheet for one bundle. The hash in the filename is optional:
 * tLS/client/web sets `assetFileNames: "assets/[name][extname]"` (FiveM keys
 * its cache on the file hash, not the name, so a renamed bundle 404s until a
 * `refresh`), so it emits a bare `index.css` while other bundles emit vite's
 * default `index-<hash>.css`. Matching only `<prefix>*` made this throw on a
 * correct tLS build.
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

    // Both the class and attributify spellings: a class-only pattern reported
    // 0 for tLS while its sheet still carried `[-ring=""]{--un-ring-width:…}`
    // via attributify mode, 375 bytes of ring box-shadow machinery a
    // class-shaped search can't see.
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
