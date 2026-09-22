/**
 * Render every shipped layout of a resource, in every state worth looking at, as a
 * high-resolution PNG over a transparent backdrop.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Product photography. The output is a folder of cut-out device shots that can be
 * dropped straight onto the website, a store listing or a Discord post without a
 * screenshot tool, a running game, or a designer erasing a background by hand.
 *
 * ── Why it is shared ────────────────────────────────────────────────────────
 *
 * Four resources paint their HUD through the SAME `data-hud-*` grammar — it is
 * HudBinder's, and `hud-preview-script.ts` is the string form of it that the
 * marketplace preview and this renderer both use. So the only things that differ
 * between resources are the declaration prefix (`data-radar-width` vs
 * `data-radio-width`), the layouts folder, and which states are interesting. All
 * three are parameters. tDetector had the only copy of this and it was a bespoke
 * script with hard-coded 520x240 pages; every other resource had nothing.
 *
 * ⚠️ The states come from the resource's own `UiManifest` presets by default (see
 * `statesFromManifest`). That is deliberate: the presets are already the curated
 * "situations" the Studio offers a creator, they are already covered by each
 * resource's manifest test, and deriving the gallery from them means a preset
 * added for the editor shows up here without anybody remembering to.
 *
 * ── Zero npm dependencies ───────────────────────────────────────────────────
 *
 * Chromium is the one from the Playwright browser cache, driven through its
 * command line rather than a protocol client, so no resource takes a dependency
 * to render its own marketing art. If it is not installed the pages are still
 * written and can be opened in any browser.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanLayout } from "../hud-layout-scan.ts";
import { buildHudPreviewScript } from "../hud-preview-script.ts";
import { applyPreset, defaultStateFromManifest, type UiManifest } from "../ui-manifest.ts";

/** One named situation to render each layout in. */
export interface GalleryState {
  /** Filename-safe id; becomes `<layout>/<id>.png`. */
  id: string;
  /** Human label for the contact sheet. */
  label: string;
  state: Record<string, unknown>;
}

export interface HudGalleryOptions {
  /** Directory holding one folder per layout, each with a `ui.html`. */
  layoutsDir: string;
  /** Where the PNGs and the contact sheet go. Existing output for the same layouts is replaced. */
  outDir: string;
  /** Declaration namespace: `"radar"` reads `data-radar-width`. tELS and tDetector use `"radio"`. */
  prefix: string;
  /** Situations to render. Usually `statesFromManifest(theResourcesManifest)`. */
  states: GalleryState[];
  /** Title for the contact sheet. */
  title?: string;
  deviceClasses?: readonly string[];
  defaultDeviceClass?: string;
  /**
   * Device pixel ratio of the capture. 3 gives a 520x157 device a 1560x471 PNG,
   * which survives being placed at any size a web page or a store listing wants.
   */
  scale?: number;
  /**
   * Page background. `null` — the default — captures real alpha, so the device is
   * a cut-out. A CSS colour instead when the point is to LOOK at the layout rather
   * than to publish it: a transparent shot of a dark device is unreadable in an
   * image viewer that checkerboards.
   */
  background?: string | null;
  /** CSS px of empty space around the device, so a glow or shadow is not clipped. */
  padding?: number;
  /** Render only these layout names. Default: every folder with a `ui.html`. */
  only?: readonly string[];
  /** Chassis size to fall back on when a layout declares none. */
  fallbackSize?: { width: number; height: number };
  log?: (message: string) => void;
}

export interface GalleryShot {
  layout: string;
  state: string;
  label: string;
  /** Path of the written PNG, or null when Chromium was unavailable. */
  file: string | null;
  /** Capture size in CSS px, before the device scale factor. */
  width: number;
  height: number;
}

export interface GalleryResult {
  outDir: string;
  layouts: string[];
  shots: GalleryShot[];
  /** Shots whose Chromium invocation failed. Empty on a clean run. */
  failed: GalleryShot[];
  chromium: string | null;
  sheet: string | null;
}

/**
 * The manifest's presets, as gallery states, with its declared defaults first.
 *
 * Each preset is applied ON TOP of the full default state rather than used raw:
 * a preset only names the keys it changes, and a layout bound to a key no preset
 * mentions would otherwise render blank in every shot.
 */
export function statesFromManifest(manifest: UiManifest): GalleryState[] {
  const base = defaultStateFromManifest(manifest);
  const out: GalleryState[] = [{ id: "default", label: "Default", state: base }];
  for (const [id, preset] of Object.entries(manifest.presets)) {
    out.push({ id: safeId(id), label: preset.label, state: applyPreset(base, preset) });
  }
  return out;
}

function safeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** The one place every resource's gallery lands, so there is a single folder to pick art from. */
export interface GalleryCli {
  out: string;
  scale: number;
  background: string | null;
  only: string[];
}

