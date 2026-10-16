/**
 * Every state of the shared 3D prop editor, photographed, into one flat folder —
 * out of whichever consumer's real NUI bundle you point it at.
 *
 * Why this is shared
 *
 * `@tlib/internal/prop-editor` is one component mounted by three resources, and its
 * chrome is drawn entirely from token NAMES (`bg-card`, `text-muted-foreground`,
 * `--radius`). The VALUES behind those names are per-resource — tRadio declares
 * its own set on `.radio-settings-root`, tRadar and tDetector inherit tLib's from
 * `theme-tokens.css` on `:root` — so "the editor, themed as tRadar" is a
 * genuinely different and genuinely interesting picture from "the editor, themed
 * as tRadio". Shooting all three is how "one shared look, per-resource token
 * values" gets checked rather than assumed.
 *
 * The driver lived in `tRadio/scripts/propeditor-gallery/gallery.ts` while tRadio
 * was the only host. Three copies of it was never the alternative; this is.
 *
 * What is faked, and what is not
 *
 * Nothing here patches application code. Every input is a message FiveM itself
 * sends: `locale:init`, `<prefix>:propEditorInit` (the shared module's `open`),
 * `setCameraPosition`, plus whatever extra side-channel messages a host's own
 * views add. Two of those have no producer without a game and so are synthesised:
 *
 *   - `vehicleMatrix`, which in game is `GetEntityMatrix(vehicle)`. The fixture
 * below is a real GTA basis for a vehicle parked at a 35° heading. NOT an
 *     identity matrix on purpose: the local and world captures are the same
 *     picture except for the gizmo's orientation, so an axis-aligned vehicle
 *     would make those two files byte-identical and the distinction they exist
 *     to show invisible.
 *   - `setCameraPosition`, which in game arrives every frame from the orbit cam.
 *     Without it the Three camera sits at the origin and the gizmo is off-screen
 *     behind it — a page of chrome around an empty canvas, which is exactly the
 *     failure this must not ship.
 *
 * Why it can run at all, given tRadio's perf harness refuses to
 *
 * `tRadio/scripts/nui-harness/scenarios/misc.ts` deliberately does NOT drive
 * `propEditorInit`. That rationale is about a *perf* harness repeating the open
 * hundreds of times: mounting a WebGL canvas that often on a GPU-less machine
 * spends the run inside the software rasteriser and emits context-loss warnings
 * the harness would file as application findings. A gallery opens each state
 * exactly once — a handful of contexts for the whole run, each disposed on
 * unmount — so the objection does not transfer. Measured: headless Chromium 103
 * gives WebGL 2.0 with no extra flags at all (`--use-gl=swiftshader` /
 * `--enable-unsafe-swiftshader` changed nothing), so none are passed.
 * `gizmoPixels` is what keeps that an observation rather than a hope: a run whose
 * canvas drew nothing fails instead of shipping blank art.
 *
 * Zero npm dependencies
 *
 * Like `hud-gallery.ts` beside it. The static server is `Bun.serve`, the browser
 * is the cached Chromium 103 from `nui-chromium.ts`, and the blank-canvas check
 * decodes the captured PNG **in the page** — the shot is served back to the
 * browser from the output folder and read with `getImageData`, rather than
 * pulling `sharp` into tLib and into every consumer that shoots a gallery.
 */

import fs from "node:fs";
import path from "node:path";
import { type LaunchedBrowser, launch } from "./nui-chromium.ts";

// The vehicle the editor is opened from

/** A GTA basis for a heading of 35°: right = (cos h, sin h, 0), fwd = (-sin h, cos h, 0), up = +Z. */
const HEADING_DEG = 35;
const HEADING = (HEADING_DEG * Math.PI) / 180;
export const GALLERY_VEHICLE_MATRIX = {
  fwd: { x: -Math.sin(HEADING), y: Math.cos(HEADING), z: 0 },
  right: { x: Math.cos(HEADING), y: Math.sin(HEADING), z: 0 },
  up: { x: 0, y: 0, z: 1 },
  pos: { x: 215.76, y: -810.42, z: 30.68 },
};

