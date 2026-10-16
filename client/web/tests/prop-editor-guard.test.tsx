/**
 * `PropEditor`'s discard guard, rendered and driven by real events.
 *
 * Why this file is the point of the whole harness
 *
 * `tests/unit/prop-editor-undo.test.ts` is explicit about its own limit: it pins
 * the snapshot/restore round trip, `sameTransform`, `transformMessages` and the
 * dirty flag, and then says "Nothing below renders PropEditor, presses Escape,
 * clicks Cancel or opens the discard prompt… Said plainly here so a later reader
 * does not mistake a green run for proof that Escape prompts."
 *
 * Escape in this editor throws a placement away, in tRadar, tDetector and tRadio
 * simultaneously, and before the guard landed it did so with no prompt at all.
 * Everything in this file was argued and unmeasured.
 *
 * The three stubs, and why each is the right scope
 *
 *  1. `PropEditorViewport` — a Three.js `WebGLRenderer` over a real `<canvas>`.
 *     happy-dom has no WebGL context, so `new GizmoScene(...)` throws in
 *     `onSettled` and the mount dies before any chrome renders. Nothing under
 *     test here touches the scene: `getGizmoScene()` answers `null` when none is
 *     set, which is the same path the editor takes before the canvas mounts in
 *     the real game. The gizmo's own undo integration is covered headlessly in
 *     `tests/unit/prop-editor-undo.test.ts`.
 *  2. `window.GetParentResourceName` + `fetch` — this is how `tests/browser/*.ts`
 *     already drive this code (same stub, same `https://<resource>/<event>`
 *     route), so the real `fetchNui` runs, including its `AbortSignal.timeout`
 *     deadline. The calls are CAPTURED rather than suppressed, because
 *     "`propEditorCancel` was NOT sent" is half of what a discard guard means.
 *  3. The module-level prop-editor store is reset between tests. It is
 *     module-level on purpose (one 3D editor per page), which makes it shared
 *     state across a `bun test` process.
 *
 * Still not provable here, and not pretended to be
 *
 *  - That the prompt is VISIBLE, or that focus paints a ring: no layout, no
 *    paint. `scripts/probe-focus-paint.ts` measures painted pixels in the pinned
 *    Chromium 103 and remains the only thing that can.
 *  - That Ark's `FocusTrap` actually traps Tab in CEF. What is asserted below is
 *    the trap's presence and where initial focus lands, which is the part a
 *    defect would silently change.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { closePropEditor, propEditorState } from "../../../internal/shared-ts/prop-editor/store";
import { UndoHistory } from "../../../shared/ts/undo";
import { createUndoScope, undoKeyDiagnostics } from "../../../shared/ts/undo-keys";

// Must be registered before `PropEditor` is imported, which is why this file
// imports it with a top-level `await import` below rather than a static import:
// `mock.module` registers an override in the module registry, and a static
// import of `PropEditor` would already have pulled the real viewport in.
mock.module("../../../internal/shared-ts/prop-editor/PropEditorViewport", () => ({
  PropEditorViewport: () => null,
}));
const { PropEditor } = await import("../../../internal/shared-ts/prop-editor/PropEditor");

const PREFIX = "tlibtest";
/** The editor namespaces everything it sends; a bare name would never match. */
const CANCEL = `${PREFIX}:propEditorCancel`;

/** Every NUI callback the editor fired, in order. */
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
  closePropEditor();
  globalThis.fetch = realFetch;
  delete (window as unknown as { GetParentResourceName?: unknown }).GetParentResourceName;
  document.body.innerHTML = "";
});

const INIT = {
  vehicleModel: "police3",
  vehicleDisplayName: "Police Cruiser",
  propData: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 },
  vehicleMatrix: null,
  hasExisting: true,
};

/** Let happy-dom's `postMessage` queue drain, then let Solid settle. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

/** Mount the editor and open it the way the Lua half does. */
async function openEditor() {
  const result = render(() => <PropEditor prefix={PREFIX} />);
  await settle();
  window.postMessage({ action: `${PREFIX}:propEditorInit`, data: INIT }, "*");
  await settle();
  expect(propEditorState.open).toBe(true);
  return result;
}

function pressEscape(target: Element = document.body) {
  const down = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(up);
  flush();
  return down;
}

function pressUndo(target: Element = document.body) {
  const e = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  flush();
  return e;
}

