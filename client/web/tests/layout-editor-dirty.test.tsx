/**
 * `LayoutEditor`: what counts as an edit, and what the discard question is
 * allowed to do while it is up.
 *
 * Why this file exists
 *
 * A Solid 2 store write is NOT readable in the tick it happened, and this
 * editor's undo `capture()` read the store proxy. Every one-shot edit goes
 * through `UndoHistory.with()`, which captures, mutates and captures AGAIN
 * inside one call — so the second capture returned the pre-write value, the
 * batch compared equal to itself, and the entry was discarded with nothing
 * logged anywhere.
 *
 * That is not merely a missing undo. `canUndo()` IS this editor's dirty flag, so
 * hiding six components and pressing Cancel threw the session away WITHOUT
 * ASKING — the one thing the discard question exists to prevent. A drag quick
 * enough that its only frame was flushed by its own `pointerup` went the same
 * way, and `settleKey` then re-anchored the pre-drag placement back over it.
 *
 * Every test here is driven through the editor's own surface — a click on the
 * eye, a real pointer sequence, a keypress — because a suite that drives
 * `UndoHistory` directly never sees any of this. See `layout-editor-discard.
 * test.tsx` for the answer ORDER of the same question.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import type { Component } from "@tlib/shared/hud-geometry";
import { flush } from "solid-js";
import LayoutEditor from "../src/layout/LayoutEditor";

let sent: Array<{ event: string; data: { layout?: unknown; key?: string } }> = [];
let realFetch: typeof fetch;

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  (window as unknown as { GetParentResourceName: () => string }).GetParentResourceName = () =>
    "tlib-test";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    sent.push({
      event: href.replace("https://tlib-test/", ""),
      data: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete (window as unknown as { GetParentResourceName?: unknown }).GetParentResourceName;
  document.body.innerHTML = "";
});

const LAYOUT = { x: 0, y: 0, scale: 1, visible: true, anchor: "center" } as const;
const COMPONENT: Component = {
  key: "tels:speed",
  owner: "tels",
  id: "speed",
  label: "Speedometer",
  width: 200,
  height: 80,
  defaults: { ...LAYOUT },
  layout: { ...LAYOUT },
  minScale: 0.5,
  maxScale: 2,
  canHide: true,
  canScale: true,
};

let session = 500;
async function openEditor() {
  const { container } = render(() => <LayoutEditor />);
  await settle();
  return { container: container as HTMLElement, session: await open() };
}
async function open() {
  const id = ++session;
  // `safezone: 1` keeps the snap lines off the middle of the screen, so a drag
  // of a few pixels is not quietly turned into a snap in these assertions.
  window.postMessage(
    { action: "layoutOpen", data: { session: id, components: [COMPONENT], safezone: 1 } },
    "*"
  );
  await settle();
  return id;
}
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
const prompt = (c: HTMLElement) => q(c, '[role="alertdialog"]');
const undoButton = (c: HTMLElement) => q(c, ".tlib-layout__history button") as HTMLButtonElement;
const transform = (c: HTMLElement) => q(c, ".tlib-layout__proxy")!.style.transform;
const previews = () => sent.filter((s) => s.event === "layoutPreview");

function key(c: HTMLElement, init: KeyboardEventInit) {
  q(c, ".tlib-layout")!.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  );
  flush();
}
const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });

test("hiding a component is an edit, so Cancel asks before throwing it away", async () => {
  const { container } = await openEditor();
  q(container, ".tlib-layout__tag button")!.click();
  await settle();
  // The write itself was never the broken half — the proxy does go hidden.
  expect(q(container, ".tlib-layout__proxy")!.className).toContain("--hidden");
  // What was broken: nothing was recorded, so the session looked untouched.
  expect(undoButton(container).disabled).toBe(false);
  expect(undoButton(container).title).toBe("Undo hide Speedometer · Ctrl Z");
  q(container, ".tlib-layout__discard")!.click();
  await settle();
  expect(prompt(container)).not.toBeNull();
});

test("Reset this is undoable, which is what its own tooltip promises", async () => {
  const { container } = await openEditor();
  key(container, { key: "ArrowRight" });
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
  await settle();
  const moved = transform(container);
  q(container, ".tlib-layout__reset")!.click();
  await settle();
  expect(undoButton(container).title).toBe("Undo reset Speedometer · Ctrl Z");
  expect(transform(container)).not.toBe(moved);
  undoButton(container).click();
  await settle();
  expect(transform(container)).toBe(moved);
});

test("a drag flushed by its own pointerup is kept, and is recorded as one entry", async () => {
  // Press, move and release inside ONE tick: no frame ever ran, so the release
  // flushes the gesture's only frame and then settles it immediately after.
  const { container } = await openEditor();
  const before = transform(container);
  const proxy = q(container, ".tlib-layout__proxy")!;
  proxy.dispatchEvent(pointer("pointerdown", 500, 400));
  window.dispatchEvent(pointer("pointermove", 560, 430));
  window.dispatchEvent(pointer("pointerup", 560, 430));
  await settle();
  const after = transform(container);
  expect(after).not.toBe(before);
  expect(undoButton(container).title).toBe("Undo move Speedometer · Ctrl Z");
  undoButton(container).click();
  await settle();
  expect(transform(container)).toBe(before);
});

test("the discard question is modal: a proxy drag behind it does nothing", async () => {
  const { container } = await openEditor();
  key(container, { key: "ArrowRight" });
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
  await settle();
  q(container, ".tlib-layout__discard")!.click();
  await settle();
  expect(prompt(container)).not.toBeNull();
  const held = transform(container);
  sent = [];
  // The shade is opaque but it only covers the PANEL; every outline, its eye
  // button, the wheel and the arrow keys sat outside it.
  const proxy = q(container, ".tlib-layout__proxy")!;
  proxy.dispatchEvent(pointer("pointerdown", 500, 400));
  window.dispatchEvent(pointer("pointermove", 700, 600));
  window.dispatchEvent(pointer("pointerup", 700, 600));
  proxy.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
  key(container, { key: "ArrowRight", shiftKey: true });
  q(container, ".tlib-layout__tag button")!.click();
  await settle();
  expect(transform(container)).toBe(held);
  expect(q(container, ".tlib-layout__proxy")!.className).not.toContain("--hidden");
  expect(previews()).toEqual([]);
  // …and the question is still the only thing being asked.
  expect(prompt(container)).not.toBeNull();
});

test("a session that ends with the question up does not reopen into it", async () => {
  const { container, session: first } = await openEditor();
  key(container, { key: "ArrowRight" });
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
  await settle();
  q(container, ".tlib-layout__discard")!.click();
  await settle();
  expect(prompt(container)).not.toBeNull();
  // The watchdog closes the editor for its own reasons — focus loss, a dialog,
  // a renderer that stopped answering — and does not care what is on screen.
  window.postMessage({ action: "layoutClose", data: { session: first } }, "*");
  await settle();
  expect(container.textContent).toBe("");
  await open();
  expect(container.textContent).toContain("Speedometer");
  expect(prompt(container)).toBeNull();
});

test("a resize interrupted by losing focus leaves no percentage pinned to the widget", async () => {
  const { container } = await openEditor();
  const handle = q(container, ".tlib-layout__handle--se");
  expect(handle).not.toBeNull();
  handle!.dispatchEvent(pointer("pointerdown", 600, 450));
  window.dispatchEvent(pointer("pointermove", 640, 470));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await settle();
  expect(q(container, ".tlib-layout__scale-badge")).not.toBeNull();
  // The badge said "only while it is actually changing", but it was cleared at
  // the pointer handlers — and `blur` ends the gesture without going near them.
  window.dispatchEvent(new Event("blur"));
  await settle();
  expect(q(container, ".tlib-layout__scale-badge")).toBeNull();
});

test("a resize that moves nothing posts no preview", async () => {
  const { container } = await openEditor();
  sent = [];
  // Still a legal placement at the new size, so every component stays where it
  // is — and a placement that did not change is nothing to tell the game about.
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  try {
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(previews()).toEqual([]);
    expect(transform(container)).toContain("translate3d");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  }
});
