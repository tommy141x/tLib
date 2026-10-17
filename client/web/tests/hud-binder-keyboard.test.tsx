/**
 * A faceplate key must be operable by the keyboard, because it already claims to be.
 *
 *  WHAT WAS WRONG 
 *
 * `HudBinder.scan()` attached one `click` listener per `[data-hud-btn]` and
 * nothing else, while all 65 shipped keys across tRadar's five heads and
 * tDetector's three declare `role="button" tabindex="0"`. So every one of them
 * was reachable by Tab — put there deliberately, so it could be operated — and
 * pressing Enter on it did nothing at all. Nothing threw and nothing logged.
 *
 * A `<div role="button">` inherits none of a real `<button>`'s key handling.
 * The faceplates cannot be real buttons: they are absolutely-positioned
 * transparent rects laid over a chassis render, sized to the silkscreen.
 *
 *  WHY THIS LIVES IN THE DOM SUITE 
 *
 * `tests/unit/hud-drag.test.ts` hand-rolls a `FakeElement` harness, and says so:
 * it is a harness, not a claim about a real selector engine or a real event
 * model. Key handling IS the event model — `e.repeat`, `preventDefault` on
 * Space, and the dispatch from `keydown` through `click` to the click listener
 * are all things a fake would simply agree with. These run against happy-dom,
 * which has the real ones.
 *
 * THE TESTS ASSERT `onAction` FIRED, NOT THAT A LISTENER IS ATTACHED. A test
 * that counted `addEventListener` calls would pass against a handler that
 * matched the wrong key, swallowed its own event, or looped.
 */

import { describe, expect, test } from "bun:test";
import { HudBinder } from "../../../shared/ts/hud-template";

/** One faceplate key, in the markup the shipped layouts actually use. */
function mount(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  const fired: string[] = [];
  const binder = new HudBinder(root, { onAction: (a: string) => fired.push(a) });
  binder.scan();
  return { root, fired, binder, key: root.querySelector("[data-hud-btn]") as HTMLElement };
}

const KEY = `<div class="key" data-hud-btn="power:toggle" role="button" tabindex="0"></div>`;

function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

describe("HudBinder keyboard activation", () => {
  test("Enter on a key fires its action", () => {
    const { fired, key } = mount(KEY);
    press(key, "Enter");
    expect(fired).toEqual(["power:toggle"]);
  });

  test("Space on a key fires its action, and does not scroll the page", () => {
    const { fired, key } = mount(KEY);
    const event = press(key, " ");
    expect(fired).toEqual(["power:toggle"]);
    // Space's default action scrolls. Enter's does not need preventing here:
    // an NUI overlay has no form to submit and no anchor to follow.
    expect(event.defaultPrevented).toBe(true);
  });

  test("a held key fires once, not once per repeat", () => {
    // Without the `e.repeat` guard, holding Enter on the KBX-2200's PWR key
    // would toggle the radar at the OS key-repeat rate.
    const { fired, key } = mount(KEY);
    press(key, "Enter");
    press(key, "Enter", { repeat: true });
    press(key, "Enter", { repeat: true });
    expect(fired).toEqual(["power:toggle"]);
  });

  test("other keys are left alone", () => {
    // Tab in particular: swallowing it would trap focus on the faceplate.
    const { fired, key } = mount(KEY);
    for (const k of ["Tab", "a", "Escape", "ArrowDown"]) press(key, k);
    expect(fired).toEqual([]);
  });

  test("a pointer press and a key press are one code path", () => {
    // The handler calls `btn.click()` rather than `onAction` directly, so a
    // layout or host that intercepts `click` sees both the same way, and the
    // two can never drift into doing different things.
    const { fired, key } = mount(KEY);
    key.click();
    press(key, "Enter");
    expect(fired).toEqual(["power:toggle", "power:toggle"]);
  });

  test("an element with an empty data-hud-btn is skipped, as it is for click", () => {
    const { fired, root } = mount(`<div data-hud-btn="" role="button" tabindex="0"></div>`);
    const el = root.querySelector("[data-hud-btn]") as HTMLElement;
    press(el, "Enter");
    el.click();
    expect(fired).toEqual([]);
  });

  test("rescanning does not double-fire", () => {
    // `scan()` aborts the previous controller first. If it ever stops doing so,
    // one Enter would fire the action twice — the same fault the click listener
    // already carries a comment about.
    const { fired, key, binder } = mount(KEY);
    binder.scan();
    press(key, "Enter");
    expect(fired).toEqual(["power:toggle"]);
  });
});