const q = <T extends Element = HTMLElement>(c: HTMLElement, sel: string) =>
  c.querySelector(sel) as T | null;
const prompt = (c: HTMLElement) => q(c, '[role="alertdialog"]');
const keepBtn = (c: HTMLElement) => q<HTMLButtonElement>(c, "[data-prop-editor-keep]");
const discardBtn = (c: HTMLElement) => q<HTMLButtonElement>(c, "[data-prop-editor-discard]");
const cancelBtn = (c: HTMLElement) => q<HTMLButtonElement>(c, "[data-prop-editor-cancel]");
const field = (c: HTMLElement, label: string) => {
  const rows = [...c.querySelectorAll("label, .tlib-pe-field, div")];
  for (const row of rows) {
    if (row.textContent?.trim().startsWith(label)) {
      const el = row.querySelector("input");
      if (el) return el as HTMLInputElement;
    }
  }
  throw new Error(`no numeric field labelled ${label}`);
};

/** Type a value into a numeric field the way Chrome reports it: `change`, then `blur`. */
function typeInto(el: HTMLInputElement, value: string, { blur = true } = {}) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  if (blur) {
    el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    flush();
  }
}

describe("the editor mounts at all", () => {
  test("closed until the init message, then the chrome is there", async () => {
    const { container } = render(() => <PropEditor prefix={PREFIX} />);
    await settle();
    // `<Show when={propEditorState.open}>` — a closed mount must render nothing,
    // not a hidden editor.
    expect(q(container, "[data-prop-editor]")).toBeNull();
    window.postMessage({ action: `${PREFIX}:propEditorInit`, data: INIT }, "*");
    await settle();
    expect(q(container, "[data-prop-editor]")).not.toBeNull();
    expect(cancelBtn(container)).not.toBeNull();
    expect(container.textContent).toContain("Police Cruiser");
  });

  test("the shared undo pair is mounted, not re-implemented", async () => {
    const { container } = await openEditor();
    const undo = q<HTMLButtonElement>(container, '[aria-label^="Nothing to undo"]');
    expect(undo).not.toBeNull();
    expect(undo!.disabled).toBe(true);
    // And the shared hint strip, with its size as a class rather than an
    // arbitrary utility that `unoMerge` can drop.
    const hint = q(container, ".tlib-undo-hint");
    expect(hint).not.toBeNull();
    expect(hint!.getAttribute("class")).not.toMatch(/text-\[/);
  });
});

describe("the guard: a CLEAN session closes in one press", () => {
  test("Escape on an untouched session sends propEditorCancel and shows no prompt", async () => {
    const { container } = await openEditor();
    pressEscape();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).toContain(CANCEL);
  });

  test("Cancel on an untouched session does the same", async () => {
    const { container } = await openEditor();
    cancelBtn(container)!.click();
    flush();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).toContain(CANCEL);
  });
});

describe("the guard: a DIRTY session asks first", () => {
  test("Escape asks instead of discarding when the session is dirty", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    expect(prompt(container)).toBeNull();
    pressEscape();
    expect(prompt(container)).not.toBeNull();
  });

  test("a dirty session's Escape sends no propEditorCancel", async () => {
    // The half that actually matters. A prompt that appears while the cancel has
    // already gone down the wire is not a guard.
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    sent = [];
    pressEscape();
    expect(prompt(container)).not.toBeNull();
    expect(sent.map((s) => s.event)).not.toContain(CANCEL);
  });

  test("Cancel routes through the guard rather than discarding", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "Y"), "-1.5");
    sent = [];
    cancelBtn(container)!.click();
    flush();
    expect(prompt(container)).not.toBeNull();
    expect(sent.map((s) => s.event)).not.toContain(CANCEL);
  });

  test("the prompt is an alertdialog with both answers in it", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    const dialog = prompt(container)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Wired by id, so a screen reader reads the question and not just the title.
    const labelled = dialog.getAttribute("aria-labelledby")!;
    const described = dialog.getAttribute("aria-describedby")!;
    expect(container.querySelector(`#${labelled}`)).not.toBeNull();
    expect(container.querySelector(`#${described}`)).not.toBeNull();
    expect(keepBtn(container)).not.toBeNull();
    expect(discardBtn(container)).not.toBeNull();
  });

  test("the lossy answer is on the RIGHT and carries the destructive variant", async () => {
    // A *destructive confirmation*, where the estate rule is lossy-right and the
    // safe answer takes the affirmative slot — "Keep editing" is the affirmative
    // answer to "discard?". That is the opposite hand from this editor's own
    // Save/Cancel pair, and both are correct.
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    const order = [...prompt(container)!.querySelectorAll("button")];
    expect(order[0]!.hasAttribute("data-prop-editor-keep")).toBe(true);
    expect(order[1]!.hasAttribute("data-prop-editor-discard")).toBe(true);
    expect(discardBtn(container)!.getAttribute("class")).toContain("destructive");
  });

  test("focus lands on Keep editing, not on the destructive answer", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    // The ref queues a microtask, which is what tELS measured working in CEF.
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(keepBtn(container));
  });

  test("Keep editing dismisses and sends nothing", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    sent = [];
    keepBtn(container)!.click();
    flush();
    expect(prompt(container)).toBeNull();
    expect(sent).toHaveLength(0);
    expect(propEditorState.open).toBe(true);
  });

  test("Discard changes is the only thing that sends propEditorCancel", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    sent = [];
    discardBtn(container)!.click();
    flush();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).toEqual([CANCEL]);
  });
});