/** Where the prop sits on the dash, in vehicle-local metres/degrees — a plausible saved placement. */
export const GALLERY_PROP_DATA = { x: 0.02, y: -0.28, z: 0.42, rx: -2.5, ry: 0, rz: 12 };

/** `<prefix>:propEditorInit` exactly as `tlib.propeditor`'s `open` builds it. Flat, not nested. */
export interface PropEditorGalleryInit {
  vehicleModel: string;
  vehicleDisplayName: string;
  propData: typeof GALLERY_PROP_DATA;
  vehicleMatrix: typeof GALLERY_VEHICLE_MATRIX;
  hasExisting: boolean;
  cameraFov: number;
}

/** `fivemLocalToWorld`, from `internal/shared-ts/gizmo/vehicle-math.ts`. */
function localToWorld(lx: number, ly: number, lz: number) {
  const m = GALLERY_VEHICLE_MATRIX;
  return {
    x: m.pos.x + m.right.x * lx + m.fwd.x * ly + m.up.x * lz,
    y: m.pos.y + m.right.y * lx + m.fwd.y * ly + m.up.y * lz,
    z: m.pos.z + m.right.z * lx + m.fwd.z * ly + m.up.z * lz,
  };
}

const PROP_WORLD = localToWorld(GALLERY_PROP_DATA.x, GALLERY_PROP_DATA.y, GALLERY_PROP_DATA.z);
/**
 * A three-quarter view from the passenger side, framed ON the prop so the gizmo lands dead
 * centre — which is what lets `gizmoPixels` sample the middle of the frame and know what it
 * is looking at.
 */
const CAMERA = {
  position: localToWorld(
    GALLERY_PROP_DATA.x + 1.15,
    GALLERY_PROP_DATA.y - 1.7,
    GALLERY_PROP_DATA.z + 0.8
  ),
  focus: PROP_WORLD,
};

// In-page selectors

/**
 * The editor's host-independent anchor.
 *
 * NOT `.radio-settings-root`. That is tRadio's token-scope wrapper and the class
 * this component is handed as `scopeClass`; tRadar and tDetector pass none at all
 * because their tokens are on `:root`, so keying on it would have found nothing
 * in two hosts out of three. `PropEditor.tsx` sets `data-prop-editor` for exactly
 * this.
 */
export const PROP_EDITOR_ROOT = "[data-prop-editor]";

/** Semantic handle for a left-toolbar button. Captions are locale strings; these are not. */
export const toolSelector = (tool: string) => `${PROP_EDITOR_ROOT} [data-tool="${tool}"]`;

/** In-page predicate: the button for `tool` is the lit one. */
export const toolActive = (tool: string) =>
  `Boolean(document.querySelector('${toolSelector(tool)}[data-active]'))`;

/** In-page action: click the button for `tool`, returning whether it was there. */
export const clickTool = (tool: string) =>
  `(() => { const b = document.querySelector('${toolSelector(tool)}'); if (b) b.click(); return Boolean(b); })()`;

/**
 * The editor is up and has painted both halves of itself: the toolbar (a semantic
 * button, not a count — a count has to be rewritten every time a button moves)
 * and the WebGL canvas.
 */
export const EDITOR_UP = `Boolean(document.querySelector('${toolSelector("move")}')) && Boolean(document.querySelector('${PROP_EDITOR_ROOT} canvas'))`;

// Views

export interface PropEditorGalleryStep {
  /** In-page predicate that must hold before `action` fires. */
  ready?: string;
  /** In-page JS returning truthy when it found its target. */
  action: string;
}

export interface PropEditorGalleryView {
  id: string;
  name: string;
  /** Fields overriding the default init for this view. */
  init?: Partial<PropEditorGalleryInit>;
  /** Extra flat NUI messages posted after the editor is up (side-channels the game sends late). */
  messages?: Array<Record<string, unknown>>;
  /** Clicks on the way to the state. Each waits for its own `ready` first. */
  action?: PropEditorGalleryStep[];
  /** In-page predicate, truthy once the state has meaningfully rendered. */
  ready: string;
}

