/**
 * `createUndoScope` on the REAL page-wide registry, driven by real key events.
 *
 * `tests/unit/undo.test.ts` already covers `UndoKeyRegistry` thoroughly, with an
 * injected target and hand-built event literals, and it carries a negative
 * control for the depth rule. What it cannot reach is the half that only exists
 * in a DOM:
 *
 *  - `createUndoScope` / `undoKeys()` go to `globalThis`, and the registry
 *    attaches and detaches a listener on it. A scope registered from inside a
 *    component's `onSettled` and disposed from its returned cleanup is the shape
 *    every real consumer uses, and nothing proved the cleanup arrives.
 *  - `isTyping` reads `tagName` and `isContentEditable` off a real event target.
 *    A literal `{ tagName: "INPUT" }` proves the branch; it does not prove that a
 *    keydown inside a focused input actually carries that target.
 *  - `preventDefault` on a real `KeyboardEvent` is what the browser reads.
 *
 * THE SINGLETON IS SHARED ACROSS THIS WHOLE FILE AND EVERY OTHER FILE IN THE
 * PROCESS. That is the reason `tests/harness.test.tsx` asserts a mounted
 * component's scope count returns to its baseline after `cleanup()` — with the
 * duplicate solid-js copy that was measured first, it did not, and these tests
 * would have been resolving against scopes left behind by earlier files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@solidjs/testing-library";
import { UndoHistory } from "../../../shared/ts/undo";
import { createUndoScope, matchUndoKey, undoKeyDiagnostics } from "../../../shared/ts/undo-keys";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  cleanup();
  document.body.innerHTML = "";
});

function scope(options: Parameters<typeof createUndoScope>[0]) {
  const dispose = createUndoScope(options);
  disposers.push(dispose);
  return dispose;
}

function counter(label: string) {
  let value = 0;
  const history = new UndoHistory({ label });
  history.register<number>("n", {
    capture: () => value,
    restore: (snapshot) => {
      value = snapshot;
    },
  });
  return {
    history,
    get value() {
      return value;
    },
    edit(entry: string, to: number) {
      history.with(entry, ["n"], () => {
        value = to;
      });
    },
  };
}

/**
 * Press a key for real, from a real element, and report whether anything
 * claimed it.
 *
 * Dispatched from `target` with `bubbles: true` so the event travels the way a
 * browser's would — the registry's listener is on `window`, and a test that
 * dispatched straight onto `window` would never exercise the `target` the typing
 * guard reads.
 */
function press(
  key: string,
  init: KeyboardEventInit & { target?: Element } = {}
): { defaultPrevented: boolean } {
  const { target, ...rest } = init;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...rest });
  (target ?? document.body).dispatchEvent(event);
  return { defaultPrevented: event.defaultPrevented };
}

function input(type = "text"): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  document.body.append(el);
  return el;
}

describe("matchUndoKey", () => {
  test("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo, and Alt disqualifies", () => {
    const e = (over: Partial<KeyboardEvent>) =>
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, ...over });
    expect(matchUndoKey(e({}))).toBe("undo");
    expect(matchUndoKey(e({ shiftKey: true }))).toBe("redo");
    expect(matchUndoKey(e({ key: "y" }))).toBe("redo");
    expect(matchUndoKey(e({ altKey: true }))).toBeNull();
    expect(matchUndoKey(new KeyboardEvent("keydown", { key: "z" }))).toBeNull();
  });
});

describe("createUndoScope, on the real window", () => {
  test("a real Ctrl+Z travels and is preventDefaulted", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor" });
    const { defaultPrevented } = press("z", { ctrlKey: true });
    expect(c.value).toBe(0);
    expect(defaultPrevented).toBe(true);
  });

  test("a real Ctrl+Shift+Z redoes", () => {
    const c = counter("editor");
    c.edit("move", 9);
    c.history.undo();
    scope({ history: c.history, label: "editor" });
    press("z", { ctrlKey: true, shiftKey: true });
    expect(c.value).toBe(9);
  });

  test("the disposer detaches the listener, so an unmounted editor is deaf", () => {
    const c = counter("editor");
    c.edit("move", 9);
    const dispose = scope({ history: c.history, label: "editor" });
    expect(undoKeyDiagnostics().attached).toBe(true);
    dispose();
    expect(undoKeyDiagnostics().scopes).toHaveLength(0);
    expect(undoKeyDiagnostics().attached).toBe(false);
    const { defaultPrevented } = press("z", { ctrlKey: true });
    expect(c.value).toBe(9);
    // And nothing is claimed either, so the browser's own undo is free again.
    expect(defaultPrevented).toBe(false);
  });

  test("an inactive scope stands down rather than shadowing what is under it", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor", active: () => false });
    expect(press("z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(c.value).toBe(9);
  });
});

