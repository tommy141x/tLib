/**
 * Render every shipped layout of a resource, in every state worth looking at, as a
 * high-resolution PNG over a transparent backdrop.
 *
 * Product photography: a folder of cut-out device shots that can go straight onto
 * the website or a store listing with no screenshot tool, running game, or
 * designer erasing a background by hand.
 *
 * Shared because four resources paint their HUD through the same `data-hud-*`
 * grammar, so the only things that differ are the declaration prefix, the layouts
 * folder and which states are interesting. The states come from the resource's
 * own `UiManifest` presets by default: those are already the curated situations
 * the Studio offers a creator, so a preset added for the editor shows up here
 * without anybody remembering to.
 *
 * Zero npm dependencies: Chromium is the one from the Playwright browser cache,
 * driven through its command line rather than a protocol client. If it is not
 * installed the pages are still written and can be opened in any browser.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scanLayout } from "../hud-layout-scan.ts";
import { buildHudPreviewScript } from "../hud-preview-script.ts";
import { applyPreset, defaultStateFromManifest, type UiManifest } from "../ui-manifest.ts";

/** One named situation to render each layout in. */
export interface GalleryState {
  /** Filename-safe id; becomes the `<layout>--<id>.png` suffix. */
  id: string;
  /** Human label, for the log line. */
  label: string;
  state: Record<string, unknown>;
}

export interface HudGalleryOptions {
  /** Directory holding one folder per layout, each with a `ui.html`. */
  layoutsDir: string;
  /** Where the PNGs go, flat. Existing shots of the same layouts are replaced. */
  outDir: string;
  /** Declaration namespace: `"radar"` reads `data-radar-width`. tELS and tDetector use `"radio"`. */
  prefix: string;
  /** Situations to render. Usually `statesFromManifest(theResourcesManifest)`. */
  states: GalleryState[];
  /**
   * Global update function a layout installs for itself, e.g. `"__telsLayoutUpdate"` — the same
   * value the marketplace panel is given as `previewFn`.
   */
  previewFn?: string;
  deviceClasses?: readonly string[];
  defaultDeviceClass?: string;
  /**
   * Device pixel ratio of the capture. 3 gives a 520x157 device a 1560x471 PNG,
   */
  scale?: number;
  /**
   * Page background. `null` — the default — captures real alpha, so the device is
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
}

/**
 * The manifest's presets, as gallery states, with its declared defaults first.
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
 * Every one of these resources lives under a `[tScripts]` directory, and an
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
  previewFn?: string;
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
</head><body>${opts.ui}${buildHudPreviewScript(opts.previewFn ?? null, opts.state)}</body></html>`;
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

  const pagesDir = mkdtempSync(join(tmpdir(), "hud-gallery-"));
  mkdirSync(opts.outDir, { recursive: true });

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

    for (const name of readdirSync(opts.outDir)) {
      if (name.startsWith(`${layout}--`) && name.endsWith(".png")) {
        unlinkSync(join(opts.outDir, name));
      }
    }
    rmSync(join(opts.outDir, layout), { recursive: true, force: true });
    rmSync(join(opts.outDir, "index.html"), { force: true });

    for (const state of opts.states) {
      const html = page({
        ui,
        layoutDir,
        state: state.state,
        width,
        height,
        background,
        previewFn: opts.previewFn,
      });
      writeFileSync(join(pagesDir, `${layout}.${state.id}.html`), html);
      shots.push({
        layout,
        state: state.id,
        label: state.label,
        file: join(opts.outDir, `${layout}--${state.id}.png`),
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
          "--disable-lcd-text",
          "--hide-scrollbars",
          // ARGB. `00` alpha is what makes the PNG a cut-out rather than a white plate;
          // Chromium otherwise composites the page onto opaque white before encoding.
          `--default-background-color=${background === null ? "00000000" : "ffffffff"}`,
          `--force-device-scale-factor=${scale}`,
          `--window-size=${shot.width},${shot.height}`,
          // `--screenshot` captures at load and would race it — sometimes catching the page
          // before it has painted, which is indistinguishable from a layout that drew nothing.
          // Virtual time runs those timers to completion first, deterministically.
          //
          // Only passed when there IS such a function: it also fast-forwards CSS animations,
          // so adding it unconditionally would change the output of every purely declarative
          // layout that already renders correctly.
          ...(opts.previewFn ? ["--virtual-time-budget=5000"] : []),
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
    // Only once the shots are taken — with no Chromium the pages ARE the output.
    rmSync(pagesDir, { recursive: true, force: true });
  }

  return { outDir: opts.outDir, layouts, shots, failed, chromium };
}