/**
 * The states every host has.
 *
 * `hasExisting` is stored (`prop-editor/store.ts`) and read by NOTHING — the
 * Remove button renders unconditionally. The last two shots are therefore
 * expected to be identical to the first, and the run SAYS so at the end rather
 * than implying three looks. They are here because this gallery was the
 * before/after net for moving the editor into tLib, and it stays as the net for
 * the next change: if Remove ever starts or stops being gated on `hasExisting`,
 * that pair is where it shows.
 */
export const SHARED_PROP_EDITOR_VIEWS: PropEditorGalleryView[] = [
  {
    // `openPropEditor()` resets mode to "translate" and space to "local" on every
    // open, so this is also the proof that those defaults are what a player lands on.
    id: "default-move-local",
    name: "Default — Move, local space",
    ready: `${EDITOR_UP} && ${toolActive("move")}`,
  },
  {
    id: "mode-rotate",
    name: "Rotate mode",
    action: [{ ready: EDITOR_UP, action: clickTool("rotate") }],
    ready: toolActive("rotate"),
  },
  {
    // Space "world" is the UNLIT state of the space button, so this asserts on
    // `data-space` rather than on the highlight.
    id: "space-world",
    name: "World space",
    action: [{ ready: EDITOR_UP, action: clickTool("space") }],
    ready: `Boolean(document.querySelector('${toolSelector("space")}[data-space="world"]'))`,
  },
  {
    id: "existing-placement",
    name: "Existing placement (hasExisting: true)",
    init: { hasExisting: true },
    ready: EDITOR_UP,
  },
  {
    id: "no-existing-placement",
    name: "No existing placement (hasExisting: false)",
    init: { hasExisting: false },
    ready: EDITOR_UP,
  },
];

// Options and results

export interface PropEditorGalleryOptions {
  /** FiveM resource name, as `GetParentResourceName()` must answer. */
  resource: string;
  /** Event namespace without the colon — `radio`, `tradar`, `tdet`. */
  prefix: string;
  /** A BUILT NUI bundle with an `index.html`. Served exactly as `ui_page` serves it. */
  bundleDir: string;
  /** The resource root, served as a second static root for root-relative asset URLs. */
  resourceRoot: string;
  /** Flat destination folder. Shots for the views being taken are replaced. */
  outDir: string;
  /** `locale:init` payload, for a host that translates through tLib's locale store. */
  locale?: unknown;
  /** Views on top of `SHARED_PROP_EDITOR_VIEWS` — a state only this host can reach. */
  extraViews?: PropEditorGalleryView[];
  /** Overrides for the init fixture, e.g. a host-appropriate `vehicleDisplayName`. */
  init?: Partial<PropEditorGalleryInit>;
  /** Subset of view ids, or undefined for all of them. */
  only?: string[];
  viewport?: { width: number; height: number };
  /** Device scale factor. The editor is a full-screen composition, so this is the quality knob. */
  dpr?: number;
  /** Shoot over Chromium's white backdrop instead of keeping the NUI's alpha. */
  opaque?: boolean;
  log?: (msg: string) => void;
}

export interface PropEditorGalleryShot {
  view: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  /** sha of the pixels, so identical states can be NAMED as identical. */
  digest: string;
  gizmoPixels: number;
  flags: string[];
}

export interface PropEditorGalleryResult {
  outDir: string;
  shots: PropEditorGalleryShot[];
  /** Shots with at least one flag. Every flag means the picture is of the wrong thing. */
  flagged: PropEditorGalleryShot[];
  /** Groups of files whose pixels are byte-identical. */
  duplicates: string[][];
  webgl: string;
}

// The FiveM host, reduced to what this page needs

