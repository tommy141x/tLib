// Mocked browser evidence only: no live marketplace, writes, or migration claim.
// MARKETPLACE_PREVIEW_URL=http://127.0.0.1:5191 PLAYWRIGHT_MODULE=<path> bun tests/browser/marketplace.ts
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.env.MARKETPLACE_PREVIEW_URL;
if (!url) throw Error("Set MARKETPLACE_PREVIEW_URL to a dev server (no production build required)");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [],
  queries: URL[] = [],
  calls: { event: string; data: any }[] = [];
const directory = process.env.MARKETPLACE_SCREENSHOT_DIR;
const screenshot = async (name: string) => {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
};
const send = (name: string, data: unknown) =>
  page.evaluate(({ name, data }: any) => window.postMessage({ name, args: [data] }, "*"), {
    name,
    data,
  });
const open = (resource = "tDetector") =>
  send("openMarketplace", {
    baseUrl: "https://marketplace.test",
    resource,
    installedSlugs: ["item-0"],
    installedLayouts: ["default", "item-0"],
  });
const card = (text: string) =>
  page.locator(".mp-card").filter({ has: page.getByText(text, { exact: true }) });
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
  await page.route("https://marketplace.test/**", async (route: any) => {
    const requestUrl = new URL(route.request().url());
    queries.push(requestUrl);
    if (requestUrl.pathname.endsWith("/ui.html")) {
      await route.fulfill({
        contentType: "text/html",
        body: '<html><body><div style="width:300px;height:100px;color:white">Mock layout preview</div></body></html>',
      });
      return;
    }
    const search = requestUrl.searchParams.get("search");
    if (search === "old") await new Promise((r) => setTimeout(r, 900));
    if (search === "failure") {
      await route
        .fulfill({ status: 503, json: { error: "Mock catalog unavailable" } })
        .catch(() => {});
      return;
    }
    const offset = Number(requestUrl.searchParams.get("cursor") ?? 0);
    const count = search ? 1 : offset === 0 ? 50 : 1;
    const items = Array.from({ length: count }, (_, i) => ({
      id: String(i + offset),
      slug: `item-${i + offset}`,
      type: requestUrl.searchParams.get("type") ?? "ui",
      name:
        search ??
        `${["Signal compact", "Nightline display", "Minimal dashboard"][i % 3]} ${i + offset}`,
      description:
        "A focused community layout with clear status indicators and a compact footprint.",
      creator_name: "Mock creator",
      current_version: "1.2.0",
      size_bytes: 32800,
      downloads: 128 + i,
      created_at: "2026-01-01",
    }));
    await route.fulfill({ json: { items } }).catch(() => {});
  });
  await page.goto(url);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const label = document.createElement("div");
    label.textContent = "MOCK MARKETPLACE / NUI • browser-only evidence";
    label.style.cssText =
      "position:fixed;left:12px;bottom:2px;z-index:11000;font:12px Arial;color:#ddd;pointer-events:none";
    document.body.append(label);
    document.body.style.background = "#25282b";
  });
  await open();
  await card("Signal compact 0").waitFor();
  // Uno's dev server can deliver its generated utility sheet after the first render.
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".mp-card > div")!).display === "flex"
  );
  await page.waitForTimeout(180);
  assert.equal(
    await page.getByRole("button", { name: "Previous page", exact: true }).isDisabled(),
    true
  );
  await screenshot("marketplace-desktop");
  const sizes = await page
    .locator(".mp-panel")
    .evaluate((panel: HTMLElement) =>
      [...panel.querySelectorAll("button,input,.mp-card span,.mp-card p")].map((e) =>
        Number.parseFloat(getComputedStyle(e).fontSize)
      )
    );
  assert.ok(
    sizes.every((size: number) => size >= 14),
    "Core text and controls have a 14px minimum"
  );
  const previewButton = card("Signal compact 0").getByRole("button", { name: "Show preview" });
  await previewButton.hover();
  await page.waitForTimeout(130);
  assert.notEqual(
    await previewButton.evaluate((el: HTMLElement) => getComputedStyle(el).boxShadow),
    "none",
    "Shared button has visible hover feedback"
  );
  await screenshot("marketplace-hover");
  const sort = page.getByRole("combobox", { name: "Sort items" });
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await screenshot("marketplace-select-keyboard");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("dialog", { name: "Marketplace" }).count(),
    1,
    "Select Escape does not close panel"
  );
  assert.equal(calls.filter((c) => c.event === "marketplaceClose").length, 0);
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  // Ark transfers focus after mounting the portal; send list navigation only once it owns focus.
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "listbox");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  assert.ok(
    queries.some((q) => q.searchParams.get("sort") === "created_at"),
    "Keyboard selection triggers real sort query"
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await card("Signal compact 50").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Next page", exact: true }).isDisabled(),
    true
  );
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await card("Signal compact 0").waitFor();
  const search = page.getByRole("searchbox", { name: "Search marketplace items" });
  await search.fill("old");
  await page.waitForTimeout(350);
  await screenshot("marketplace-loading-search");
  await search.fill("new");
  await card("new").waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await card("old").count(), 0, "Stale search cannot replace latest results");
  assert.equal(
    await page.getByRole("button", { name: "Previous page", exact: true }).isDisabled(),
    true,
    "Search resets pagination"
  );
  await search.fill("failure");
  await page.getByRole("alert").filter({ hasText: "Mock catalog unavailable" }).waitFor();
  await screenshot("marketplace-browse-error");
  const failedQueries = queries.filter((q) => q.searchParams.get("search") === "failure").length;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Mock catalog unavailable" }).waitFor();
  assert.equal(
    queries.filter((q) => q.searchParams.get("search") === "failure").length,
    failedQueries + 1,
    "Browse Retry issues a new request"
  );
  await search.fill("new");
  await card("new").waitFor();
  await card("new").getByRole("button", { name: "Reinstall", exact: true }).click();
  await card("new").getByRole("button", { name: "Installing…", exact: true }).waitFor();
  assert.ok(
    await card("new").getByRole("button", { name: "Installing…", exact: true }).isDisabled()
  );
  assert.deepEqual(calls.find((c) => c.event === "marketplaceInstall")?.data, {
    type: "ui",
    slug: "item-0",
    version: "1.2.0",
    resource: "tDetector",
  });
  await send("marketplaceInstallResult", { ok: true, slug: "item-0", resource: "wrong-resource" });
  assert.equal(
    await card("new").getByRole("button", { name: "Installing…", exact: true }).count(),
    1,
    "Foreign receipt ignored"
  );
  await send("marketplaceInstallResult", {
    ok: false,
    slug: "item-0",
    resource: "tDetector",
    error: "Mock install receipt rejected",
  });
  await card("new").getByRole("alert").waitFor();
  await screenshot("marketplace-install-error");
  await card("new").getByRole("button", { name: "Retry", exact: true }).click();
  await send("marketplaceInstallResult", { ok: true, slug: "item-0", resource: "tDetector" });
  await card("new").getByRole("button", { name: "Reinstall", exact: true }).waitFor();
  await card("new").getByRole("button", { name: "Delete from server" }).click();
  await send("marketplaceUninstallResult", {
    ok: false,
    resource: "tDetector",
    slug: "item-0",
    error: "Ownership receipt missing (mock)",
  });
  await page.getByRole("alert").filter({ hasText: "Ownership receipt missing" }).waitFor();
  await page.setViewportSize({ width: 800, height: 450 });
  await screenshot("marketplace-800x450-error");
  await page.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("alert").count(), 0, "Dismiss clears operation error");
  await search.fill("");
  await card("Signal compact 0").waitFor();
  await screenshot("marketplace-800x450-browse");
  const overflow = await page
    .locator(".mp-panel")
    .evaluate((panel: HTMLElement) => panel.scrollWidth > panel.clientWidth);
  assert.equal(overflow, false, "No horizontal panel overflow at 800x450");
  await page.getByRole("button", { name: "Installed", exact: true }).click();
  await card("default").waitFor();
  assert.equal(
    await card("default").getByRole("button", { name: "Delete from server" }).count(),
    0,
    "Built-in layout has no invented uninstall ownership"
  );
  assert.equal(
    await card("default").getByRole("button", { name: "Reinstall", exact: true }).count(),
    0,
    "Inspection does not invent built-in replacement ownership"
  );
  await screenshot("marketplace-800x450-installed");
  await page.getByRole("button", { name: "UIs", exact: true }).click();
  await card("Signal compact 0").waitFor();
  await card("Signal compact 0").getByRole("button", { name: "Show preview" }).click();
  await page.getByTitle("Signal compact 0 preview").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("dialog", { name: "Marketplace" }).count(),
    1,
    "Preview Escape returns to browse"
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
  assert.equal(
    calls.filter((c) => c.event === "marketplaceClose").length,
    1,
    "Panel Escape owns one close callback"
  );
  await open();
  await card("Signal compact 0").waitFor();
  await sort.click();
  await page.getByRole("listbox").waitFor();
  await send("closeMarketplace", {});
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("listbox").count(), 0, "Backend close unmounts select portal");
  assert.equal(
    calls.filter((c) => c.event === "marketplaceClose").length,
    1,
    "Backend close does not echo a close callback"
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open();
  await card("Signal compact 0").waitFor();
  assert.equal(
    await page
      .locator(".mp-panel")
      .evaluate((el: HTMLElement) => getComputedStyle(el).animationName),
    "none"
  );
  assert.ok(queries.every((q) => Number(q.searchParams.get("limit")) <= 100));
  assert.ok(queries.some((q) => q.searchParams.get("cursor") === "50"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mocked marketplace desktop/800x450, shared 14px controls, keyboard sort/Escape, pagination, stale search, install resource fencing, visible errors/dismiss, built-in ownership, preview/backend close, reduced motion."
  );
} catch (error) {
  await screenshot("marketplace-failure");
  throw error;
} finally {
  await browser.close();
}
