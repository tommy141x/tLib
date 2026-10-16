/**
 * `LayoutEditor`'s discard prompt — the one confirmation footer in the stack
 * that put the lossy answer on the left.
 *
 * The fix this pins
 *
 * It shipped `Discard` first, with `tone="primary"` AND `autofocus`, under an
 * affirmative-left reading of the pair. Every other confirmation footer in the
 * estate — tELS's discard guard, tUnit's `CharacterEditor`, and tLib's own
 * shared `PropEditor` prompt — puts the lossy action on the right and gives the
 * affirmative slot to the safe answer, because "Keep editing" IS the affirmative
 * answer to "discard?".
 *
 * The autofocus is what made it more than a convention argument: one Enter threw
 * the whole layout away, on a dialog whose own body says "This cannot be undone".
 *
 * THE SAVE/CANCEL FOOTER ABOVE IT IS NOT PART OF THIS AND IS UNCHANGED. That
 * one is affirmative-left, which is where all four of tLib's affirmative/cancel
 * pairs were deliberately moved. A destructive confirmation is a different widget
 * answering a different question; the comment at the call site says so.
 *
 * A FINDING THAT IS NOW FIXED
 *
 * `requestCancel()` used to be `if (canUndo()) setDiscarding(true); else
 * finish(false)` with NO settle of an in-flight gesture — unlike the shared
 * `PropEditor`, whose `isDirty()` gate is reached only after a blur has
 * committed. The note here said it got away with that because its batches are
 * opened and closed by pointer capture, so one is never open when the prompt
 * appears. That was WRONG about the keyboard: a held arrow key opens a batch and
 * closes it on `keyup`, so Escape with the key still down reached the gate with
 * one open — and an open batch counts as dirty whether or not it changed
 * anything, so a nudge against a clamped edge asked the question about nothing.
 *
 * `requestCancel()` settles first now. The last test in this file still pins the
 * consequence either way: by the time the prompt can be reached, the edit is
 * complete, so the question is never about a no-op.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import type { Component } from "@tlib/shared/hud-geometry";
import { flush } from "solid-js";
import LayoutEditor from "../src/layout/LayoutEditor";

/*
 * `lucide-solid` IS NO LONGER STUBBED HERE, AND THAT IS THE POINT.
 *
 * It was, until `shared/ts/solid-compat/solid-1-compat-web.ts` gained a
 * Solid-1-arity `spread`. Before that export existed, this editor's own chrome
 * took every icon through `lucide-solid/dist/esm/Icon.mjs:37` —
 * `spread(_el$, mergeProps(…), true, true)`, Solid 1's
 * `spread(node, accessor, isSVG, skipChildren)` — whose fourth argument arrives
 * in Solid 2's `skip`, a PREDICATE. `skip("children")` then threw inside a
 * render effect, so Solid 2 halted the reactive graph for the whole process and
 * this editor rendered an EMPTY container; nine tests in this file failed in a
 * cascade naming none of the cause.
 *
 * The icons are therefore REAL here, and the arity regression reddens this file
 * the loud way rather than being masked by a stub. `lucide-spread-arity.test.tsx`
 * is the specific, named assertion; this file is the blast radius it would have.
 */

let sent: Array<{ event: string; data: unknown }> = [];
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
      data: init?.body ? JSON.parse(String(init.body)) : undefined,
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

const LAYOUT = { x: 0.2, y: 0.3, scale: 1, visible: true, anchor: "top-left" } as const;
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

/** `highSession` is module-scoped per mount, but a rising number is free. */
let session = 1;

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

async function openEditor() {
  const result = render(() => <LayoutEditor />);
  await settle();
  window.postMessage(
    { action: "layoutOpen", data: { session: ++session, components: [COMPONENT], safezone: 0 } },
    "*"
  );
  await settle();
  return result;
}

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
const prompt = (c: HTMLElement) => q(c, '[role="alertdialog"]');
const answers = (c: HTMLElement) =>
  [...prompt(c)!.querySelectorAll("[data-discard-answer]")] as HTMLButtonElement[];

/** Make the session dirty through the editor's own public surface. */
function nudge(c: HTMLElement) {
  const surface = q(c, ".tlib-layout__surface") ?? c.firstElementChild!;
  (surface as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
  );
  flush();
}