describe("ignoreWhenTyping — TRUE by default, the OPPOSITE of the escape registry", () => {
  test("Ctrl+Z inside a focused text input goes to the input, not the editor", () => {
    // Inside a text field Ctrl+Z is the browser's own per-field undo, and taking
    // it away is strictly worse than having no editor undo: the player has no
    // other way to take back a typo and nothing visibly happened to say the key
    // was consumed. So the scope stands down AND does not preventDefault, which
    // is the half that actually leaves the field's native undo working.
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor" });
    const field = input();
    field.focus();
    const { defaultPrevented } = press("z", { ctrlKey: true, target: field });
    expect(c.value).toBe(9);
    expect(defaultPrevented).toBe(false);
  });

  test("a textarea and a select are treated the same way", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor" });
    for (const tag of ["textarea", "select"] as const) {
      const el = document.createElement(tag);
      document.body.append(el);
      press("z", { ctrlKey: true, target: el });
    }
    expect(c.value).toBe(9);
  });

  test("a contenteditable is a text field too", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor" });
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    document.body.append(el);
    // happy-dom derives `isContentEditable` from the attribute, which is the
    // property `isTyping` actually reads.
    expect(el.isContentEditable).toBe(true);
    press("z", { ctrlKey: true, target: el });
    expect(c.value).toBe(9);
  });

  test("a BUTTON is not a text field — the guard is not 'any focused control'", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor" });
    const btn = document.createElement("button");
    document.body.append(btn);
    press("z", { ctrlKey: true, target: btn });
    expect(c.value).toBe(0);
  });

  test("`ignoreWhenTyping: false` claims the key even in a field", () => {
    const c = counter("editor");
    c.edit("move", 9);
    scope({ history: c.history, label: "editor", ignoreWhenTyping: false });
    const field = input();
    const { defaultPrevented } = press("z", { ctrlKey: true, target: field });
    expect(c.value).toBe(0);
    expect(defaultPrevented).toBe(true);
  });
});

describe("auto-repeat", () => {
  test("does not travel, but IS preventDefaulted so the browser does not get it either", () => {
    // Each step restores a snapshot and queues a preview across the NUI
    // boundary, so a 30/second repeat empties the stack faster than the player
    // can see where it went. Claiming the key anyway is the second half: without
    // it a held Ctrl+Z starts undoing in the PAGE while the editor declines to.
    const c = counter("editor");
    c.edit("a", 1);
    c.edit("b", 2);
    scope({ history: c.history, label: "editor" });
    const { defaultPrevented } = press("z", { ctrlKey: true, repeat: true });
    expect(c.value).toBe(2);
    expect(defaultPrevented).toBe(true);
  });

  test("`allowRepeat: true` opts back in", () => {
    const c = counter("editor");
    c.edit("a", 1);
    c.edit("b", 2);
    scope({ history: c.history, label: "editor", allowRepeat: true });
    press("z", { ctrlKey: true, repeat: true });
    expect(c.value).toBe(1);
  });
});

describe("nesting — the live tRadio case", () => {
  test("the deeper scope owns the press and the host never sees it", () => {
    // tRadio's settings app hosts tLib's shared PropEditor inside itself. Two
    // raw window listeners means one Ctrl+Z undoes in BOTH, so the player sees
    // the prop move and something in the host change at once.
    const host = counter("host");
    const inner = counter("inner");
    host.edit("host edit", 100);
    inner.edit("inner edit", 7);
    scope({ history: host.history, label: "host", depth: 0 });
    scope({ history: inner.history, label: "inner", depth: 1 });
    expect(undoKeyDiagnostics().owner).toBe("inner");
    press("z", { ctrlKey: true });
    expect(inner.value).toBe(0);
    expect(host.value).toBe(100);
  });

  test("registration order does not decide it — depth does", () => {
    // The inner scope registered FIRST here, which is the case a
    // newest-wins-only registry gets wrong.
    const host = counter("host");
    const inner = counter("inner");
    host.edit("host edit", 100);
    inner.edit("inner edit", 7);
    scope({ history: inner.history, label: "inner", depth: 1 });
    scope({ history: host.history, label: "host", depth: 0 });
    press("z", { ctrlKey: true });
    expect(inner.value).toBe(0);
    expect(host.value).toBe(100);
  });

  test("at equal depth the newest-registered wins", () => {
    const first = counter("first");
    const second = counter("second");
    first.edit("a", 1);
    second.edit("b", 2);
    scope({ history: first.history, label: "first", depth: 1 });
    scope({ history: second.history, label: "second", depth: 1 });
    press("z", { ctrlKey: true });
    expect(second.value).toBe(0);
    expect(first.value).toBe(1);
  });

  test("the host takes the key back when the inner scope goes inactive", () => {
    const host = counter("host");
    const inner = counter("inner");
    host.edit("host edit", 100);
    let open = true;
    scope({ history: host.history, label: "host", depth: 0 });
    scope({ history: inner.history, label: "inner", depth: 1, active: () => open });
    open = false;
    press("z", { ctrlKey: true });
    expect(host.value).toBe(0);
  });
});
