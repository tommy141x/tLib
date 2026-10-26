/**
 * `bun run gallery [-- --only dialog,toast] [--viewport 1920x1080] [--out D:/art] [--rebuild]`
 * — every surface tLib draws, photographed into `assets/gallery/` (git-ignored,
 * safe to regenerate): `menu--`, `dialog--`, `toast--`, `marketplace--`,
 * `layout--<id>.png`, plus `propeditor/<host>/`.
 *
 * The prop editor is shot differently on purpose: `@tlib/internal/prop-editor`
 * isn't in tLib's own NUI, tLib only ships the component while tRadio/tRadar/
 * tDetector mount it, and its appearance comes from token NAMES whose VALUES
 * are per-resource. So it's three pictures, each driven out of a consumer's
 * own shipped bundle via that consumer's own `bun run gallery -- --only
 * propeditor` (same driver, `shared/ts/build/prop-editor-gallery.ts`), not one
 * synthetic tLib-only page that would hide the per-resource token values.
 *
 * Pictures only -- no contact sheet, no report.json; what couldn't be shot is
 * a flag printed at the end. Drives the real built bundle with a mocked NUI
 * transport, the same stub/route/envelope `tests/browser/*.ts` use; the
 * difference is `gallery-fixtures.ts` is representative content, not content
 * chosen to break things. Every shot asserts its surface is actually on
 * screen first, since a payload the UI silently rejected would otherwise
 * photograph as an empty page indistinguishable from a real result.
 */

import { mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { cliArg } from "../shared/ts/build/argv.ts";
import {
  DIALOGS,
  LAYOUT_OPEN,
  MARKET_OPEN,
  MARKET_SOUNDS,
  MARKET_UIS,
  MENUS,
  TOASTS,
} from "./gallery-fixtures.ts";
import { isStandaloneClone } from "./siblings.ts";

const ROOT = join(import.meta.dir, "..");

const SURFACES = ["menu", "dialog", "toast", "marketplace", "layout", "propeditor"] as const;
type Surface = (typeof SURFACES)[number];

/**
 * Resources that mount `@tlib/internal/prop-editor`, as sibling directories of
 * tLib (how every `[tScripts]` resource reaches the others). A host not
 * checked out is flagged, not failed -- this folder is often a partial checkout.
 */
const PROP_EDITOR_HOSTS = ["tRadio", "tRadar", "tDetector"] as const;

const outDir = cliArg("out", join(ROOT, "assets", "gallery"));
const dist = resolve(cliArg("dist", join(ROOT, "client", "ui")));
const [vpW, vpH] = cliArg("viewport", "1600x900").split("x").map(Number);
if (!Number.isFinite(vpW) || !Number.isFinite(vpH)) throw new Error("--viewport must be WxH");
const only = cliArg("only", SURFACES.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as Surface[];
for (const s of only) {
  if (!SURFACES.includes(s)) throw new Error(`--only must be from ${SURFACES.join(",")}, got ${s}`);
}
/**
 * The NUI is transparent over the game; a white page hides half of every
 * surface, so this defaults to a neutral mid-grey instead. `--transparent`
 * shoots on real transparency (needs both the page not painting a background
 * AND the screenshot not compositing one in) for a composite, where any fill
 * at all lands as a rectangle around the component. A flag rather than
 * `--background ""`, since `cliArg` rejects an empty value as a likely typo.
 */
const background = cliArg("background", "#3a3f47");
const transparent = process.argv.includes("--transparent");

const want = (s: Surface) => only.includes(s);

const flags: string[] = [];
const written: string[] = [];

// The prop editor, one run per host out of that host's own bundle: the one
// surface not drawn from tLib's own bundle, so `--only propeditor` has no
// reason to build it or open a browser on tLib's NUI. A tree with no host at
// all is a standalone tLib clone, not a partial checkout, and is reported as
// such rather than as a run that exits 1.
const standalone = isStandaloneClone(ROOT);
if (want("propeditor") && standalone) {
  console.log(
    "[tLib gallery] prop editor: skipped — no consumer resource is checked out beside tLib. " +
      "This surface is shot out of each consumer's own bundle, never out of tLib's."
  );
} else if (want("propeditor")) {
  const base = join(outDir, "propeditor");
  // Replace the folder rather than its contents: a host that stopped being shot would
  // otherwise leave its old shots sitting there looking current.
  rmSync(base, { recursive: true, force: true });
  for (const host of PROP_EDITOR_HOSTS) {
    const cwd = resolve(ROOT, "..", host);
    if (!(await Bun.file(join(cwd, "package.json")).exists())) {
      flags.push(`propeditor/${host}: not checked out beside tLib, skipped`);
      continue;
    }
    const out = join(base, host);
    console.log(`\n[tLib gallery] prop editor — ${host}, themed as ${host}`);
    const res = Bun.spawnSync(
      ["bun", "run", "gallery", "--", "--only", "propeditor", "--out", out],
      { cwd, stdout: "inherit", stderr: "inherit" }
    );
    if (res.exitCode !== 0) {
      flags.push(`propeditor/${host}: its gallery exited ${res.exitCode} — see the log above`);
      continue;
    }
    for (const name of readdirSync(out)) if (name.endsWith(".png")) written.push(join(out, name));
  }
}

// Nothing below draws anything a `--only propeditor` run wants, and building tLib's
// bundle to photograph none of it would only slow the run down.
if (!only.some((s) => s !== "propeditor")) {
  console.log(`\n[tLib gallery] ${written.length} shots → ${join(outDir, "propeditor")}`);
  for (const flag of flags) console.log(`  flag: ${flag}`);
  process.exit(standalone || (written.length && !flags.length) ? 0 : 1);
}

if (process.argv.includes("--rebuild") || !(await Bun.file(join(dist, "index.html")).exists())) {
  console.log("[tLib gallery] building client/ui");
  const res = Bun.spawnSync(["bun", "run", "build"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const relative =
      decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "") || "index.html";
    const path = resolve(dist, relative);
    // The URL decides the path, so it is confined to the bundle rather than trusted.
    if (!path.startsWith(dist + sep)) return new Response("", { status: 403 });
    return new Response(Bun.file(path));
  },
});

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: vpW, height: vpH } });
page.on("pageerror", (e: Error) => flags.push(`page error: ${e.message}`));