describe("the editor opens", () => {
  test("nothing is rendered until layoutOpen, then the panel is there", async () => {
    const { container } = render(() => <LayoutEditor />);
    await settle();
    expect(container.textContent).toBe("");
    window.postMessage(
      { action: "layoutOpen", data: { session: ++session, components: [COMPONENT], safezone: 0 } },
      "*"
    );
    await settle();
    expect(container.textContent).toContain("Speedometer");
    expect(prompt(container)).toBeNull();
  });
});

describe("the discard prompt's answers", () => {
  test("the lossy answer is on the RIGHT and the safe one takes the affirmative slot", async () => {
    const { container } = await openEditor();
    nudge(container);
    q(container, ".tlib-layout__discard")!.click();
    flush();
    expect(prompt(container)).not.toBeNull();
    const order = answers(container).map((b) => b.dataset.discardAnswer);
    expect(order).toEqual(["keep", "discard"]);
  });

  test("the affirmative tone and the autofocus are both on Keep editing", async () => {
    // This is the half that made the old order dangerous rather than merely
    // inconsistent: `autofocus` sat on Discard, so one Enter threw the layout
    // away on a dialog that says "This cannot be undone".
    const { container } = await openEditor();
    nudge(container);
    q(container, ".tlib-layout__discard")!.click();
    flush();
    const [keep, discard] = answers(container);
    expect(keep!.dataset.tone).toBe("primary");
    expect(keep!.hasAttribute("autofocus")).toBe(true);
    expect(discard!.dataset.tone).toBe("destructive");
    expect(discard!.hasAttribute("autofocus")).toBe(false);
  });

  test("Keep editing dismisses and keeps the session open", async () => {
    const { container } = await openEditor();
    nudge(container);
    q(container, ".tlib-layout__discard")!.click();
    flush();
    sent = [];
    answers(container)[0]!.click();
    flush();
    expect(prompt(container)).toBeNull();
    expect(container.textContent).toContain("Speedometer");
    expect(sent.map((s) => s.event)).not.toContain("layoutFinish");
  });

  test("Discard is the only answer that finishes the session", async () => {
    const { container } = await openEditor();
    nudge(container);
    q(container, ".tlib-layout__discard")!.click();
    flush();
    sent = [];
    answers(container)[1]!.click();
    await settle();
    const events = sent.map((s) => s.event);
    expect(events.some((e) => /layout/i.test(e))).toBe(true);
    expect(prompt(container)).toBeNull();
  });
});

describe("the guard itself", () => {
  test("a clean session's Cancel does not prompt", async () => {
    const { container } = await openEditor();
    q(container, ".tlib-layout__discard")!.click();
    await settle();
    expect(prompt(container)).toBeNull();
  });

  test("Escape on a dirty session prompts rather than discarding", async () => {
    const { container } = await openEditor();
    nudge(container);
    sent = [];
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    flush();
    expect(prompt(container)).not.toBeNull();
  });

  test("Escape with the prompt up dismisses it and never discards", async () => {
    const { container } = await openEditor();
    nudge(container);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    flush();
    expect(prompt(container)).not.toBeNull();
    sent = [];
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    flush();
    expect(prompt(container)).toBeNull();
    expect(container.textContent).toContain("Speedometer");
  });

  test("the gate reads canUndo() about a SETTLED edit", async () => {
    // `requestCancel()` settles first, so a batch left open by a still-held
    // arrow key is closed — and discarded by `sameLayout` if it moved nothing —
    // before the dirty flag is read.
    //
    // This asserts the consequence: a keyboard nudge is a COMPLETE edit by the
    // time the prompt can be reached, so the prompt is never asking about a
    // no-op, and undoing it back to the opening state closes without a question.
    const { container } = await openEditor();
    nudge(container);
    q(container, ".tlib-layout__discard")!.click();
    flush();
    expect(prompt(container)).not.toBeNull();
    // Dismiss, then undo the nudge back to clean, then Cancel again: a session
    // returned to its opening state must close without a question.
    answers(container)[0]!.click();
    flush();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })
    );
    flush();
    q(container, ".tlib-layout__discard")!.click();
    await settle();
    expect(prompt(container)).toBeNull();
  });
});
