// Source preview only: LAYOUT_PREVIEW_URL=http://127.0.0.1:5194
// PLAYWRIGHT_MODULE=<module path> LAYOUT_SCREENSHOT_DIR=<temp dir> bun tests/browser/layout.ts
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.env.LAYOUT_PREVIEW_URL;
if (!url) throw Error("Set LAYOUT_PREVIEW_URL to a source dev server");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const view = { width: 1600, height: 900 };
const page = await browser.newPage({ viewport: view });
const calls: { event: string; data: any }[] = [];
const errors: string[] = [];
const metrics: Record<string, unknown> = {};
const send = (name: string, data: any) =>
  page.evaluate(({ name, data }: any) => window.postMessage({ name, args: [data] }, "*"), {
    name,
    data,
  });
const pause = () => page.waitForTimeout(180);
/** Offsets are reference pixels over a 1080-tall screen, the v2 storage unit. */
const ref = (pixels: number) => pixels / 1080;
const make = (id: string, label: string, x: number, y: number) => {
  const layout = { x, y, scale: 1, visible: true, anchor: "top-left" };
  return {
    key: `tLib:${id}`,
    owner: "tLib",
    id,
    label,
    width: 240,
    height: 90,
    layout,
    defaults: layout,
    minScale: 0.5,
    maxScale: 2,
    canHide: true,
    canScale: true,
  };
};
const SAFEZONE = 0.95;
// The guide inset is a fraction of the SHORTER axis, so it is even on both edges.
const safeInset = (Math.min(view.width, view.height) * (1 - SAFEZONE)) / 2;
const open = (session: number) =>
  send("layoutOpen", {
    session,
    safezone: SAFEZONE,
    components: [
      make("demo", "Radio preview", ref(600), ref(500)),
      make("channels", "Channel list", ref(1100), ref(120)),
      make("notifications", "Notifications", ref(80), ref(120)),
    ],
  });