/** Whatever the menu should answer `menu_ready`/`menu_resync` with right now. Mounting happens
 *  once, but a snapshot pushed later has to survive a resync, so this follows the current shot.
 *  It starts CLOSED: the menu asks on mount, and a visible page here would sit behind every
 *  dialog, toast and panel shot in a run that is not photographing menus at all. */
const MENU_CLOSED = { version: 1, visible: false, menus: [] };
let menuSnapshot: unknown = MENU_CLOSED;

await page.addInitScript(() => {
  (window as unknown as { GetParentResourceName: () => string }).GetParentResourceName = () =>
    "tLib";
});
await page.route("https://tlib/**", async (route) => {
  const event = new URL(route.request().url()).pathname;
  const reply: Record<string, unknown> = { ok: true };
  if (event === "/menu_ready" || event === "/menu_resync") reply.snapshot = menuSnapshot;
  await route.fulfill({ json: reply });
});
await page.route(`${MARKET_OPEN.baseUrl}/**`, async (route) => {
  const url = new URL(route.request().url());
  const type = url.searchParams.get("type");
  await route.fulfill({ json: { items: type === "sound" ? MARKET_SOUNDS : MARKET_UIS } });
});

const send = (name: string, data?: unknown) =>
  page.evaluate(({ name, data }) => window.postMessage({ name, args: [data] }, location.origin), {
    name,
    data,
  });

await page.goto(`http://127.0.0.1:${server.port}`);
if (!transparent) {
  await page.addStyleTag({ content: `html,body{background:${background} !important}` });
}
await page.waitForTimeout(500);

mkdirSync(outDir, { recursive: true });
// Replace previous shots rather than wiping `outDir`, which is a command-line argument. Flat
// output means sweeping by filename prefix — without it a renamed fixture leaves its old PNG
// sitting there looking current. Only the surfaces being shot: a `--only layout` run that
// deleted the menu shots it is not about to retake would be the same kind of lie.
for (const name of readdirSync(outDir)) {
  if (only.some((s) => name.startsWith(`${s}--`)) && name.endsWith(".png")) {
    unlinkSync(join(outDir, name));
  }
}