/**
 * The flags every resource's `gallery` script accepts, parsed once here rather than
 * three times slightly differently.
 *
 *   --out <dir>       destination                    (default: the caller's `defaultOut`)
 *   --scale N         device pixel ratio, 1-6        (default 3)
 *   --background CSS  opaque backdrop instead of alpha; `transparent` restores the default
 *   --layouts a,b     render only these
 *
 * `defaultOut` is the caller's rather than a constant here, because each resource keeps its own
 * gallery beside its own art — `<resource>/assets/gallery`. `assets/` is git-ignored and is not in
 * the production stager's allow-list, so a gallery can be regenerated freely without ever reaching
 * a commit or a customer's package.
 */
export function parseGalleryCli(argv: readonly string[], defaultOut: string): GalleryCli {
  const cli: GalleryCli = {
    out: defaultOut,
    scale: 3,
    background: null,
    only: [],
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--out":
        cli.out = value(i++, flag);
        break;
      case "--scale": {
        const n = Number(value(i++, flag));
        if (!Number.isInteger(n) || n < 1 || n > 6)
          throw new Error(`--scale must be an integer 1-6, got ${n}`);
        cli.scale = n;
        break;
      }
      case "--background": {
        const v = value(i++, flag);
        cli.background = v === "transparent" ? null : v;
        break;
      }
      case "--layouts":
        cli.only = value(i++, flag)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  return cli;
}

/**
 * Chromium from the Playwright browser cache, newest build first.
 *
 * Playwright is a dev-machine tool here, not a dependency of any resource — nothing
 * in this file is needed to build or run one. A missing browser is not an error;
 * the caller still gets the HTML pages.
 */
export function findChromium(): string | null {
  const base = join(homedir(), "AppData", "Local", "ms-playwright");
  if (existsSync(base)) {
    const builds = readdirSync(base)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => Number.parseInt(b.slice(9), 10) - Number.parseInt(a.slice(9), 10));
    for (const build of builds) {
      for (const dir of ["chrome-win64", "chrome-win"]) {
        const exe = join(base, build, dir, "chrome.exe");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

/**
 * A `file://` URL Chromium will actually open.
 *
 * ⚠️ Every one of these resources lives under a `[tScripts]` directory, and an
 * unescaped `[` makes Chromium drop the path and render `about:blank` — which
 * screenshots as a blank image with exit code 0, so it looks like it worked.
 */
export function fileUrl(absolutePath: string): string {
  return `file:///${absolutePath.replace(/\\/g, "/").replace(/\[/g, "%5B").replace(/\]/g, "%5D")}`;
}

export function listLayouts(layoutsDir: string): string[] {
  if (!existsSync(layoutsDir)) return [];
  return readdirSync(layoutsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(layoutsDir, d.name, "ui.html")))
    .map((d) => d.name)
    .sort();
}

function page(opts: {
  ui: string;
  layoutDir: string;
  state: Record<string, unknown>;
  width: number;
  height: number;
  background: string | null;
}): string {
  // The layout's own <img src="…"> are relative to its folder, so the base href has to point
  // there and not at the directory these pages are written into.
  const base = `${fileUrl(opts.layoutDir)}/`;
  const bg = opts.background ?? "transparent";
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
<style>
  html,body{margin:0;padding:0;background:${bg};}
  body{display:flex;align-items:center;justify-content:center;width:${opts.width}px;height:${opts.height}px;overflow:hidden;}
</style>
</head><body>${opts.ui}${buildHudPreviewScript(null, opts.state)}</body></html>`;
}

export function renderHudGallery(opts: HudGalleryOptions): GalleryResult {
  const log = opts.log ?? (() => {});
  const scale = opts.scale ?? 3;
  const padding = opts.padding ?? 16;
  const background = opts.background ?? null;
  const fallback = opts.fallbackSize ?? { width: 520, height: 240 };

  const all = listLayouts(opts.layoutsDir);
  const layouts = opts.only?.length ? all.filter((l) => opts.only?.includes(l)) : all;
  if (layouts.length === 0) throw new Error(`no layouts with a ui.html under ${opts.layoutsDir}`);
  if (opts.states.length === 0) throw new Error("no states to render");

  const pagesDir = join(opts.outDir, ".pages");
  rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });

  const shots: GalleryShot[] = [];
  for (const layout of layouts) {
    const layoutDir = join(opts.layoutsDir, layout);
    const ui = readFileSync(join(layoutDir, "ui.html"), "utf8");
    const scan = scanLayout(ui, {
      prefix: opts.prefix,
      deviceClasses: opts.deviceClasses,
      defaultDeviceClass: opts.defaultDeviceClass,
    });
    // The declared chassis size is the device's own footprint; the window has to be big
    // enough to hold it at its default scale or Chromium crops rather than shrinks.
    const width = Math.ceil((scan.width ?? fallback.width) * scan.defaultScale) + padding * 2;
    const height = Math.ceil((scan.height ?? fallback.height) * scan.defaultScale) + padding * 2;

    // Replace this layout's previous shots rather than the whole output folder: `outDir`
    // comes from the command line and wiping an arbitrary directory is not this script's job.
    const layoutOut = join(opts.outDir, layout);
    rmSync(layoutOut, { recursive: true, force: true });
    mkdirSync(layoutOut, { recursive: true });

    for (const state of opts.states) {
      const html = page({ ui, layoutDir, state: state.state, width, height, background });
      writeFileSync(join(pagesDir, `${layout}.${state.id}.html`), html);
      shots.push({
        layout,
        state: state.id,
        label: state.label,
        file: join(layoutOut, `${state.id}.png`),
        width,
        height,
      });
    }
  }

  const chromium = findChromium();
  const failed: GalleryShot[] = [];
  if (chromium === null) {
    log(`  no Playwright Chromium found — pages written to ${pagesDir}, open them in a browser`);
    for (const shot of shots) shot.file = null;
  } else {
    for (const shot of shots) {
      const dest = shot.file;
      if (dest === null) continue;
      const src = fileUrl(join(pagesDir, `${shot.layout}.${shot.state}.html`));
      const res = spawnSync(
        chromium,
        [
          "--headless",
          "--no-sandbox", // the browser cache lives outside the sandbox's allowed roots
          "--disable-gpu",
          // Grayscale antialiasing. With LCD subpixel text these shots put a blue fringe on
          // narrow glyphs — "DIM" reads as blue text on a white-lettered key — which is a
          // screenshot artifact and not something the layout does. It has already been mistaken
          // for a real defect once. It is worse on a transparent capture, where the fringe has
          // no background to blend into and survives into whatever the art is placed on.
          "--disable-lcd-text",
          "--hide-scrollbars",
          // ARGB. `00` alpha is what makes the PNG a cut-out rather than a white plate;
          // Chromium otherwise composites the page onto opaque white before encoding.
          `--default-background-color=${background === null ? "00000000" : "ffffffff"}`,
          `--force-device-scale-factor=${scale}`,
          `--window-size=${shot.width},${shot.height}`,
          `--screenshot=${dest}`,
          src,
        ],
        { stdio: "ignore" }
      );
      // Exit code 0 is necessary but not sufficient — Chromium reports success for a page
      // it never loaded, so the file has to actually exist before this counts as a shot.
      if (res.status !== 0 || !existsSync(dest)) {
        failed.push(shot);
        shot.file = null;
      }
    }
    log(`  ${shots.length - failed.length}/${shots.length} shots at ${scale}x`);
  }

  const sheet = writeContactSheet(
    opts.outDir,
    opts.title ?? "UI gallery",
    shots,
    scale,
    background
  );
  return { outDir: opts.outDir, layouts, shots, failed, chromium, sheet };
}

/**
 * A single offline page listing every shot, so the folder can be browsed rather than
 * opened one PNG at a time. Checkerboarded, because a transparent shot of a black
 * device on a white page reads as a missing image.
 */
export function writeContactSheet(
  outDir: string,
  title: string,
  shots: readonly GalleryShot[],
  scale: number,
  background: string | null
): string | null {
  const written = shots.filter((s) => s.file !== null);
  if (written.length === 0) return null;

  const byLayout = new Map<string, GalleryShot[]>();
  for (const shot of written) {
    const list = byLayout.get(shot.layout) ?? [];
    list.push(shot);
    byLayout.set(shot.layout, list);
  }

  const sections = [...byLayout.entries()].map(([layout, list]) => {
    const cards = list
      .map(
        (s) =>
          `<figure><img src="./${layout}/${s.state}.png" alt="${layout} ${s.label}" loading="lazy">` +
          `<figcaption>${s.label}<small>${s.width * scale}×${s.height * scale}</small></figcaption></figure>`
      )
      .join("");
    return `<section><h2>${layout}</h2><div class="grid">${cards}</div></section>`;
  });

  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:24px;background:#141414;color:#e6e6e6;font:14px/1.4 system-ui,sans-serif}
  h1{font-size:18px;margin:0 0 4px}
  p.meta{margin:0 0 24px;color:#8a8a8a}
  h2{font-size:15px;margin:32px 0 10px;color:#9ecbff}
  .grid{display:flex;flex-wrap:wrap;gap:16px}
  figure{margin:0;background:${background === null ? "repeating-conic-gradient(#2a2a2a 0 25%,#1d1d1d 0 50%) 0 0/20px 20px" : background};border:1px solid #333;border-radius:6px;padding:10px}
  img{display:block;max-width:520px;height:auto}
  figcaption{margin-top:8px;color:#cfcfcf;display:flex;justify-content:space-between;gap:12px}
  small{color:#7a7a7a}
</style>
<h1>${title}</h1>
<p class="meta">${written.length} images · ${byLayout.size} layouts · ${scale}× · ${background === null ? "transparent background" : `background ${background}`}</p>
${sections.join("\n")}
`;
  const file = join(outDir, "index.html");
  writeFileSync(file, html);
  return file;
}