describe("the guard: Escape while the question is up", () => {
  test("onInternal dismisses the prompt before the escape layer can act", async () => {
    // `onInternal` runs first, so Escape answers the QUESTION and nothing else.
    // It is also what stops the press that OPENED the prompt from confirming it
    // on the way back down.
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    expect(prompt(container)).not.toBeNull();
    sent = [];
    pressEscape();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).not.toContain(CANCEL);
  });

  test("Escape can never discard, however many times it is pressed", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    for (let i = 0; i < 5; i++) pressEscape();
    expect(sent.map((s) => s.event)).not.toContain(CANCEL);
    // And the editor is still open with the placement intact.
    expect(propEditorState.open).toBe(true);
    expect(propEditorState.propData.x).toBe(3);
  });

  test("the undo scope stands down while the question is up", async () => {
    // The dialog is a decision, not an edit surface: undoing underneath it would
    // change the very thing the player is being asked about.
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    expect(prompt(container)).not.toBeNull();
    expect(undoKeyDiagnostics().owner).toBeNull();
    pressUndo();
    expect(propEditorState.propData.x).toBe(3);
  });
});

describe("isDirty counts an OPEN batch, so the guard must settle before asking", () => {
  test("mid-gesture, with the batch still open, the session is dirty", async () => {
    // A bare `change` with no blur leaves the batch open. `canUndo()` includes
    // `pending`, which is what makes a field still focused count as something to
    // lose.
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3", { blur: false });
    pressEscape();
    expect(prompt(container)).not.toBeNull();
  });

  test("after a NO-OP gesture settles, the session is clean again", async () => {
    // THIS IS THE SUBTLE ONE. A gesture that resolves to the value that was
    // already there opens a batch — so the editor is dirty mid-gesture — and the
    // no-op guard discards that batch at `commit`. So the same session is dirty
    // before the blur and clean after it, and a guard that asked before the
    // settle would prompt over nothing.
    const { container } = await openEditor();
    const x = field(container, "X");
    typeInto(x, "0", { blur: false });
    pressEscape();
    expect(prompt(container)).not.toBeNull();
    keepBtn(container)!.click();
    flush();
    // The blur commits, and `sameTransform` finds before and after equal.
    x.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    flush();
    sent = [];
    pressEscape();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).toContain(CANCEL);
  });

  test("a number field's blur commits its open batch", async () => {
    // Observable as entry COUNT: with the blur closing each batch, two edits to
    // one axis are two undo steps. Without it, `push` extends the open batch and
    // twenty stepper ticks collapse into one — which is the behaviour the
    // batching is FOR, and the reason the commit has to come from the blur.
    const { container } = await openEditor();
    const x = field(container, "X");
    typeInto(x, "3");
    typeInto(x, "7");
    expect(propEditorState.propData.x).toBe(7);
    pressUndo();
    expect(propEditorState.propData.x).toBe(3);
    pressUndo();
    expect(propEditorState.propData.x).toBe(0);
  });

  test("a stepper burst under one label collapses into a single entry", async () => {
    const { container } = await openEditor();
    const x = field(container, "X");
    for (const v of ["1", "2", "3", "4"]) typeInto(x, v, { blur: false });
    x.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    flush();
    expect(propEditorState.propData.x).toBe(4);
    pressUndo();
    expect(propEditorState.propData.x).toBe(0);
  });
});