/**
 * How much scrollable overflow inside a surface is worth reacting to. Sub-pixel layout and
 * rounding routinely leave a stray pixel or two on a container that is not actually scrolling.
 */
const CLIP_TOLERANCE_PX = 4;
/** Viewport ceiling for the auto-grow below, so a genuinely unbounded surface cannot loop away. */
const MAX_VIEWPORT_H = 3000;

/**
 * Worst scrollable overflow anywhere inside the surface, in CSS pixels.
 * "Visible" isn't "all of it is visible": the dialog caps at `max-height:85vh`
 * and scrolls its field area, so `dialog--every-field` once photographed as a
 * complete-looking panel with its last fields scrolled off -- clipped, not
 * mis-rendered. `fullPage` wouldn't help; the overflow is inside an element,
 * not the document.
 */
async function clippedBy(selector: string): Promise<number> {
  return await page
    .locator(selector)
    .first()
    .evaluate((root, tolerance) => {
      let worst = 0;
      for (const el of [root, ...root.querySelectorAll("*")] as HTMLElement[]) {
        const over = el.scrollHeight - el.clientHeight;
        // Only containers that actually scroll: `visible` overflow reports the same numbers while
        // painting outside its box, and is therefore in the shot already.
        if (over <= tolerance) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "auto" || overflow === "scroll") worst = Math.max(worst, over);
      }
      return worst;
    }, CLIP_TOLERANCE_PX);
}

/**
 * Shoot only once the surface is provably on screen and provably whole: the
 * visibility gate catches a rejected payload (indistinguishable from a good
 * shot otherwise), the clip gate catches a scrolling surface silently showing
 * only part of itself. A clipped surface grows the viewport and retakes
 * rather than shrinking the fixture; surfaces are sized in `vh` so this
 * converges rather than solving in one step. Viewport is restored afterwards
 * so one tall fixture can't rescale every shot that follows it.
 */
async function shoot(name: string, selector: string): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 4000 });
  } catch {
    flags.push(`${name}: ${selector} never appeared — the payload was not accepted`);
    return;
  }

  let grown = false;
  let over = await clippedBy(selector).catch(() => 0);
  while (over > CLIP_TOLERANCE_PX) {
    const current = page.viewportSize()?.height ?? vpH;
    // `vh`-sized surfaces gain less than 1px of room per 1px of viewport, so over-ask to converge.
    const height = Math.min(MAX_VIEWPORT_H, Math.ceil(current + over / 0.85) + 16);
    if (height <= current) {
      flags.push(
        `${name}: ${over}px of it is scrolled out of the shot, at the ${MAX_VIEWPORT_H}px viewport ceiling`
      );
      break;
    }
    await page.setViewportSize({ width: vpW, height });
    await page.waitForTimeout(250);
    grown = true;

    // Stop on measured growth, not an attempt budget: `.mp-panel` is 650px tall
    // at both 900px and 1788px of viewport (fixed height), so a budget that
    // spends every attempt would silently take a shot twice as tall with the
    // same card still cut off.
    const after = await clippedBy(selector).catch(() => 0);
    if (after > CLIP_TOLERANCE_PX && after >= over) {
      flags.push(
        `${name}: ${after}px of it is scrolled out of the shot, and a taller viewport does not help` +
          ` — this surface has a fixed height, so the shot shows only part of its content`
      );
      await page.setViewportSize({ width: vpW, height: vpH });
      await page.waitForTimeout(250);
      grown = false;
      break;
    }
    over = after;
  }

  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, omitBackground: transparent });
  written.push(file);
  if (grown) {
    await page.setViewportSize({ width: vpW, height: vpH });
    await page.waitForTimeout(250);
  }
}

if (want("menu")) {
  for (const entry of MENUS) {
    menuSnapshot = entry.snapshot;
    await send("menu:branding", entry.branding);
    await send("menu:snapshot", entry.snapshot);
    await page.waitForTimeout(350);
    // `.tlib-menu` is the always-mounted host and would pass while nothing rendered inside it;
    // `.menu-panel` only exists once a snapshot was accepted and is visible.
    await shoot(`menu--${entry.id}`, ".menu-panel");
    await send("menu:visible", false);
    await page.waitForTimeout(150);
  }
  menuSnapshot = MENU_CLOSED;
}