/**
 * `GetParentResourceName` and the `fetchNui` rewrite, and nothing else.
 *
 * Deliberately NOT tRadio's `nui-harness/shim.ts`: that one also carries a 3D
 * audio position driver, a socket.io connection-info reply and the memory probes
 * its perf harness measures with, none of which this page has any use for. What
 * is shared with it is the principle — nothing here patches application code, it
 * only supplies host functions FiveM would supply.
 */
function hostShim(resource: string): string {
  return `(() => {
  if (window.__peHost) return;
  window.GetParentResourceName = () => ${JSON.stringify(resource)};
  const nativeFetch = window.fetch.bind(window);
  // fetchNui POSTs to https://<resource>/<event>, which has no DNS here. Rewrite to the
  // gallery's endpoint so the call still crosses a real network boundary rather than
  // being stubbed — a stub would hide a callback storm behind a pretty picture.
  const NUI_RE = new RegExp('^https?://(cfx-nui-)?' + ${JSON.stringify(resource)} + '/(.*)$', 'i');
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const m = NUI_RE.exec(url);
      if (m) return nativeFetch('/__nui/' + encodeURIComponent(decodeURIComponent(m[2])), init);
    } catch (e) { /* fall through to the real fetch */ }
    return nativeFetch(input, init);
  };
  const H = { errors: [] };
  window.addEventListener('error', (e) => { H.errors.push(String(e.message).slice(0, 300)); });
  window.addEventListener('unhandledrejection', (e) => { H.errors.push(String(e.reason).slice(0, 300)); });
  window.__peHost = H;

  /**
   * Count the non-backdrop pixels in the middle of a PNG the run just wrote.
   *
   * The shot is fetched back from the gallery's own server rather than handed in
   * as a base64 expression — a 3840x2160 capture is several megabytes of source
   * text otherwise — and it is same-origin, so the canvas is not tainted and
   * getImageData works.
   */
  window.__peMeasure = (url, fraction, opaque) => new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(-1);
    img.onload = () => {
      try {
        const cw = Math.round(img.width * fraction);
        const ch = Math.round(img.height * fraction);
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const g = c.getContext('2d');
        g.clearRect(0, 0, cw, ch);
        g.drawImage(img, Math.round((img.width - cw) / 2), Math.round((img.height - ch) / 2), cw, ch, 0, 0, cw, ch);
        const d = g.getImageData(0, 0, cw, ch).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          // On a transparent run the backdrop is alpha 0 and the gizmo is the only
          // thing with alpha. On an --opaque run everything is alpha 255, so fall
          // back to "not the white backdrop".
          if (opaque) { if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) n++; }
          else if (d[i+3] > 8) n++;
        }
        resolve(n);
      } catch (e) { resolve(-1); }
    };
    img.src = url + '?t=' + Date.now();
  });
})();`;
}

// The static server

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

interface BundleServer {
  port: number;
  /** Every fetchNui the page made, in order. */
  nuiCalls: string[];
  /** Every asset the page asked for and did not get — a silent 404 hides a dead path. */
  missing: string[];
  stop(): void;
}

/**
 * Serves the bundle, the resource root behind it, and the shots taken so far.
 *
 * Two static roots because a NUI's root-relative URLs (`/layouts/...`) resolve to
 * `nui://<resource>/layouts/...` in game, i.e. to the RESOURCE, not to the bundle.
 * Serving only the bundle 404s every one of them.
 */
