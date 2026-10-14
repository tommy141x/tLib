// Mocked NUI browser checks against a dev server or locally served built UI; no game restart.
// DIALOG_PREVIEW_URL=<local URL> or DIALOG_PREVIEW_DIR=<built UI directory>
// PLAYWRIGHT_MODULE=<module path> bun tests/browser/dialog.ts
import { strict as rawAssert } from "node:assert";

let assertionCount = 0;
const assert = new Proxy(rawAssert, {
  get(target, property) {
    const value = Reflect.get(target, property);
    return typeof value === "function"
      ? (...args: unknown[]) => {
          assertionCount++;
          return Reflect.apply(value, target, args);
        }
      : value;
  },
});

import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = process.env.DIALOG_PREVIEW_DIR;
const previewUrl = process.env.DIALOG_PREVIEW_URL;
if (!root && !previewUrl) throw new Error("Set DIALOG_PREVIEW_DIR or DIALOG_PREVIEW_URL");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const server = root
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const relative =
          decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "") || "index.html";
        const path = resolve(root, relative);
        if (!path.startsWith(resolve(root) + sep)) return new Response("", { status: 403 });
        return new Response(Bun.file(path));
      },
    })
  : undefined;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const visualMetrics: Record<string, unknown> = {};
const measure = async (name: string) => {
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector("[role=dialog]")!;
    const color = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (rgb: number[]) =>
      rgb
        .map((value) => value / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (fg: string, bg: string) => {
      const a = luminance(color(fg)),
        b = luminance(color(bg));
      return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
    };
    const measureElement = (selector: string) => {
      const element = dialog.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      let bg = style.backgroundColor;
      let parent = element.parentElement;
      while (bg === "rgba(0, 0, 0, 0)" && parent) {
        bg = getComputedStyle(parent).backgroundColor;
        parent = parent.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return {
        fontSize: parseFloat(style.fontSize),
        color: style.color,
        background: bg,
        contrast: contrast(style.color, bg),
        outline: style.outlineColor,
        border: style.borderColor,
        shadow: style.boxShadow,
        top: rect.top,
        bottom: rect.bottom,
        visible: rect.top >= 0 && rect.bottom <= innerHeight,
      };
    };
    return {
      viewport: [innerWidth, innerHeight],
      title: measureElement("[data-part=title]"),
      label: measureElement("[data-scope=field][data-part=label]"),
      input: measureElement("input:not([type=hidden])"),
      helper: measureElement("[data-part=helper-text]"),
      nav: measureElement("[role=tab]"),
      error: measureElement("[data-part=error-text]"),
      primary: measureElement("button[type=submit]"),
      cancel: measureElement("footer button[type=button]"),
    };
  });
  visualMetrics[name] = metrics;
  for (const part of ["label", "input", "nav", "primary", "cancel"] as const) {
    if (metrics[part])
      assert.ok(metrics[part].fontSize >= 14, `${name}: ${part} has regular 14px minimum`);
  }
  if (metrics.helper) assert.ok(metrics.helper.fontSize >= 12, `${name}: helper has 12px minimum`);
  for (const part of [
    "title",
    "label",
    "input",
    "helper",
    "nav",
    "error",
    "primary",
    "cancel",
  ] as const) {
    if (metrics[part])
      assert.ok(
        metrics[part].contrast >= 4.5,
        `${name}: ${part} contrast ${metrics[part].contrast}`
      );
  }
  assert.ok(
    metrics.primary?.visible && metrics.cancel?.visible,
    `${name}: submit and cancel stay onscreen`
  );
  return metrics;
};
const screenshot = async (name: string) => {
  const directory = process.env.DIALOG_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
};
const errors: string[] = [];
const calls: { event: string; data: any }[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
await page.addInitScript(() => {
  (window as any).GetParentResourceName = () => "tLib";
});
await page.route("https://tlib/**", async (route: any) => {
  calls.push({
    event: new URL(route.request().url()).pathname.slice(1),
    data: route.request().postDataJSON(),
  });
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
const send = (name: string, data: any) =>
  page.evaluate(({ name, data }: any) => window.postMessage({ name, args: [data] }, "*"), {
    name,
    data,
  });
const pause = () => page.waitForTimeout(120);
const shown = (instance: number, fields?: any[]) =>
  send("showDialog", {
    id: "test-dialog",
    instance,
    title: "Vehicle settings",
    description: "Live preview stays in the game.",
    size: "lg",
    submitLabel: "Save settings",
    fields: fields ?? [
      { id: "name", type: "text", label: "Name", required: true, description: "Choose a name." },
      { id: "amount", type: "number", label: "Amount", min: 1, max: 10 },
      { id: "enabled", type: "checkbox", label: "Enabled", defaultValue: false, required: true },
      {
        id: "choice",
        type: "dropdown",
        label: "Choice",
        defaultValue: "a",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      },
    ],
  });
try {
  await page.goto(previewUrl ?? `http://127.0.0.1:${server!.port}`);
  await page.waitForTimeout(300);
  await shown(1);
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByText("Live preview stays in the game.").count(), 1);
  await pause();
  const desktop = await measure("desktop-form");
  // rgb(48, 137, 232) is #3089e8 == hsl(211 80% 55%), i.e. --primary in
  // theme-tokens.css and --ring in `shared/ts/ui/*`. These two lines used to pin
  // the neutral #eeeeee, which is the 2026-09-22 repaint recorded in
  // `shared/ts/admin-ui/index.tsx`; it was reverted because the other five
  // bundles never followed it and a tLib dialog opened over a tELS editor
  // repainted the primary button. Pinned as a literal on purpose: a token read
  // would agree with whatever the sheet says.
  assert.equal(
    desktop.primary?.background,
    "rgb(48, 137, 232)",
    "stock primary is the shared blue"
  );
  assert.equal(desktop.input?.border, "rgb(48, 137, 232)", "stock focus border is the shared blue");
  // This asserted `shadow !== "none"` — "focused input has a visible soft
  // ring" — and had been failing since a9695a2 ("one focus mechanism, and it is
  // an outline") without anyone noticing, because this harness is not in
  // `verify`. The affordance is deliberately an `outline`: an outward
  // `box-shadow` is clipped to nothing inside an `overflow: hidden` ancestor,
  // which is the geometry `probe:focus` exists to measure. So the shadow being
  // absent is now the thing asserted, and the outline being the accent at 40%
  // beside it. `probe:focus` is what proves it paints pixels; this proves the
  // declaration is the one that ships.
  assert.equal(desktop.input?.shadow, "none", "focus is an outline, never an elevation");
  assert.equal(
    desktop.input?.outline,
    "rgba(48, 137, 232, 0.4)",
    "the focus outline is the shared accent at 40%"
  );
  await screenshot("dialog-form-1600x900");
  await page.setViewportSize({ width: 800, height: 450 });
  await pause();
  await measure("small-form");
  await screenshot("dialog-form-800x450");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: "Save settings" }).click();
  await pause();
  assert.equal(
    calls.filter((c) => c.event === "dialogSubmit").length,
    0,
    "required blocks actual submit"
  );
  assert.equal(await page.getByText("Name is required.").count(), 1);
  await measure("desktop-validation");
  await screenshot("dialog-required-error-1600x900");
  await page.getByLabel("Name", { exact: false }).fill("Edited");
  // Boolean is a real checkbox, with keyboard operation and false still valid.
  const checkbox = page.getByRole("checkbox", { name: "Enabled" });
  assert.equal(await checkbox.count(), 1);
  assert.equal(await page.getByRole("switch").count(), 0);
  assert.equal(await checkbox.getAttribute("type"), "checkbox");
  assert.equal(await checkbox.getAttribute("required"), null);
  await checkbox.focus();
  await page.keyboard.press("Space");
  assert.equal(await checkbox.isChecked(), true);
  await page.keyboard.press("Space");
  assert.equal(await checkbox.isChecked(), false);

  // Identity preservation: unrelated single-field and full-schema patches must
  // not replace the focused input, selection, or an open Ark dropdown machine.
  const nameInput = page.getByLabel("Name", { exact: false });
  await nameInput.focus();
  await nameInput.evaluate((el: HTMLInputElement) => {
    (window as any).__retainedName = el;
    el.setSelectionRange(1, 4);
  });
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "amount",
    label: "Amount revised",
  });
  await pause();
  assert.deepEqual(
    await nameInput.evaluate((el: HTMLInputElement) => [
      el === (window as any).__retainedName,
      document.activeElement === el,
      el.selectionStart,
      el.selectionEnd,
    ]),
    [true, true, 1, 4]
  );
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "amount",
    label: "Amount",
  });
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Beta" }).waitFor();
  await page.getByRole("combobox").evaluate((el: Element) => {
    (window as any).__retainedSelect = el;
  });
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "amount",
    disabled: true,
  });
  await pause();
  assert.equal(
    await page
      .getByRole("combobox")
      .evaluate((el: Element) => el === (window as any).__retainedSelect),
    true
  );
  assert.equal(
    await page.getByRole("option", { name: "Beta" }).isVisible(),
    true,
    "unrelated patch keeps dropdown open"
  );
  await page.keyboard.press("Escape");
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "amount",
    disabled: false,
  });
  await page.getByLabel("Amount", { exact: true }).fill("3");
  await page.getByLabel("Amount", { exact: true }).fill("");
  await pause();
  assert.ok(
    calls.some(
      (c) => c.event === "dialogChange" && c.data.fieldId === "amount" && c.data.value === ""
    ),
    "empty number stays empty string"
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await pause();
  const submit = calls.find((c) => c.event === "dialogSubmit");
  assert.deepEqual(submit?.data, {
    id: "test-dialog",
    instance: 1,
    values: { name: "Edited", amount: "", enabled: false, choice: "a" },
  });
  assert.equal(
    await page.getByRole("dialog").count(),
    1,
    "HTTP acknowledgement must not close dialog"
  );

  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "name",
    label: "Renamed",
    defaultValue: "Patched",
    disabled: true,
  });
  await pause();
  assert.equal(await page.getByLabel("Renamed", { exact: false }).inputValue(), "Patched");
  assert.equal(await page.getByLabel("Renamed", { exact: false }).isDisabled(), true);
  await send("updateDialogFields", {
    dialogId: "test-dialog",
    instance: 1,
    fields: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "new.field", type: "number", label: "New number", defaultValue: "2" },
      {
        id: "choice",
        type: "dropdown",
        label: "Choice",
        defaultValue: "a",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      },
    ],
  });
  await pause();
  assert.equal(await page.getByLabel("Name", { exact: false }).inputValue(), "Patched");
  assert.equal(await page.getByLabel("New number").inputValue(), "2");
  assert.equal(
    await page
      .getByLabel("Name", { exact: false })
      .evaluate((el: Element) => el === (window as any).__retainedName),
    true,
    "full schema replacement retains unchanged field DOM"
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await pause();
  assert.deepEqual(calls.filter((c) => c.event === "dialogSubmit").at(-1)?.data.values, {
    name: "Patched",
    "new.field": "2",
    choice: "a",
  });

  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Beta" }).waitFor();
  await send("updateDialogFields", {
    dialogId: "test-dialog",
    instance: 1,
    fields: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "new.field", type: "number", label: "New number", defaultValue: "2" },
      {
        id: "choice",
        type: "dropdown",
        label: "Choice",
        defaultValue: "a",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      },
    ],
  });
  await pause();
  assert.equal(
    await page.getByRole("option", { name: "Beta" }).isVisible(),
    true,
    "full schema patch preserves open dropdown"
  );
  assert.equal(
    await page
      .getByRole("combobox")
      .evaluate((el: Element) => el === (window as any).__retainedSelect),
    true
  );
  await screenshot("dialog-dropdown");
  const cancelsBefore = calls.filter((c) => c.event === "dialogCancel").length;
  await page.keyboard.press("Escape");
  await pause();
  assert.equal(await page.getByRole("dialog").count(), 1, "nested Escape leaves dialog open");
  assert.equal(calls.filter((c) => c.event === "dialogCancel").length, cancelsBefore);

  await shown(2);
  await pause();
  await send("closeDialog", { id: "test-dialog", instance: 1 });
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 1,
    fieldId: "name",
    defaultValue: "Stale",
  });
  await pause();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(
    await page.getByLabel("Name", { exact: false }).inputValue(),
    "",
    "replacement resets state and rejects stale patches"
  );
  await page.keyboard.press("Escape");
  await pause();
  assert.equal(calls.filter((c) => c.event === "dialogCancel").at(-1)?.data.instance, 2);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await shown(3);
  await pause();
  await send("closeDialog", { id: "test-dialog", instance: 3 });
  await pause();
  assert.equal(await page.getByRole("dialog").count(), 0, "matching Lua close is authoritative");
  await send("showDialog", {
    id: "tabs",
    instance: 4,
    title: "Tabbed settings",
    size: "xl",
    tabs: [
      { id: "general", label: "General" },
      { id: "refresh", label: "Refresh", action: true },
      { id: "advanced", label: "Advanced" },
    ],
    fields: [
      { id: "toggle", type: "checkbox", label: "Toggle", tab: "general" },
      { id: "secret", type: "text", label: "Advanced name", required: true, tab: "advanced" },
      {
        id: "level",
        type: "slider",
        label: "Level",
        min: 0,
        max: 10,
        defaultValue: 2,
        tab: "advanced",
      },
    ],
  });
  await pause();
  await page.getByRole("button", { name: "Refresh" }).click();
  await pause();
  assert.equal(
    calls.filter((c) => c.event === "dialogButtonClick").at(-1)?.data.fieldId,
    "refresh"
  );
  assert.equal(
    await page.getByRole("tab", { name: "General" }).getAttribute("aria-selected"),
    "true",
    "action does not switch tabs"
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await pause();
  assert.equal(
    await page.getByRole("tab", { name: "Advanced", exact: true }).getAttribute("aria-selected"),
    "true",
    "invalid hidden field selects its tab"
  );
  const tabAppearance = async (name: string) =>
    page.getByRole("tab", { name, exact: true }).evaluate((el: Element) => {
      const style = getComputedStyle(el);
      return {
        selected: el.hasAttribute("data-selected"),
        background: style.backgroundColor,
        color: style.color,
      };
    });
  const activeTabStyle = await tabAppearance("Advanced");
  const inactiveTabStyle = await tabAppearance("General");
  assert.equal(activeTabStyle.selected, true, "installed Ark marks active tab with data-selected");
  assert.equal(inactiveTabStyle.selected, false, "inactive tab has no data-selected");
  assert.equal(
    activeTabStyle.background,
    "rgb(38, 38, 38)",
    "active tab has neutral raised background"
  );
  assert.equal(activeTabStyle.color, "rgb(238, 238, 238)", "active tab has bright text");
  assert.notEqual(
    activeTabStyle.background,
    inactiveTabStyle.background,
    "active/inactive backgrounds differ"
  );
  assert.notEqual(
    activeTabStyle.color,
    inactiveTabStyle.color,
    "active/inactive text colors differ"
  );
  visualMetrics.tabSelection = { active: activeTabStyle, inactive: inactiveTabStyle };
  await measure("desktop-tabbed");
  await screenshot("dialog-tabbed-validation-1600x900");
  await page.setViewportSize({ width: 800, height: 450 });
  await pause();
  await measure("small-tabbed");
  await screenshot("dialog-tabbed-validation-800x450");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByLabel("Advanced name", { exact: false }).fill("Configured");
  await page.getByRole("slider").focus();
  await page.keyboard.press("ArrowRight");
  await pause();
  assert.equal(
    calls.filter((c) => c.event === "dialogChange" && c.data.fieldId === "level").at(-1)?.data
      .value,
    3,
    "slider emits number"
  );
  // A DRAG commits ONCE, at its end
  //
  // zag fires `onValueChange` on every pointer move, so wiring `dialogChange`
  // to it meant one NUI call per step of a drag — and tRadar's cl_settings.lua
  // answers each one with an `UpdateDialogField` push back, so a drag was a full
  // round trip per pixel in every resource using a tLib dialog. The commit is on
  // `onValueChangeEnd` now, with `onValueChange` kept for the local value.
  //
  // Both halves are asserted. The count alone would also pass if the thumb never
  // moved at all, and the position alone would also pass if every step committed.
  let draggedLevel = 3;
  {
    const level = () =>
      calls.filter((c) => c.event === "dialogChange" && c.data.fieldId === "level");
    const before = level().length;
    const slider = page.getByRole("slider");
    const box = await slider.boundingBox();
    assert.ok(box, "the slider thumb has a box to drag");
    // `[data-slider-track]`, not zag 1's `[data-scope="slider"][data-part="track"]`:
    // zag 2's createAnatomy emits one combined `data-<component>-<part>` attribute.
    // Read from the installed `@zag-js/slider` (anatomy.build().track.attr) rather
    // than hand-converted. This file is not in `bun run test` -- it needs a browser --
    // so a stale selector here survives a fully green gate run, which is how this one
    // did; the assertion below would have failed only when someone next ran the
    // browser suite.
    const track = await page.locator("[data-slider-track]").boundingBox();
    assert.ok(track, "the slider track has a box to drag along");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const start = Number(await slider.getAttribute("aria-valuenow"));
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        box.x + box.width / 2 + (track.width / 10) * step,
        box.y + box.height / 2
      );
    }
    const mid = Number(await slider.getAttribute("aria-valuenow"));
    assert.ok(mid > start, "the thumb tracks the pointer mid-drag without committing");
    assert.equal(level().length, before, "no dialogChange is sent during the drag");
    await page.mouse.up();
    await pause();
    assert.equal(level().length, before + 1, "a slider drag sends exactly one dialogChange");
    assert.equal(level().at(-1)?.data.value, mid, "and it carries the value the drag landed on");
    draggedLevel = mid;
  }
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await pause();
  assert.deepEqual(calls.filter((c) => c.event === "dialogSubmit").at(-1)?.data.values, {
    toggle: false,
    secret: "Configured",
    // Whatever the drag above landed on, which is the value the dialog now holds.
    level: draggedLevel,
  });
  await send("addTheme", {
    id: "explicit-primary",
    cssVars: { primary: "211 80% 55%", "primary-foreground": "0 0% 100%" },
  });
  await send("showDialog", {
    id: "theme",
    instance: 5,
    title: "Explicit theme",
    size: "md",
    theme: "explicit-primary",
    fields: [],
  });
  await pause();
  const themed = await page
    .getByRole("button", { name: "Submit", exact: true })
    .evaluate((el: Element) => getComputedStyle(el).backgroundColor);
  assert.notEqual(themed, "rgb(238, 238, 238)", "explicit primary theme overrides neutral default");
  await send("removeTheme", { id: "explicit-primary" });
  await page.waitForTimeout(250); // allow the control's 150ms color transition to settle
  assert.equal(
    await page
      .getByRole("button", { name: "Submit", exact: true })
      .evaluate((el: Element) => getComputedStyle(el).backgroundColor),
    "rgb(238, 238, 238)",
    "theme removal returns to neutral"
  );
  await send("addTheme", {
    id: "global-primary",
    cssVars: { primary: "211 80% 55%", "primary-foreground": "0 0% 100%" },
  });
  await send("setTheme", { id: "global-primary" });
  await page.waitForTimeout(250);
  assert.notEqual(
    await page
      .getByRole("button", { name: "Submit", exact: true })
      .evaluate((el: Element) => getComputedStyle(el).backgroundColor),
    "rgb(238, 238, 238)",
    "dynamic global explicit primary is preserved"
  );
  await send("setTheme", { id: "" });
  await page.waitForTimeout(250);
  assert.equal(
    await page
      .getByRole("button", { name: "Submit", exact: true })
      .evaluate((el: Element) => getComputedStyle(el).backgroundColor),
    "rgb(238, 238, 238)",
    "clearing global theme returns to neutral"
  );
  // Presence does not retain ownership: after the authoritative close, the
  // painted exit frame is inert and cannot trap keyboard or emit stale changes.
  await shown(6);
  await pause();
  assert.equal(
    await page.getByRole("dialog").evaluate((el: Element) => getComputedStyle(el).animationName),
    "tlib-nui-rise"
  );
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Beta" }).waitFor();
  const callsBeforeClose = calls.length;
  const exitState = await page.evaluate(async () => {
    const probe = document.createElement("button");
    probe.id = "focus-after-dialog";
    probe.textContent = "Outside focus probe";
    document.body.append(probe);
    window.postMessage({ name: "closeDialog", args: [{ id: "test-dialog", instance: 6 }] }, "*");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const panel = document.querySelector<HTMLElement>(".tlib-nui-dialog");
    probe.focus();
    return {
      inert: !panel || panel.inert,
      pointer: !panel || getComputedStyle(panel).pointerEvents === "none",
      focus: document.activeElement === probe,
      options: document.querySelectorAll("[data-part=content][data-scope=select]").length,
    };
  });
  assert.deepEqual(exitState, { inert: true, pointer: true, focus: true, options: 0 });
  await send("updateDialogField", {
    dialogId: "test-dialog",
    instance: 6,
    fieldId: "name",
    defaultValue: "Closed patch",
  });
  assert.equal(
    calls.length,
    callsBeforeClose,
    "backend close does not echo cancel or emit changes"
  );
  // Interrupt the old exit with a new session. Old exit callbacks and messages
  // must never remove or edit the replacement.
  await shown(7);
  await send("closeDialog", { id: "test-dialog", instance: 6 });
  await page.waitForTimeout(250);
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(await page.getByLabel("Name", { exact: false }).inputValue(), "");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(180);
  await page.locator("#focus-after-dialog").focus();
  await pause();
  assert.equal(
    await page
      .locator("#focus-after-dialog")
      .evaluate((el: Element) => document.activeElement === el),
    true,
    "no ghost focus trap after exit"
  );
  await page.locator("#focus-after-dialog").evaluate((el: Element) => el.remove());

  // A button renders no label, so in a row beside a labelled field it used to
  // sit a whole label-height above its neighbour's control — the reset button
  // next to tRadio's microphone dropdown. The row is the only place this shows,
  // and only a real layout pass can prove it.
  await shown(9, [
    {
      id: "microphone",
      type: "dropdown",
      label: "Microphone",
      row: "mic",
      defaultValue: "a",
      options: [{ value: "a", label: "Default" }],
    },
    { id: "refreshMic", type: "button", label: "↻", row: "mic", flex: "shrink" },
    { id: "solo", type: "button", label: "Standalone button" },
  ]);
  await page.getByRole("dialog").waitFor();
  await pause();
  const rowTops = await page.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
    return {
      dropdown: top("[data-scope=select][data-part=trigger]"),
      // PRESENCE, not `=true`/`=false`. Dialog.tsx binds `data-labelless` to a
      // plain boolean, and Solid 2's setAttribute writes `true` as the EMPTY
      // string and REMOVES the attribute on `false`. So `[data-labelless=true]`
      // matches nothing and `[data-labelless=false]` never exists — both
      // `querySelector(...)!` calls would deref null and this assertion would
      // crash rather than measure. Presence/absence is the exact test: there is
      // no third state. Same reasoning as the CSS in shared/ts/nui-kit/nui.css.
      reset: top(".tlib-nui-field-cell[data-labelless] .tlib-nui-button"),
      standalone: top(".tlib-nui-field-cell:not([data-labelless]) .tlib-nui-button"),
      standaloneRow: document.querySelectorAll(".tlib-nui-field-row")[1]!.getBoundingClientRect()
        .top,
    };
  });
  assert.equal(
    Math.round(rowTops.reset - rowTops.dropdown),
    0,
    "a labelless field lines up with the control beside it"
  );
  assert.equal(
    Math.round(rowTops.standalone - rowTops.standaloneRow),
    0,
    "a button alone in its row keeps no phantom label space"
  );
  await send("closeDialog", { id: "test-dialog", instance: 9 });
  await page.waitForTimeout(250);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await shown(8);
  await pause();
  assert.equal(
    await page.getByRole("dialog").evaluate((el: Element) => getComputedStyle(el).animationName),
    "none",
    "reduced motion disables dialog animation"
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save settings" })
      .evaluate((el: Element) => getComputedStyle(el).transitionDuration),
    "0s"
  );
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Beta" }).waitFor();
  assert.equal(
    await page.getByRole("listbox").evaluate((el: Element) => getComputedStyle(el).animationName),
    "none",
    "reduced motion applies inside portal"
  );
  await send("closeDialog", { id: "test-dialog", instance: 8 });
  await pause();
  assert.equal(
    await page.locator(".tlib-nui-dialog").count(),
    0,
    "reduced-motion close unmounts without animation event"
  );
  assert.equal(await page.locator("[data-scope=select][data-part=content]").count(), 0);
  if (process.env.DIALOG_SCREENSHOT_DIR)
    await Bun.write(
      resolve(process.env.DIALOG_SCREENSHOT_DIR, "dialog-visual-metrics.json"),
      JSON.stringify(visualMetrics, null, 2)
    );
  console.log(JSON.stringify(visualMetrics, null, 2));
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(
    `PASS: ${assertionCount} browser assertions; dialog lifecycle, wire contracts, neutral styling, explicit themes, typography/contrast and two viewport sizes`
  );
} catch (error) {
  console.error("Browser errors:", errors);
  console.error(
    await page.locator("[data-scope=select]").evaluateAll((els: Element[]) =>
      els.map((el) => ({
        part: el.getAttribute("data-part"),
        hidden: el.getAttribute("hidden"),
        ariaHidden: el.getAttribute("aria-hidden"),
        style: el.getAttribute("style"),
        computed: {
          z: getComputedStyle(el).zIndex,
          display: getComputedStyle(el).display,
          height: getComputedStyle(el).height,
        },
        rect: el.getBoundingClientRect().toJSON(),
      }))
    )
  );
  console.error(
    await page.locator("[data-scope=select][data-part=content]").evaluateAll((els: Element[]) =>
      els.map((el) => {
        const chain = [];
        for (let node = el; node; node = node.parentElement!)
          chain.push(node.outerHTML.slice(0, 250));
        return chain;
      })
    )
  );
  await screenshot("dialog-failure");
  throw error;
} finally {
  await browser.close();
  server?.stop(true);
}
