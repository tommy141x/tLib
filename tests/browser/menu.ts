// MENU_PREVIEW_URL=http://127.0.0.1:5176 PLAYWRIGHT_MODULE=<installed module>
// MENU_SCREENSHOT_DIR=<temp directory> bun tests/browser/menu.ts
// MENU_BUILT=1 skips only the dev-only generated demo for a served built runtime.
// Both modes exercise the actual renderer through the same mocked NUI transport.
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.MENU_PREVIEW_URL;
if (!url)
  throw new Error("Set MENU_PREVIEW_URL to a running development server or served built runtime");
const built = process.env.MENU_BUILT === "1";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
const screenshot = async (name: string) => {
  if (!process.env.MENU_SCREENSHOT_DIR) return;
  await mkdir(process.env.MENU_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.MENU_SCREENSHOT_DIR, `${name}.png`) });
};
const send = (name: string, data: unknown) =>
  page.evaluate(
    ({ name, data }: any) => window.postMessage({ name, args: [data] }, location.origin),
    { name, data }
  );
const active = () => page.locator(".menu-row.is-active .row-main").getAttribute("id");
const fixture = {
  version: 1,
  visible: true,
  menuId: "main",
  menus: [
    {
      id: "main",
      title: "Menu controls",
      subtitle: "Presentation fixture",
      items: [
        {
          id: "boolean",
          kind: "toggle",
          label: "Show player names",
          value: false,
          description: "A boolean action uses the existing button contract and checkbox indicator.",
        },
        {
          id: "select",
          kind: "select",
          label: "Camera mode",
          value: "a",
          options: [
            { label: "Default", value: "a" },
            { label: "Cinematic", value: "b" },
          ],
        },
        { id: "slider", kind: "slider", label: "Distance", min: 0, max: 100, step: 5, value: 50 },
        {
          id: "disabled",
          kind: "action",
          label: "Permission restricted",
          disabled: true,
          description: "Your owner permissions do not grant this action.",
        },
        {
          id: "danger",
          kind: "action",
          label: "Reset appearance",
          danger: true,
          confirm: "Reset your current appearance?",
        },
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `row${i}`,
          kind: "action",
          label: `Extra option ${i + 1}`,
        })),
      ],
    },
  ],
};
const actions: any[] = [];
try {
  if (!built) {
    // No injected transport: this loads menu/generated/menus.json through preview.ts.
    await page.goto(url);
    await page.locator(".menu-row").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.locator('[id="item-%5B%22example%3Aaction%22%5D"]').waitFor();
    const first = await active();
    await page.keyboard.press("ArrowDown");
    assert.notEqual(await active(), first);
    await screenshot("menu-generated-1600x900");
    await page.setViewportSize({ width: 800, height: 450 });
    await screenshot("menu-generated-800x450");
  }
  // Local bridge: actual renderer and validator, deterministic rows/replies, no game.
  await page.addInitScript(() => {
    (window as any).GetParentResourceName = () => "tLib";
  });
  await page.route("https://tlib/**", async (route: any) => {
    const event = new URL(route.request().url()).pathname;
    let reply: any = { ok: true };
    if (event === "/menu_ready" || event === "/menu_resync") reply.snapshot = fixture;
    if (event === "/menu_action") {
      actions.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 650));
      reply = { ok: false, error: "Fixture rejection: no game action performed." };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reply),
    });
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  // Install transport before the first navigation in built mode: no preview import
  // exists there and menu_ready must receive the fixture on initial mount.
  await page.goto(url);
  await page.locator('[id="item-%5B%22boolean%22%5D"]').waitFor();
  assert.equal(
    await page.locator('[id="item-%5B%22boolean%22%5D"]').getAttribute("aria-pressed"),
    "false"
  );
  await screenshot("menu-controls-1600x900");
  await send("menu:navigate", "down");
  await page.waitForTimeout(40);
  assert.equal(
    await active(),
    "item-%5B%22select%22%5D",
    "native command shares keyboard selection"
  );
  await send("menu:navigate", "up");
  await page.waitForTimeout(40);
  await page.keyboard.press("Enter");
  await page.locator(".menu-row.is-pending").waitFor();
  assert.equal(
    await page.locator('[id="item-%5B%22boolean%22%5D"]').getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(await page.locator(".menu-row.is-pending").getAttribute("aria-busy"), "true");
  await screenshot("menu-pending-1600x900");
  await page.waitForTimeout(800);
  assert.equal(actions[0].value, true);
  assert.equal(
    await page.locator('[id="item-%5B%22boolean%22%5D"]').getAttribute("aria-pressed"),
    "false"
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator(".is-active .choice-value").textContent(), "Cinematic");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator(".is-active input").inputValue(), "55");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(actions.length, 1, "disabled action never dispatches");
  assert.equal(
    await page
      .locator(".is-disabled .action-mark svg")
      .evaluate((el: Element) => getComputedStyle(el).animationName),
    "none",
    "Ban icon must not spin"
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator(".confirmation").waitFor();
  await screenshot("menu-confirmation-1600x900");
  await page.keyboard.press("Escape");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
  assert.ok((await active())?.startsWith("item-%5B%22row"));
  assert.equal(await page.locator(".menu-row").count(), 9, "selection window retained");
  await send("menu:input", true);
  await page.locator(".search-wrap input").fill("Permission");
  assert.equal(await page.locator(".menu-row").count(), 1);
  assert.equal(
    await page
      .locator(".search-wrap input")
      .evaluate((el: Element) => getComputedStyle(el).outlineWidth),
    "2px"
  );
  await screenshot("menu-search-1600x900");
  await page.keyboard.press("Escape");
  await send("menu:snapshot", fixture);
  await send("addTheme", {
    id: "menu-hsl",
    cssVars: {
      foreground: "0 0% 94%",
      card: "0 0% 12%",
      border: "0 0% 35%",
      muted: "0 0% 20%",
      "muted-foreground": "0 0% 70%",
      accent: "0 0% 90%",
    },
  });
  await send("menu:branding", { themes: { menus: { main: { theme: "menu-hsl" } } } });
  await page.waitForTimeout(100);
  const theme = await page.locator(".tlib-menu").evaluate((el: HTMLElement) => ({
    text: el.style.getPropertyValue("--text"),
    border: el.style.getPropertyValue("--border"),
  }));
  assert.equal(theme.border, "hsl(0 0% 35%)");
  assert.equal(theme.text, "hsl(0 0% 94%)");
  await send("addTheme", {
    id: "menu-full",
    cssVars: {
      text: "#fefefe",
      panel: "#202020",
      border: "#777777",
      muted: "#bcbcbc",
      selected: "#e0e0e0",
    },
  });
  await send("menu:branding", { themes: { menus: { main: { theme: "menu-full" } } } });
  await page.waitForTimeout(100);
  // The theme's panel colour, carrying the default skin's transparency: the
  // panel is over the game, not over a page. Alpha is the skin's, the colour is
  // the theme's, which is what this is checking.
  assert.equal(
    await page
      .locator(".menu-panel")
      .evaluate((el: Element) => getComputedStyle(el).backgroundColor),
    "color(srgb 0.12549 0.12549 0.12549 / 0.94)"
  );
  await send("removeTheme", { id: "menu-full" });
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .locator(".tlib-menu")
      .evaluate((el: HTMLElement) => el.style.getPropertyValue("--text")),
    ""
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.locator(".menu-panel").evaluate((el: Element) => getComputedStyle(el).animationName),
    "none"
  );
  await page.setViewportSize({ width: 800, height: 450 });
  await screenshot("menu-controls-800x450");
  const bounds = await page.locator(".menu-panel").boundingBox();
  assert.ok(
    bounds &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 800 &&
      bounds.y + bounds.height <= 450
  );

  // --- Skins -----------------------------------------------------------------
  // The default skin is the shared look the dialogs and toasts already wear; the
  // vMenu replica is a switchable test skin. Both are measured here, so promoting
  // the default cannot quietly delete the replica's geometry -- every number in
  // the vmenu block below is the number tMenu shipped before the split.
  await page.setViewportSize({ width: 1600, height: 900 });
  // The submenu row goes first so it is inside the nine-row window whatever the
  // cursor did above; the chevron marker is the thing being counted.
  const skinFixture = {
    ...fixture,
    menus: [
      {
        ...fixture.menus[0],
        items: [
          { id: "branch", kind: "submenu", label: "More options", menu: "main" },
          ...fixture.menus[0].items,
        ],
      },
    ],
  };
  await send("menu:branding", {});
  await send("menu:snapshot", skinFixture);
  await page.waitForTimeout(60);
  // Put the cursor on the submenu row deterministically -- focusing a row is one
  // of the ways it becomes selected -- so the scroll window starts at the top and
  // the slider measured below is NOT the highlighted row, where the accent is
  // deliberately inverted. Counting arrow presses would depend on where the block
  // above left the cursor and on the fact that selection wraps.
  await page.locator('[id="item-%5B%22branch%22%5D"]').focus();
  await page.waitForTimeout(60);
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      });
  // display:none is how the default reduces vMenu's tri-chevron to one arrow, so
  // count what is painted rather than what is in the DOM.
  const chevrons = () =>
    page
      .locator(".row-chevron")
      .first()
      .evaluate(
        (el: Element) =>
          Array.from(el.querySelectorAll("svg")).filter(
            (svg) => getComputedStyle(svg).display !== "none"
          ).length
      );
  const rangeFill = () =>
    page
      .locator(".row-slider input")
      .first()
      .evaluate((el: Element) => getComputedStyle(el).backgroundImage);
  // The slider track is one gradient with a hard stop, so the two colour stops are
  // the whole story: equal stops paint a flat bar, different ones paint a filled
  // share. That is the difference between the two skins, and it is the half of the
  // replica's slider that can actually be observed -- Chromium answers
  // getComputedStyle(el, '::-webkit-slider-thumb') with the host input's own box
  // (a 6px-tall strip as wide as the element), so the thumb's 15px-vs-17px size and
  // its border are NOT measurable here and are deliberately not asserted.
  const trackStops = async () => {
    const match = /linear-gradient\(to right, (.+?) [\d.]+%, (.+?) 0(?:px)?\)/.exec(
      await rangeFill()
    );
    assert.ok(
      match,
      `slider track is not the expected one-gradient hard stop: ${await rangeFill()}`
    );
    return { filled: match![1]!, rest: match![2]! };
  };
  const brandFont = () =>
    page
      .locator(".brand-word")
      .first()
      .evaluate((el: Element) => getComputedStyle(el).fontSize);

  assert.equal(
    await page.locator(".tlib-menu").getAttribute("data-skin"),
    "default",
    "default skin with no theme"
  );
  assert.equal((await box(".menu-panel")).width, 360, "default panel is the dialog md width");
  assert.equal((await box(".menu-row")).height, 34, "default row is the shared control height");
  assert.equal((await box(".menu-brand")).height, 46, "default brand is a bar, not a 107px band");
  assert.equal(await brandFont(), "16px", "default brand reads at the dialog title size");
  assert.equal(await chevrons(), 1, "default marks a submenu with one chevron");
  // One implementation: the row's checkbox IS the class a dialog's Ark checkbox
  // wears, and the slider IS the shared native-range dressing.
  assert.equal(await page.locator(".toggle.tlib-nui-checkbox-control").count(), 1);
  assert.equal((await box(".toggle")).width, 17, "shared 17px checkbox");
  assert.equal(await page.locator(".row-slider input.tlib-nui-range").count(), 1);
  assert.equal((await box(".row-slider input")).height, 6, "shared 6px slider track");
  {
    const stops = await trackStops();
    assert.notEqual(
      stops.filled,
      stops.rest,
      "the default slider shows its filled share, like a dialog slider"
    );
  }
  // The computed value keeps the author's quoting, so compare the first family
  // rather than the whole stack.
  const firstFace = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el: Element) =>
        getComputedStyle(el)
          .fontFamily.split(",")[0]!
          .replace(/^["']|["']$/g, "")
      );
  assert.equal(
    await firstFace(".tlib-menu"),
    "Hanken Grotesk",
    "the menu draws the one face tLib ships"
  );
  assert.equal(
    await firstFace("body"),
    "Hanken Grotesk",
    "and so does everything else on the page"
  );

  // tokens.css maps --nui-* from the menu's own colours as a stylesheet rule; a
  // theme's cssVars land as INLINE styles on the menu root and therefore beat it.
  // That is the documented way one theme id accents a menu, a dialog and a toast
  // identically, so it is asserted rather than assumed.
  assert.ok(
    (await rangeFill()).includes("rgb(238, 238, 238)"),
    "unthemed fill comes from the --selected mapping"
  );
  await send("addTheme", { id: "menu-nui", cssVars: { "nui-accent": "#ff00aa" } });
  await send("menu:branding", { themes: { menus: { main: { theme: "menu-nui" } } } });
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .locator(".tlib-menu")
      .evaluate((el: HTMLElement) => el.style.getPropertyValue("--nui-accent")),
    "#ff00aa"
  );
  assert.ok(
    (await rangeFill()).includes("rgb(255, 0, 170)"),
    "a theme-set --nui-accent overrides the stylesheet mapping"
  );
  await send("removeTheme", { id: "menu-nui" });
  await page.waitForTimeout(100);
  assert.ok(
    (await rangeFill()).includes("rgb(238, 238, 238)"),
    "removing the theme returns to the mapping"
  );

  await send("menu:branding", { themes: { menus: { main: { skin: "vmenu" } } } });
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".tlib-menu").getAttribute("data-skin"), "vmenu");
  assert.equal((await box(".menu-panel")).width, 431, "vMenu 1080p width");
  assert.equal((await box(".menu-row")).height, 38, "vMenu 1080p row");
  assert.equal((await box(".menu-brand")).height, 107, "vMenu brand band");
  // --brand-title-font, not --brand-font: this fixture carries a subtitle, so the
  // word in the band is the source-title variant the close button bounds.
  assert.equal(await brandFont(), "34px", "vMenu brand title size");
  assert.equal((await box(".scroll-cue")).height, 30, "vMenu scroll-cue strip");
  assert.equal(await chevrons(), 3, "vMenu marks a submenu with three chevrons");
  {
    // The source draws a flat bar for a row with no barColor, so the replica must
    // not inherit the shared filled-share track. This is the assertion that would
    // have caught the shared slider leaking into the skin when the default was
    // promoted: the geometry above was all still correct at the time.
    const stops = await trackStops();
    assert.equal(
      stops.filled,
      stops.rest,
      "vMenu draws a flat slider bar unless the row sets a barColor"
    );
  }
  await screenshot("menu-skin-vmenu-1600x900");
  // The replica's viewport steps, which are the only reason it scales at all.
  await page.setViewportSize({ width: 1600, height: 1250 });
  assert.equal((await box(".menu-panel")).width, 575);
  assert.equal((await box(".menu-row")).height, 51);
  await page.setViewportSize({ width: 1600, height: 640 });
  assert.equal((await box(".menu-row")).height, 28);
  await page.setViewportSize({ width: 1600, height: 900 });
  await send("menu:branding", {});
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".tlib-menu").getAttribute("data-skin"),
    "default",
    "clearing branding returns to the default skin"
  );
  await screenshot("menu-skin-default-1600x900");

  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${built ? "built mode (dev-only generated demo skipped)" : "generated preview keyboard"}; local bridge boolean/pending/rejection, select/slider, disabled, confirmation, nine-row window, search, owner HSL/full-color/removal, reduced motion, 800x450 bounds, default-skin geometry and shared controls, theme-set --nui-* override, vMenu skin geometry, its flat slider track and its viewport steps.`
  );
} finally {
  await browser.close();
}