function startBundleServer(bundleDir: string, resourceRoot: string, shotDir: string): BundleServer {
  const nuiCalls: string[] = [];
  const missing: string[] = [];
  const roots = [path.resolve(bundleDir), path.resolve(resourceRoot)];
  const shots = path.resolve(shotDir);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/__nui/")) {
        nuiCalls.push(pathname.slice("/__nui/".length));
        // FiveM answers callbacks in-frame; so do we, with the empty object the
        // overwhelming majority of them return.
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      }

      // The shots this run has already written, so the page can measure them.
      if (pathname.startsWith("/__shot/")) {
        const file = path.resolve(shots, pathname.slice("/__shot/".length));
        if (!file.startsWith(shots + path.sep)) return new Response("", { status: 403 });
        return new Response(Bun.file(file), { headers: { "Content-Type": "image/png" } });
      }

      const relative = pathname.replace(/^\/+/, "") || "index.html";
      for (const root of roots) {
        const file = path.resolve(root, relative);
        // The URL decides the path, so it is confined to its root rather than trusted.
        if (!file.startsWith(root + path.sep) && file !== root) continue;
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        const type = MIME[path.extname(file).toLowerCase()];
        return new Response(Bun.file(file), type ? { headers: { "Content-Type": type } } : {});
      }
      missing.push(pathname);
      return new Response("", { status: 404 });
    },
  });

  // Port 0 asked the OS to pick one, so this is the only place the real port is known.
  // Bun types it optional (a unix-socket server has none); this one is TCP.
  if (server.port === undefined) throw new Error("the gallery server did not bind a TCP port");

  return {
    port: server.port,
    nuiCalls,
    missing,
    stop: () => server.stop(true),
  };
}