if (want("dialog")) {
  for (const dialog of DIALOGS) {
    await send("showDialog", dialog);
    await page.waitForTimeout(350);
    const id = dialog.id.replace(/^gallery:/, "");
    await shoot(`dialog--${id}`, "[role=dialog]");
    // A tabbed dialog shows one tab at a time, so the other tabs are not in the shot above.
    if (dialog.tabs?.length) {
      for (const tab of dialog.tabs.slice(1)) {
        const button = page.getByRole("tab", { name: tab.label, exact: true });
        if (await button.count()) {
          await button.first().click();
          await page.waitForTimeout(250);
          await shoot(`dialog--${id}-${tab.id}`, "[role=dialog]");
        } else {
          flags.push(`dialog--${id}-${tab.id}: no tab control labelled ${tab.label}`);
        }
      }
    }
    await send("closeDialog", { id: dialog.id });
    await page.waitForTimeout(200);
  }

  // The `confirm` question on a button field, which only exists once the button
  // has been pressed. Shot separately rather than by teaching the loop above
  // about field interactions: it is one dialog, and the shape of the step is
  // "press this specific control", which does not generalise.
  const guarded = DIALOGS.find((entry) => entry.id === "gallery:button-confirm");
  const guardedField = guarded?.fields.find((field) => field.confirm);
  if (guarded && guardedField) {
    await send("showDialog", guarded);
    await page.waitForTimeout(350);
    const button = page.getByRole("button", { name: guardedField.label, exact: true });
    if (await button.count()) {
      await button.first().click();
      await page.waitForTimeout(300);
      await shoot("dialog--button-confirm", "[role=dialog]");
    } else {
      flags.push(`dialog--button-confirm: no button labelled ${guardedField.label}`);
    }
    await send("closeDialog", { id: guarded.id });
    await page.waitForTimeout(200);
  } else {
    flags.push("dialog--button-confirm: the gallery:button-confirm fixture is gone");
  }
}

if (want("toast")) {
  for (const toast of TOASTS) {
    await send("dismissAllToasts");
    await page.waitForTimeout(150);
    // duration 0 on a non-loading toast would take its type default and expire mid-run.
    await send("showToast", { ...toast, duration: 600_000 });
    await page.waitForTimeout(400);
    await shoot(`toast--${toast.type}`, ".tlib-nui-toast");
  }
  await send("dismissAllToasts");
  for (const toast of TOASTS) await send("showToast", { ...toast, duration: 600_000 });
  await page.waitForTimeout(500);
  await shoot("toast--stack", ".tlib-nui-toast");
  await send("dismissAllToasts");
  await page.waitForTimeout(200);
}

if (want("marketplace")) {
  await send("openMarketplace", MARKET_OPEN);
  await page.waitForTimeout(700);
  await shoot("marketplace--uis", ".mp-panel");
  const tabs = page.locator(".mp-tab");
  for (const [index, id] of [
    [1, "sounds"],
    [2, "installed"],
  ] as const) {
    if ((await tabs.count()) > index) {
      await tabs.nth(index).click();
      await page.waitForTimeout(600);
      await shoot(`marketplace--${id}`, ".mp-panel");
    } else {
      flags.push(`marketplace--${id}: the panel has no tab ${index}`);
    }
  }
  await send("closeMarketplace");
  await page.waitForTimeout(200);
}

if (want("layout")) {
  await send("layoutOpen", LAYOUT_OPEN);
  await page.waitForTimeout(600);
  await shoot("layout--editor", ".tlib-layout__panel");
  await send("layoutClose", { session: LAYOUT_OPEN.session });
  await page.waitForTimeout(200);
}

await browser.close();
await server.stop(true);

// tLib's own surfaces are all at this viewport; the prop-editor shots are at each
// consumer's, which is why that count is called out separately rather than folded in.
console.log(
  `[tLib gallery] ${written.length} shots → ${outDir}` + ` (tLib's own surfaces at ${vpW}x${vpH})`
);
for (const flag of flags) console.log(`  flag: ${flag}`);
if (!written.length) process.exit(1);