const panel = page.locator(".tlib-layout__panel");
const surface = page.locator(".tlib-layout");
const button = (name: string | RegExp) => page.getByRole("button", { name });
const proxy = (label: string) => page.locator(`.tlib-layout__proxy[aria-label^="${label}"]`);
const selectedProxy = page.locator(".tlib-layout__proxy--selected");
const row = (label: string) => panel.getByRole("button", { name: new RegExp(`^${label}`) });
const shot = async (name: string) => {
  const directory = process.env.LAYOUT_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await pause(); // Capture settled motion, not a translucent animation frame.
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
};
const dragBy = async (box: any, dx: number, dy: number, modifier?: string) => {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
};
const measure = async (name: string) => {
  metrics[name] = await panel.evaluate((el: HTMLElement) => {
    const parts = [".tlib-layout__row-select", ".tlib-layout__finish", ".tlib-layout__discard"];
    const controls = parts.map((selector) => {
      const target = el.querySelector(selector)!;
      const css = getComputedStyle(target);
      return {
        selector,
        font: css.fontSize,
        color: css.color,
        background: css.backgroundColor,
        height: target.getBoundingClientRect().height,
      };
    });
    return {
      controls,
      panel: el.getBoundingClientRect().toJSON(),
      backdrop: getComputedStyle(el).backdropFilter,
      shadow: getComputedStyle(el).boxShadow,
    };
  });
  const m = metrics[name] as any;
  assert.ok(
    m.controls.every((control: any) => parseFloat(control.font) >= 13),
    `${name}: controls stay legible`
  );
  assert.equal(m.backdrop, "none");
  assert.equal(m.shadow, "none");
  const size = await page.viewportSize();
  assert.ok(m.panel.x >= 0 && m.panel.y >= 0);
  assert.ok(m.panel.right <= size.width && m.panel.bottom <= size.height);
  assert.ok(await button("Save HUD layout").isVisible());
  assert.ok(await button("Cancel").isVisible());
};
try {
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as any).GetParentResourceName = () => "tLib";
  });
  await page.route("https://tlib/**", async (route: any) => {
    calls.push({
      event: new URL(route.request().url()).pathname.slice(1),
      data: route.request().postDataJSON(),
    });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(url);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const prior = document.createElement("button");
    prior.id = "layout-prior-focus";
    prior.textContent = "Previous focus";
    prior.style.position = "fixed";
    prior.style.left = "-10000px";
    document.body.append(prior);
    prior.focus();
  });
  await open(100);
  await panel.waitFor();

  // The panel is a list and two commit actions. Nothing else.
  assert.equal(await page.locator(".tlib-layout__row").count(), 3);
  assert.equal(await page.getByRole("combobox").count(), 0, "no dropdowns remain");
  assert.equal(await page.getByRole("checkbox").count(), 0, "no option checkboxes remain");
  assert.equal(await page.getByRole("spinbutton").count(), 0);
  await measure("desktop");
  await shot("layout-1600x900");

  // Tab stays inside the editor and wraps onto the first enabled control.
  await button("Save HUD layout").focus();
  await page.keyboard.press("Tab");
  assert.ok(
    await surface.evaluate((el: HTMLElement) => {
      const first = el.querySelector("button:not(:disabled)");
      return document.activeElement === first;
    }),
    "Tab wraps inside editor"
  );

  // Selection: the list is how you find a widget you cannot see.
  await row("Channel list").click();
  assert.equal(await selectedProxy.getAttribute("aria-label"), "Channel list");
  await row("Radio preview").click();
  assert.equal(await selectedProxy.getAttribute("aria-label"), "Radio preview");

  // Drag, with snapping to the safe zone and Alt to suspend it.
  const demo = proxy("Radio preview");
  const start = await demo.boundingBox();
  // Land the left edge 4px outside the safe edge: within the 8px threshold.
  await dragBy(demo, safeInset + 4 - start.x, 0);
  assert.ok(
    Math.abs((await demo.boundingBox()).x - safeInset) < 1,
    "a near miss snaps onto the safe-zone edge"
  );
  assert.equal(await page.locator(".tlib-layout__guide").count(), 0, "guides clear on release");
  await button("Undo").click();
  const held = await demo.boundingBox();
  await dragBy(demo, safeInset + 4 - held.x, 0, "Alt");
  assert.ok(
    Math.abs((await demo.boundingBox()).x - (safeInset + 4)) < 1,
    "Alt suspends snapping for exactly the frames it is held"
  );
  await button("Undo").click();

  // Nothing can be dragged off screen and lost.
  for (const [dx, dy] of [
    [4000, 4000],
    [-4000, -4000],
    [4000, -4000],
    [-4000, 4000],
  ]) {
    await dragBy(await demo.boundingBox(), dx, dy);
    const box = await demo.boundingBox();
    const visibleX = Math.min(view.width, box.x + box.width) - Math.max(0, box.x);
    const visibleY = Math.min(view.height, box.y + box.height) - Math.max(0, box.y);
    // 96px or 40% of the rendered extent, whichever is larger, capped by the extent.
    assert.ok(visibleX + 1 >= Math.min(box.width, 96), `dropped at ${dx},${dy}: still grabbable`);
    assert.ok(visibleY + 1 >= Math.min(box.height, 96), `dropped at ${dx},${dy}: still grabbable`);
  }
  // Dropping into a corner re-derives the anchor, which is reported, never chosen.
  await dragBy(await demo.boundingBox(), 4000, 4000);
  assert.match(await page.locator(".tlib-layout__pinned").textContent(), /bottom right/);
  await shot("layout-corner-anchor");
  await dragBy(await demo.boundingBox(), -4000, -4000);
  assert.match(await page.locator(".tlib-layout__pinned").textContent(), /top left/);

  // Scroll wheel scales about the anchor pivot.
  const beforeWheel = await demo.boundingBox();
  assert.equal(await page.locator(".tlib-layout__scale-badge").count(), 0, "no idle readout");
  await page.mouse.move(
    beforeWheel.x + beforeWheel.width / 2,
    beforeWheel.y + beforeWheel.height / 2
  );
  await page.mouse.wheel(0, -120);
  assert.equal(await page.locator(".tlib-layout__scale-badge").count(), 1, "readout while scaling");
  await page.mouse.wheel(0, -120);
  const grown = await demo.boundingBox();
  assert.ok(grown.width > beforeWheel.width);
  // Top-left anchored, so the pivot corner holds still while it grows.
  assert.ok(Math.abs(grown.x - beforeWheel.x) < 1 && Math.abs(grown.y - beforeWheel.y) < 1);
  await page.waitForTimeout(350); // let the burst settle into one history entry
  assert.equal(await page.locator(".tlib-layout__scale-badge").count(), 0);
  await button("Undo").click();
  assert.ok(
    Math.abs((await demo.boundingBox()).width - beforeWheel.width) < 1,
    "a wheel burst is one undo step"
  );
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(350);
  assert.ok((await demo.boundingBox()).width < beforeWheel.width, "the wheel scales both ways");
  await button("Reset this").click();
  assert.ok(Math.abs((await demo.boundingBox()).width - start.width) < 1);

  // Corner handles resize about the opposite corner.
  const handle = await page.locator(".tlib-layout__handle--se").boundingBox();
  const beforeResize = await demo.boundingBox();
  await dragBy(handle, 120, 45);
  const resized = await demo.boundingBox();
  assert.ok(resized.width > beforeResize.width);
  assert.ok(Math.abs(resized.x - beforeResize.x) < 1 && Math.abs(resized.y - beforeResize.y) < 1);
  await button("Undo").click();
  await button("Redo").click();
  assert.ok(Math.abs((await demo.boundingBox()).width - resized.width) < 1);
  await button("Undo").click();

  // Visibility lives on the widget and in the list; both drive one state.
  await proxy("Radio preview").getByRole("button", { name: "Hide Radio preview" }).click();
  assert.ok(
    await demo.evaluate((el: HTMLElement) => el.classList.contains("tlib-layout__proxy--hidden"))
  );
  await row("Radio preview").click();
  await panel.getByRole("button", { name: "Show Radio preview" }).click();
  assert.ok(
    await demo.evaluate((el: HTMLElement) => !el.classList.contains("tlib-layout__proxy--hidden"))
  );

  // Arrow keys nudge the selected widget; the panel handle owns its own.
  const beforeKeys = await demo.boundingBox();
  await surface.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  assert.ok(Math.abs((await demo.boundingBox()).x - beforeKeys.x - 11) < 1);
  await page.keyboard.press("Control+z");
  await pause();

  // The panel itself moves out of the way without becoming a layout entry.
  const beforePanel = await panel.boundingBox();
  const grip = await button("Move editor panel").boundingBox();
  await dragBy(grip, -220, 60);
  const movedPanel = await panel.boundingBox();
  assert.ok(Math.abs(movedPanel.x - beforePanel.x) > 150);
  assert.equal(
    await button("Move editor panel").evaluate((el: HTMLElement) => document.activeElement === el),
    true
  );
  await page.keyboard.press("ArrowRight");
  assert.equal((await panel.boundingBox()).x, movedPanel.x + 10);

  // A smaller window re-clamps everything rather than stranding it.
  await page.setViewportSize({ width: 800, height: 450 });
  await pause();
  for (const label of ["Radio preview", "Channel list", "Notifications"]) {
    const box = await proxy(label).boundingBox();
    assert.ok(box.x + box.width > 0 && box.x < 800, `${label} survived the resize`);
    assert.ok(box.y + box.height > 0 && box.y < 450, `${label} survived the resize`);
  }
  await measure("small");
  await shot("layout-800x450");
  const footerBounds = await button("Save HUD layout").boundingBox();
  assert.ok(
    footerBounds.y >= 0 && footerBounds.y + footerBounds.height <= 450,
    "footer stays accessible while the list scrolls"
  );

  // Commit. The backend owns close; a local click never hides the editor.
  await button("Save HUD layout").click();
  await pause();
  assert.equal(calls.filter((c) => c.event === "layoutFinish").at(-1)?.data.save, true);
  assert.ok(await panel.isVisible(), "backend, not a local click, owns close");
  const previews = calls.filter((c) => c.event === "layoutPreview");
  assert.ok(previews.length > 0);
  assert.ok(
    previews.every(
      (c, i) =>
        c.data.session === 100 && (i === 0 || c.data.revision > previews[i - 1].data.revision)
    )
  );
  assert.ok(
    calls.findLastIndex((c) => c.event === "layoutPreview") <
      calls.findLastIndex((c) => c.event === "layoutFinish")
  );
  await send("layoutClose", { session: 99 });
  assert.ok(await panel.isVisible(), "stale close ignored");
  await send("layoutClose", { session: 100 });
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "layout-prior-focus",
    "backend close restores prior focus"
  );

  // Theming, reduced motion and discard.
  await page.setViewportSize(view);
  await open(101);
  await panel.waitFor();
  await send("addTheme", {
    id: "layout-test",
    cssVars: { primary: "120 60% 40%", "primary-foreground": "0 0% 100%", card: "210 20% 15%" },
  });
  await send("setTheme", { id: "layout-test" });
  await pause();
  assert.equal(
    await button("Save HUD layout").evaluate(
      (el: HTMLElement) => getComputedStyle(el).backgroundColor
    ),
    "rgb(41, 163, 41)"
  );
  assert.equal(
    await panel.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor),
    "rgb(31, 38, 46)"
  );
  await shot("layout-explicit-theme");
  await send("removeTheme", { id: "layout-test" });
  await pause();
  assert.equal(
    await button("Save HUD layout").evaluate(
      (el: HTMLElement) => getComputedStyle(el).backgroundColor
    ),
    "rgb(238, 238, 238)"
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await button("Save HUD layout").evaluate(
      (el: HTMLElement) => getComputedStyle(el).transitionDuration
    ),
    "0s"
  );
  await button("Cancel").click();
  await pause();
  assert.equal(calls.filter((c) => c.event === "layoutFinish").at(-1)?.data.save, false);
  await send("layoutClose", { session: 101 });
  await panel.waitFor({ state: "hidden" });

  // Session fencing: a replacement session supersedes the old one.
  await open(102);
  await panel.waitFor();
  await open(103);
  await pause();
  await send("layoutRemove", { session: 103, key: "tLib:channels" });
  await pause();
  assert.equal(await page.locator(".tlib-layout__row").count(), 2, "a stopped resource drops out");
  await send("layoutClose", { session: 102 });
  assert.ok(await panel.isVisible(), "stale close ignored");
  await page.keyboard.press("Escape");
  await pause();
  assert.deepEqual(calls.filter((c) => c.event === "layoutFinish").at(-1)?.data, {
    session: 103,
    save: false,
  });
  await send("layoutClose", { session: 103 });
  assert.deepEqual(errors, []);
  const directory = process.env.LAYOUT_SCREENSHOT_DIR;
  if (directory)
    await Bun.write(resolve(directory, "layout-metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(
    "PASS: list-only panel, selection, snapping and Alt, off-screen recovery, derived anchors, wheel scaling, corner resize, visibility, arrow nudge, panel drag, resize re-clamp, 1600/800 bounds, preview revisions/save/backend close/discard/Escape, session fencing, theme, reduced motion; no browser errors"
  );
} finally {
  await browser.close();
}