// The run

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(b: LaunchedBrowser, predicate: string, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const ok = await b.page.evaluate<boolean>(`Boolean(${predicate})`).catch(() => false);
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

async function post(b: LaunchedBrowser, msg: Record<string, unknown>): Promise<void> {
  await b.page.evaluate(`window.postMessage(${JSON.stringify(msg)}, '*')`);
  await sleep(120);
}

/** 30% of the frame. The camera looks AT the prop, so the centre is gizmo or nothing. */
const CENTRE_FRACTION = 0.3;

export async function renderPropEditorGallery(
  options: PropEditorGalleryOptions
): Promise<PropEditorGalleryResult> {
  const {
    resource,
    prefix,
    bundleDir,
    resourceRoot,
    outDir,
    locale,
    extraViews = [],
    only,
    viewport = { width: 1920, height: 1080 },
    dpr = 2,
    opaque = false,
    log = console.log,
  } = options;

  if (!fs.existsSync(path.join(bundleDir, "index.html")))
    throw new Error(`no index.html in bundle ${bundleDir}`);

  const all = [...SHARED_PROP_EDITOR_VIEWS, ...extraViews];
  const views = only ? all.filter((v) => only.includes(v.id)) : all;
  if (!views.length)
    throw new Error(
      `no views matched ${only?.join(",")}. Known: ${all.map((v) => v.id).join(", ")}`
    );

  const init: PropEditorGalleryInit = {
    vehicleModel: "police3",
    vehicleDisplayName: "Police Cruiser",
    propData: GALLERY_PROP_DATA,
    vehicleMatrix: GALLERY_VEHICLE_MATRIX,
    hasExisting: true,
    cameraFov: 50,
    ...options.init,
  };

  fs.mkdirSync(outDir, { recursive: true });
  // Replace this run's shots rather than wiping `outDir`, which is a caller's argument.
  for (const view of views) {
    const file = path.join(outDir, `${view.id}.png`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const srv = startBundleServer(bundleDir, resourceRoot, outDir);
  log(`[prop-editor gallery] ${resource} on http://127.0.0.1:${srv.port}`);
  log(
    `[prop-editor gallery] ${views.length} views at ${viewport.width}x${viewport.height} @ DPR ${dpr} → ${outDir}`
  );

  const shots: PropEditorGalleryShot[] = [];
  let browser: LaunchedBrowser | undefined;
  let webgl = "unknown";
  try {
    browser = await launch({ headless: true, log: () => {} });
    const page = browser.page;
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    // The NUI page is transparent — in game the vehicle is behind it. Keeping the alpha
    // is the honest picture; Chromium's default composites the chrome over an invented
    // white plate.
    if (!opaque)
      await page.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    await page.addInitScript(hostShim(resource));
    await page.navigate(`http://127.0.0.1:${srv.port}/`);

    // Every caption in this editor goes through the host's translator, which for a
    // dictionary-backed host returns the KEY NAME when the dictionary is empty — so
    // without this the gallery would be a faithful photograph of `prop_editor_btn_save`.
    // Hosts with no locale file fall through to tLib's English defaults and pass none.
    if (locale !== undefined) await post(browser, { action: "locale:init", strings: locale });

    // Prove WebGL before spending a run on it, and say which rasteriser drew the art.
    const gl = await page.evaluate<{ ok: boolean; renderer?: string; version?: string }>(
      `(() => { const c = document.createElement('canvas');
         const g = c.getContext('webgl2') || c.getContext('webgl');
         return g ? { ok: true, renderer: g.getParameter(g.RENDERER), version: g.getParameter(g.VERSION) } : { ok: false }; })()`
    );
    if (!gl?.ok)
      throw new Error(
        "this Chromium has no WebGL context — the editor cannot be photographed here"
      );
    webgl = `${gl.version} (${gl.renderer})`;
    log(`[prop-editor gallery] webgl: ${webgl}`);

    for (const view of views) {
      log(`[prop-editor gallery] ${view.name}`);
      shots.push(
        await capture(browser, {
          view,
          init,
          prefix,
          outDir,
          viewport,
          dpr,
          opaque,
          log,
        })
      );
    }
  } finally {
    await browser?.close();
    srv.stop();
  }

  const flagged = shots.filter((s) => s.flags.length);
  const byDigest = new Map<string, string[]>();
  for (const s of shots) byDigest.set(s.digest, [...(byDigest.get(s.digest) ?? []), s.file]);
  const duplicates = [...byDigest.values()].filter((files) => files.length > 1);

  return { outDir, shots, flagged, duplicates, webgl };
}

interface CaptureContext {
  view: PropEditorGalleryView;
  init: PropEditorGalleryInit;
  prefix: string;
  outDir: string;
  viewport: { width: number; height: number };
  dpr: number;
  opaque: boolean;
  log: (m: string) => void;
}

async function capture(b: LaunchedBrowser, ctx: CaptureContext): Promise<PropEditorGalleryShot> {
  const { view, init, prefix, outDir, viewport, dpr, opaque, log } = ctx;
  const flags: string[] = [];

  // Close first, so each view mounts the viewport from scratch and gets a fresh WebGL
  // context that `onCleanup` disposes. Reusing one mount would leave the previous view's
  // picker or mode in place and make a shot depend on the order the registry is in.
  await post(b, { action: `${prefix}:propEditorClose` });
  if (!(await poll(b, `!document.querySelector('${PROP_EDITOR_ROOT}')`, 5_000)))
    flags.push("previous editor never unmounted");
  await b.page.evaluate(`window.__peGallery = { lost: 0 };`);

  // Retried rather than posted once. The init message is only received after the host's
  // App has mounted and PropEditor's `onMount` has subscribed, and there is no signal for
  // that which every host sends — an init that lands a frame early is silently dropped
  // and the run would photograph an empty page.
  const initMessage = { ...init, ...view.init, action: `${prefix}:propEditorInit` };
  let up = false;
  for (let attempt = 0; attempt < 6 && !up; attempt++) {
    await post(b, initMessage);
    up = await poll(b, EDITOR_UP, 4_000);
  }
  if (!up) flags.push("editor chrome never mounted");

  // Watch for context loss on THIS mount. A lost context renders nothing and is silent.
  await b.page.evaluate(
    `(() => { const c = document.querySelector('${PROP_EDITOR_ROOT} canvas');
       if (c) c.addEventListener('webglcontextlost', () => { window.__peGallery.lost++; });
       return true; })()`
  );

  // The orbit cam, as Lua drives it every frame. Sent after the mount so the viewport's
  // useNUIEvent subscription exists to receive it.
  await post(b, { action: "setCameraPosition", ...CAMERA });

  for (const msg of view.messages ?? []) await post(b, msg);

  for (const [i, step] of (view.action ?? []).entries()) {
    if (!(await poll(b, step.ready ?? "true"))) flags.push(`step ${i + 1} never became actionable`);
    const did = await b.page.evaluate<boolean>(step.action).catch(() => false);
    if (!did) flags.push(`step ${i + 1} found no target — the view may not have been reached`);
  }

  if (!(await poll(b, view.ready))) flags.push("readiness predicate never matched");

  await b.page.evaluate(`document.fonts.ready`).catch(() => {});
  // Two rendered frames, so the gizmo's first paint is definitely on screen.
  await b.page
    .evaluate(
      `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`
    )
    .catch(() => {});
  await sleep(400);

  // A host's ErrorBoundary swallows a throwing mount into a perfectly photogenic card.
  // Catch it here or it ships as a screenshot of a broken app.
  const boundary = await b.page
    .evaluate<string | null>(
      `(() => { const t = document.body.innerText || ''; const m = /\\w+ error:/.exec(t); return m ? t.slice(m.index, m.index + 200) : null; })()`
    )
    .catch(() => null);
  if (boundary) flags.push(`app error boundary tripped: ${boundary.replace(/\s+/g, " ").trim()}`);

  const lost = await b.page.evaluate<number>(`window.__peGallery.lost`).catch(() => 0);
  if (lost) flags.push(`webgl context lost ${lost}x during this capture`);

  const pageErrors = await b.page
    .evaluate<string[]>(`window.__peHost.errors.splice(0)`)
    .catch(() => [] as string[]);
  for (const e of pageErrors) flags.push(`page error: ${e}`);

  const { data } = await b.page.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    // Full viewport — the editor IS the whole screen, so there is no box to clip to.
    // scale 1: the DPR already multiplies the buffer, and setting both multiplies twice.
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
    captureBeyondViewport: false,
  });
  const png = Buffer.from(data, "base64");
  const file = `${view.id}.png`;
  fs.writeFileSync(path.join(outDir, file), png);

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== viewport.width * dpr || height !== viewport.height * dpr)
    flags.push(`unexpected size ${width}x${height}`);

  // Measured off the FILE that was just written, not off the live page: a blank PNG
  // beside a correct-looking page is the failure this exists to catch.
  const drawn = await b.page
    .evaluate<number>(
      `window.__peMeasure(${JSON.stringify(`/__shot/${file}`)}, ${CENTRE_FRACTION}, ${opaque})`
    )
    .catch(() => -1);
  if (drawn === 0)
    flags.push("the gizmo canvas is empty — this shot is chrome around a blank WebGL layer");
  if (drawn < 0) flags.push("the shot could not be read back, so it is not known to be non-blank");

  const digest = new Bun.CryptoHasher("sha256").update(png).digest("hex").slice(0, 16);
  log(
    `    ${file} ${width}x${height} ${(png.length / 1024).toFixed(0)} KB  gizmo px ${drawn}${
      flags.length ? `  [${flags.join("; ")}]` : ""
    }`
  );
  return {
    view: view.id,
    file,
    width,
    height,
    bytes: png.length,
    digest,
    gizmoPixels: drawn,
    flags,
  };
}

