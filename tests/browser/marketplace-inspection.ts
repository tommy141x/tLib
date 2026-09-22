// Mocked NUI only; no packages, filesystem operations or live server authorization.
// MARKETPLACE_PREVIEW_URL=<local URL> PLAYWRIGHT_MODULE=<module> bun tests/browser/marketplace-inspection.ts
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.env.MARKETPLACE_PREVIEW_URL;
if (!url) throw Error("Set MARKETPLACE_PREVIEW_URL");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [],
  calls: { event: string; data: any }[] = [];
let failTransport = false,
  holdNextAck = false;
let heldAck: any;
const send = (name: string, data: unknown) =>
  page.evaluate(({ name, data }: any) => window.postMessage({ name, args: [data] }, "*"), {
    name,
    data,
  });
const card = (name: string) =>
  page.locator(".mp-card").filter({ has: page.getByText(name, { exact: true }) });
const inspect = (name: string) =>
  card(name).getByRole("button", { name: `Inspect installation: ${name}`, exact: true });
const requests = () => calls.filter((call) => call.event === "marketplaceInspect");
const last = () => requests().at(-1)!.data;
const start = async (name: string) => {
  const before = requests().length;
  await inspect(name).click();
  await page.waitForFunction(
    () => document.querySelector(".mp-inspection strong")?.textContent === "Checking installation"
  );
  for (let attempt = 0; attempt < 50 && requests().length === before; attempt++)
    await page.waitForTimeout(20);
  assert.equal(requests().length, before + 1);
  return last();
};
const reply = (request: any, status = "managed", lock = "absent", policyAvailable = true) =>
  send("marketplaceInspectResult", {
    ...request,
    ok: true,
    inspection: {
      resourceName: request.resource,
      type: request.type,
      slug: request.slug,
      status,
      lock,
      policyAvailable,
    },
  });