describe("nesting against a host page", () => {
  test("depth 1 beats a host page's scope, and the host never sees the press", async () => {
    // The live case: tRadio's settings app hosts this editor inside itself, two
    // independent histories and one keyboard.
    let hostValue = 0;
    const host = new UndoHistory({ label: "host-app" });
    host.register<number>("h", {
      capture: () => hostValue,
      restore: (s) => {
        hostValue = s;
      },
    });
    host.with("host edit", ["h"], () => {
      hostValue = 100;
    });
    const disposeHost = createUndoScope({ history: host, label: "host-app", depth: 0 });
    try {
      const { container } = await openEditor();
      typeInto(field(container, "X"), "3");
      expect(undoKeyDiagnostics().owner).toBe("prop-editor");
      pressUndo();
      expect(propEditorState.propData.x).toBe(0);
      expect(hostValue).toBe(100);
    } finally {
      disposeHost();
    }
  });

  test("depth 1 holds even when the host registers its scope LAST", async () => {
    /*
     * THIS IS THE TEST THAT ACTUALLY PROVES `depth: 1` DOES ANYTHING, AND IT
     * EXISTS BECAUSE THE NEGATIVE CONTROL CAUGHT ITS ABSENCE.
     *
     * The test above registers the host FIRST, which is the ordering tRadio
     * happens to produce. Planting `depth: 0` on the editor's scope left that
     * test GREEN — at equal depth the registry resolves newest-first, and the
     * editor is the newer one, so it kept winning for the wrong reason. The
     * control run reported `the suite goes RED (exit 0)`: a defect that reddened
     * nothing, which is a control that cannot reach its hazard.
     *
     * Registering the host AFTER the editor is open removes the tie-break from
     * the answer and leaves `depth` as the only thing deciding it. Any host that
     * mounts a scope while the editor is already up — a settings dialog opening
     * behind it, a lazily-mounted panel — is this ordering.
     */
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");

    let hostValue = 0;
    const host = new UndoHistory({ label: "host-app" });
    host.register<number>("h", {
      capture: () => hostValue,
      restore: (s) => {
        hostValue = s;
      },
    });
    host.with("host edit", ["h"], () => {
      hostValue = 100;
    });
    const disposeHost = createUndoScope({ history: host, label: "host-app", depth: 0 });
    try {
      expect(undoKeyDiagnostics().owner).toBe("prop-editor");
      pressUndo();
      expect(propEditorState.propData.x).toBe(0);
      expect(hostValue).toBe(100);
    } finally {
      disposeHost();
    }
  });

  test("the host gets the keyboard back once the editor closes", async () => {
    let hostValue = 0;
    const host = new UndoHistory({ label: "host-app" });
    host.register<number>("h", {
      capture: () => hostValue,
      restore: (s) => {
        hostValue = s;
      },
    });
    host.with("host edit", ["h"], () => {
      hostValue = 100;
    });
    const disposeHost = createUndoScope({ history: host, label: "host-app", depth: 0 });
    try {
      await openEditor();
      // `active: () => propEditorState.open` — the mounted-but-closed editor must
      // not shadow the host it is mounted in.
      window.postMessage({ action: `${PREFIX}:propEditorClose` }, "*");
      await settle();
      expect(propEditorState.open).toBe(false);
      expect(undoKeyDiagnostics().owner).toBe("host-app");
      pressUndo();
      expect(hostValue).toBe(0);
    } finally {
      disposeHost();
    }
  });
});

describe("session boundaries", () => {
  test("a new init clears the history, so a fresh session is never already dirty", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    window.postMessage({ action: `${PREFIX}:propEditorInit`, data: INIT }, "*");
    await settle();
    sent = [];
    pressEscape();
    expect(prompt(container)).toBeNull();
    expect(sent.map((s) => s.event)).toContain(CANCEL);
  });

  test("a new init also closes a prompt that was up", async () => {
    const { container } = await openEditor();
    typeInto(field(container, "X"), "3");
    pressEscape();
    expect(prompt(container)).not.toBeNull();
    window.postMessage({ action: `${PREFIX}:propEditorInit`, data: INIT }, "*");
    await settle();
    expect(prompt(container)).toBeNull();
  });
});