// CLI

export interface PropEditorGalleryCli {
  out: string | null;
  bundle: string | null;
  views: string[] | undefined;
  viewport: { width: number; height: number };
  dpr: number;
  opaque: boolean;
  rebuild: boolean;
}

/**
 * The flags every consumer's `--only propeditor` half accepts, parsed once.
 *
 *   --out <dir>       gallery destination
 *   --bundle <dir>    a prebuilt NUI bundle to shoot instead of building one
 *   --views all|CSV   which states
 *   --viewport WxH    CSS viewport
 *   --dpr N           device scale factor
 *   --opaque          shoot over a white backdrop instead of keeping the NUI's alpha
 *   --rebuild         build the bundle first even if one is already there
 */
export function parsePropEditorGalleryCli(argv: string[]): PropEditorGalleryCli {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : null;
  };
  const [width, height] = (value("viewport") ?? "1920x1080").split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height))
    throw new Error("--viewport must be WxH");
  const dpr = Number(value("dpr") ?? "2");
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 4) throw new Error("--dpr must be 1-4");
  const views = value("views");
  return {
    out: value("out"),
    bundle: value("bundle"),
    views:
      !views || views === "all"
        ? undefined
        : views
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    viewport: { width, height },
    dpr,
    opaque: argv.includes("--opaque"),
    rebuild: argv.includes("--rebuild"),
  };
}