const open = async (resource = "tDetector") => {
  await send("openMarketplace", {
    baseUrl: "https://catalog.test",
    resource,
    installedSlugs: ["managed"],
    installedLayouts: ["managed", "custom", "default", "Local Layout"],
    installedSounds: [{ filename: "my horn.ogg", slug: "" }],
  });
  await page.getByRole("button", { name: "Installed", exact: true }).click();
  await card("custom").waitFor();
};
const shot = async (name: string) => {
  const dir = process.env.MARKETPLACE_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
};
try {
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).GetParentResourceName = () => "tLib";
  });
  await page.route("https://tlib/**", async (route: any) => {
    const event = new URL(route.request().url()).pathname.slice(1);
    calls.push({ event, data: route.request().postDataJSON() });
    if (event === "marketplaceInspect" && holdNextAck) {
      holdNextAck = false;
      heldAck = route;
      return;
    }
    if (event === "marketplaceInspect" && failTransport) {
      await route.abort();
      return;
    }
    await route.fulfill({ json: 1 });
  });
  await page.route("https://catalog.test/**", async (route: any) => {
    const type = new URL(route.request().url()).searchParams.get("type");
    await route.fulfill({
      json: {
        items:
          type === "sound"
            ? []
            : [
                {
                  id: "1",
                  slug: "managed",
                  type: "ui",
                  name: "Managed layout",
                  creator_name: "Fixture",
                  current_version: "1.0",
                  size_bytes: 12,
                  downloads: 10,
                  description: "Fixture catalog metadata",
                },
              ],
      },
    });
  });
  await page.goto(url);
  await page.waitForTimeout(500);
  await open();
  assert.equal(requests().length, 0, "Opening installed list performs no bulk disk inspections");
  assert.equal(await card("custom").getByRole("button", { name: "Delete from server" }).count(), 0);
  assert.equal(
    await inspect("Local Layout").isDisabled(),
    true,
    "Custom names are not guessed into marketplace slugs"
  );
  assert.equal(
    await inspect("my horn.ogg").isDisabled(),
    true,
    "Sound filenames without a declared slug remain visible but unclaimed"
  );
  const custom = await start("custom");
  assert.equal(custom.resource, "tDetector");
  assert.equal(custom.type, "ui");
  assert.equal(custom.slug, "custom");
  assert.equal(typeof custom.requestId, "string");
  assert.equal(
    await inspect("Managed layout").isDisabled(),
    true,
    "Only one inspection is outstanding"
  );
  for (const field of ["resource", "type", "slug", "requestId"]) {
    await reply({ ...custom, [field]: "foreign" });
    assert.equal(
      await card("custom").getByText("Checking installation", { exact: true }).count(),
      1,
      `${field} mismatch ignored`
    );
  }
  await reply(custom, "unverified", "absent", false);
  await card("custom").getByText("Unverified / custom", { exact: true }).waitFor();
  assert.equal(
    await card("custom")
      .getByText("Trusted built-in inventory is unavailable. Legacy adoption remains disabled.", {
        exact: true,
      })
      .count(),
    1
  );
  assert.equal(await card("custom").isVisible(), true, "Unverified local content is retained");
  assert.equal(
    await page.getByRole("button", { name: /adopt|replace|restore/i }).count(),
    0,
    "No new write authority is exposed"
  );
  await shot("inspection-unverified-desktop");
  await reply(custom, "managed");
  assert.equal(
    await card("custom").getByText("Unverified / custom", { exact: true }).count(),
    1,
    "Duplicate terminal result ignored"
  );
  const modified = await start("Managed layout");
  await reply(modified, "modified");
  await card("Managed layout").getByText("Managed · modified", { exact: true }).waitFor();
  assert.equal(
    await card("Managed layout").getByRole("button", { name: "Delete from server" }).isDisabled(),
    true
  );
  assert.equal(
    await card("Managed layout")
      .getByRole("button", { name: "Reinstall", exact: true })
      .isDisabled(),
    true
  );
  const locked = await start("Managed layout");
  await reply(locked, "managed", "identified");
  await card("Managed layout")
    .getByText(/operation lock is present/)
    .waitFor();
  assert.equal(
    await card("Managed layout").getByRole("button", { name: "Delete from server" }).isDisabled(),
    true
  );
  const managed = await start("Managed layout");
  await reply(managed);
  await card("Managed layout").getByText("Managed · unchanged", { exact: true }).waitFor();
  assert.equal(
    await card("Managed layout").getByRole("button", { name: "Delete from server" }).isDisabled(),
    false,
    "Verified managed snapshot preserves existing management controls"
  );
  const protectedItem = await start("default");
  await reply(protectedItem, "protected");
  await card("default").getByText("Protected built-in", { exact: true }).waitFor();
  assert.equal(
    await card("default").getByRole("button", { name: "Delete from server" }).count(),
    0
  );
  await page.setViewportSize({ width: 800, height: 450 });
  await card("default").scrollIntoViewIfNeeded();
  assert.equal(
    await page.locator(".mp-panel").evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth),
    false
  );
  await shot("inspection-protected-800x450");
  const stale = await start("custom");
  await send("closeMarketplace", {});
  await open();
  const fresh = await start("custom");
  assert.notEqual(fresh.requestId, stale.requestId);
  await reply(stale, "managed");
  assert.equal(
    await card("custom").getByText("Checking installation", { exact: true }).count(),
    1,
    "Same-resource reopen fences old response"
  );
  await send("marketplaceInspectResult", {
    ...fresh,
    ok: true,
    inspection: {
      resourceName: "wrong",
      type: "ui",
      slug: "custom",
      status: "managed",
      lock: "absent",
      policyAvailable: true,
    },
  });
  await card("custom").getByText("Inspection unavailable", { exact: true }).waitFor();
  const denied = await start("custom");
  await send("marketplaceInspectResult", {
    ...denied,
    ok: false,
    error: "C:/private/server/layouts/custom",
  });
  await card("custom").getByText("Inspection unavailable", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("C:/private/server/layouts/custom", { exact: false }).count(),
    0,
    "Untrusted error paths are not rendered"
  );
  const oldResource = await start("custom");
  await open("tRadio");
  const newResource = await start("custom");
  await reply(oldResource, "managed");
  assert.equal(
    await card("custom").getByText("Checking installation", { exact: true }).count(),
    1,
    "Resource replacement fences old response"
  );
  await reply(newResource, "unverified");
  await card("custom").getByText("Unverified / custom", { exact: true }).waitFor();
  const oldTab = await start("custom");
  await page.getByRole("button", { name: "UIs", exact: true }).click();
  await page.getByRole("button", { name: "Installed", exact: true }).click();
  await card("custom").waitFor();
  await reply(oldTab, "managed");
  assert.equal(
    await card("custom").locator(".mp-inspection").count(),
    0,
    "Tab replacement retires inspection"
  );
  failTransport = true;
  await inspect("custom").click();
  await card("custom").getByText("Inspection unavailable", { exact: true }).waitFor();
  failTransport = false;
  holdNextAck = true;
  const delayedAck = await start("custom");
  await send("closeMarketplace", {});
  await open();
  const currentAck = await start("custom");
  assert.notEqual(currentAck.requestId, delayedAck.requestId);
  await heldAck.fulfill({ json: null });
  await page.waitForTimeout(100);
  assert.equal(
    await card("custom").getByText("Checking installation", { exact: true }).count(),
    1,
    "Stale failed acknowledgement cannot fail a reopened inspection"
  );
  await reply(currentAck, "unverified");
  await card("custom").getByText("Unverified / custom", { exact: true }).waitFor();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  const acknowledged = page.waitForResponse((response) =>
    response.url().endsWith("/marketplaceInspect")
  );
  const timedOut = await start("custom");
  await (await acknowledged).finished();
  await page.evaluate(async () => {
    await Promise.resolve();
  });
  await page.clock.fastForward(14000);
  assert.equal(await card("custom").getByText("Checking installation", { exact: true }).count(), 1);
  await page.clock.fastForward(2000);
  await card("custom").getByText("Inspection unavailable", { exact: true }).waitFor();
  await reply(timedOut);
  assert.equal(
    await card("custom").getByText("Inspection unavailable", { exact: true }).count(),
    1,
    "Late timed-out result ignored"
  );
  assert.equal(
    calls.filter(
      (call) => call.event === "marketplaceInstall" || call.event === "marketplaceUninstall"
    ).length,
    0,
    "Inspection never issues a write request"
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: lazy read-only inspection, exact scope/session fencing, typed statuses/lock/policy, preserved custom items, management blockers, no write requests, failures/timeout, 800x450."
  );
} catch (error) {
  await shot("inspection-failure");
  throw error;
} finally {
  await browser.close();
}
