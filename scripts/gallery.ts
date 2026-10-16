/**
 * `bun run gallery` — every surface tLib draws, photographed, into one flat folder.
 *
 *   assets/gallery/menu--<id>.png         a menu page per row kind, per skin, per accent
 *   assets/gallery/dialog--<id>.png       each dialog size and every field type
 *   assets/gallery/toast--<id>.png        each toast type, and the stack
 *   assets/gallery/marketplace--<id>.png  each catalogue tab
 *   assets/gallery/layout--<id>.png       the HUD layout editor
 *   assets/gallery/propeditor/<host>/     the shared 3D prop editor, once per host
 *
 * ## The prop editor is the odd one out, and deliberately so
 *
 * Every other surface here is drawn by tLib's OWN bundle, so one bundle photographs all
 * of them. `@tlib/internal/prop-editor` is not in tLib's NUI at all — tLib ships the
 * component, tRadio, tRadar and tDetector mount it — and its whole appearance comes from
 * token NAMES whose VALUES are per-resource (tRadio scopes its own set to
 * `.radio-settings-root`; the other two inherit tLib's `theme-tokens.css` from `:root`).
 * So the honest picture of it is three pictures, each out of a consumer's real shipped
 * bundle. This surface drives each consumer's own `bun run gallery -- --only propeditor`,
 * which is the same command and the same driver
 * (`shared/ts/build/prop-editor-gallery.ts`) they use on their own.
 *
 * Shooting a synthetic tLib-only page instead was the alternative and is worse: it would
 * photograph a page nothing ships, and the per-resource token values — the one thing
 * worth looking at three times — would be exactly what it could not show.
 *
 * Pictures and nothing else: no contact sheet, no report.json. What could not be shot is
 * printed as a flag at the end, which is the only thing a run is worth reading for.
 *
 *   bun run gallery
 *   bun run gallery -- --only dialog,toast
 *   bun run gallery -- --viewport 1920x1080 --out D:/art
 *   bun run gallery -- --rebuild          # force a fresh client/ui bundle first
 *
 * `assets/` is git-ignored and is not shipped, so this is safe to regenerate at will.
 *
 * This drives the REAL built bundle with a mocked NUI transport, exactly as
 * `tests/browser/*.ts` do — same `GetParentResourceName` stub, same `https://tlib/**` route,
 * same `{name, args:[payload]}` envelope. The fixtures are the difference: `gallery-fixtures.ts`
 * is representative content, those harnesses use content chosen to break things.
 *
 * Every shot asserts its surface is actually on screen before the shutter. Without that, a
 * payload the UI silently rejected photographs as an empty page that looks like a real result.
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
 * The resources that mount `@tlib/internal/prop-editor`, and where each puts the shots.
 *
 * Sibling directories of tLib, which is how every resource in `[tScripts]` already
 * reaches the others (`tRadar/scripts/gallery.ts` imports `../../tLib/...`). A host that
 * is not checked out is skipped with a flag rather than failing the run — this folder is
 * frequently a partial checkout.
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
/** The NUI is transparent over the game. On a white page half of it is invisible; this is a
 *  neutral mid-grey so both the light and the dark parts of every surface can be judged.
 *
 *  `--transparent` shoots on transparency instead, the way tAFK's and tUnit's galleries do by
 *  default. That is what a composite wants: the surfaces are small panels on a large empty page,
 *  so any fill at all — even one matching the destination — lands as a rectangle around the
 *  component rather than as the component. Needs BOTH halves: the page must not paint a
 *  background AND the screenshot must not composite one in.
 *
 *  A flag rather than `--background ""`, because `cliArg` rejects an empty value on purpose —
 *  it reads one as a typo rather than as an instruction. */
const background = cliArg("background", "#3a3f47");
const transparent = process.argv.includes("--transparent");

const want = (s: Surface) => only.includes(s);

const flags: string[] = [];
const written: string[] = [];

// The prop editor: one run per host, out of that host's own bundle
// First, and in its own block, because it is the one surface that does not come out of
// tLib's bundle — everything below this point is about tLib's own NUI, and a
// `--only propeditor` run has no reason to build it or open a browser on it.
// A missing host is already a flag rather than a failure, but a tree with NO
// host at all is a standalone clone of tLib rather than a partial checkout, and
// three flags saying so plus a `--only propeditor` run that exits 1 is a broken
// gallery, not a report.
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
 *
 * "Visible" is not the same as "all of it is visible". The dialog caps itself at `max-height:85vh`
 * and scrolls its field area, so on the default 900px viewport a tall fixture photographs as a
 * complete-looking panel — sticky footer and all — with its last fields simply scrolled off. That
 * is how `dialog--every-field` came to be missing its checkbox and button while both rendered
 * correctly: the shot was clipped, not the render. `fullPage` would not have helped, because the
 * overflow is inside an element rather than the document.
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
 * Shoot, but only once the surface is provably on screen and provably whole.
 *
 * A payload the UI rejected photographs as the empty page behind it, which is indistinguishable
 * from a good shot — hence the visibility gate. The clip gate is the same argument one level in:
 * a surface that scrolls is showing you part of itself, and nothing in the image says so.
 *
 * On a clipped surface the viewport GROWS and the shot is retaken rather than the fixture being
 * shrunk to fit. The surfaces are sized in `vh`, so the room gained per pixel is less than one and
 * this converges rather than solving in a single step. The viewport is restored afterwards so one
 * tall fixture cannot silently rescale every shot that follows it.
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
    // Surfaces are sized in `vh`, so a pixel of viewport buys less than a pixel of room and this
    // has to over-ask to converge rather than creep.
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

    // Stop on what the growth MEASURED, not on an attempt budget. A surface with a fixed pixel
    // height does not grow with the viewport at all — `.mp-panel` is 650px tall at both 900px and
    // 1788px of viewport, and its list overflows by the same 112px either way. Against a fixed
    // budget that spends every attempt, gains nothing, and then takes the shot without flagging:
    // silently wrong, and it produced a marketplace shot twice as tall as it needed to be with the
    // same card still cut off. If a bigger viewport did not buy room, it is the wrong lever.
    const after = await clippedBy(selector).catch(() => 0);
    if (after > CLIP_TOLERANCE_PX && after >= over) {
      flags.push(
        `${name}: ${after}px of it is scrolled out of the shot, and a taller viewport does not help` +
          ` — this surface has a fixed height, so the shot shows only part of its content`
      );
      // A taller viewport bought nothing, so keep the composition the rest of the run uses.
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