/**
 * Make sure there is a built NUI bundle to photograph, building one if there is not.
 *
 * Via the resource's ROOT build script, never a bare `vp build`: the root script is
 * what stamps the version out of fxmanifest.lua and builds whatever else the bundle
 * needs, and a gallery shot from a hand-built bundle is a picture of something that
 * was never assembled the way the game gets it.
 *
 * tRadio does not use this — its gallery builds an ISOLATED bundle under `.tmp` so a
 * run cannot touch the `client/ui` tree FXServer is serving, and hands the result in.
 */
export async function ensureNuiBundle(
  resourceRoot: string,
  bundleDir: string,
  opts: { rebuild?: boolean; log?: (m: string) => void } = {}
): Promise<void> {
  const log = opts.log ?? console.log;
  if (!opts.rebuild && fs.existsSync(path.join(bundleDir, "index.html"))) {
    log(`[prop-editor gallery] reusing bundle at ${bundleDir} (pass --rebuild to refresh)`);
    return;
  }
  log(`[prop-editor gallery] building the NUI bundle — bun run build`);
  const proc = Bun.spawnSync(["bun", "run", "build"], {
    cwd: resourceRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error(`bun run build failed (exit ${proc.exitCode})`);
  if (!fs.existsSync(path.join(bundleDir, "index.html")))
    throw new Error(`the build produced no index.html in ${bundleDir}`);
}

/** Flags this half owns, and whether each takes a value. */
const OWN_FLAGS: Record<string, boolean> = {
  "--only": true,
  "--bundle": true,
  "--views": true,
  "--viewport": true,
  "--dpr": true,
  "--rebuild": false,
  "--opaque": false,
};

/**
 * Remove the flags this half consumes, so the rest of a resource's gallery can
 * parse what is left.
 *
 * `hud-gallery.ts`'s `parseGalleryCli` THROWS on an unknown option, which is the
 * right behaviour — a mistyped flag that is silently ignored produces a gallery
 * of the wrong thing. It does mean a resource whose gallery has two halves has to
 * split the arguments before either half sees them. `--out` is deliberately NOT
 * in here: both halves want it, and each puts its own subfolder under it.
 */
export function stripPropEditorGalleryArgs(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const takesValue = OWN_FLAGS[argv[i]];
    if (takesValue === undefined) {
      rest.push(argv[i]);
      continue;
    }
    if (takesValue && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
  }
  return rest;
}

/**
 * Print a finished run and say whether the folder is usable.
 *
 * Flagged is FATAL here, unlike an advisory-flag gallery: every flag this can
 * raise means the picture is of the wrong thing (state never reached, canvas
 * blank, app crashed), and the whole point of the folder is to be diffable
 * against a later one.
 */
export function reportPropEditorGallery(
  label: string,
  result: PropEditorGalleryResult,
  log = console.log
): boolean {
  log(
    `[${label}] ${result.shots.length} captures → ${result.outDir}, flagged: ${result.flagged.length}`
  );
  for (const s of result.flagged) log(`  ${s.file}: ${s.flags.join("; ")}`);
  // States that produced the same picture. Not a failure — `hasExisting` currently
  // changes nothing the editor draws — but a gallery that silently contains duplicates
  // reads as coverage it does not have.
  for (const files of result.duplicates) log(`  identical pixels: ${files.join(" == ")}`);
  if (result.flagged.length) {
    console.error(`[${label}] NOT usable: ${result.flagged.map((s) => s.view).join(", ")}`);
    return false;
  }
  return true;
}
