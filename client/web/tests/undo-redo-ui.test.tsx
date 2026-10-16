/**
 * `UndoRedo`, `UndoHint` and `UndoDirty`, rendered.
 *
 * What was unproven before this file existed
 *
 * All of it. `tests/unit/undo.test.ts` is a thorough suite over `UndoHistory`
 * and `UndoKeyRegistry` and it says so itself: nothing in the package rendered a
 * component, so "the buttons disable on an empty stack" and "the title carries
 * the entry label" were claims about source code. The three editors that mount
 * this pair had a typecheck, a dead-class scan and a Vite build between them and
 * a button that does nothing.
 *
 * Two things that are NOT assertable here, said plainly
 *
 *  - **Whether the focus indicator paints.** `buttonVariants` puts focus on an
 *    `outline` because `presetWind3` compiles `ring-*` to a `box-shadow` that is
 *    clipped to nothing inside an `overflow: hidden` ancestor. happy-dom has no
 *    layout and no paint, so that is `scripts/probe-focus-paint.ts`'s job — it
 *    measures pixels in the pinned Chromium 103 — and it stays its job.
 *  - **Whether 11px is legible in CEF.** Also a pixel question.
 *
 * What IS assertable here is everything about structure, attributes, disabled
 * state and reactivity, which is where the measured defects in this estate have
 * actually been.
 */

import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { UndoHistory } from "../../../shared/ts/undo";

// The control kit moved to `internal/`, which publish-public.ts strips. This
// file stays in the published half for the reason prop-editor-guard.test.tsx
// gives: the DOM harness it needs -- happy-dom, @solidjs/testing-library and
// the dedupe rewrite in `_setup.ts` -- is a client/web devDependency, and a
// second copy of it under internal/ would be two harnesses to keep in step. So
// the suite declares that the private half may be absent instead.
//
// A STATIC import fails at module load in a public clone and takes the whole
// file with it, so the kit is awaited below.
const HAS_UI_KIT = existsSync(new URL("../../../internal/shared-ts/ui/undo-redo.tsx", import.meta.url));
const describeWithUiKit = HAS_UI_KIT ? describe : describe.skip;
const { UndoDirty, UndoHint, UndoRedo, useUndoState } = HAS_UI_KIT
  ? await import("../../../internal/shared-ts/ui/undo-redo")
  : {
      UndoDirty: (() => null) as never,
      UndoHint: (() => null) as never,
      UndoRedo: (() => null) as never,
      useUndoState: (() => null) as never,
    };

afterEach(cleanup);

/**
 * A history with one tag over one mutable number, which is the smallest thing
 * that can be genuinely dirty. `capture` reads a plain variable rather than a
 * store proxy deliberately: a Solid 2 store write is not readable in the tick it
 * happened, so a `capture()` over a proxy snapshots the PRE-write value on both
 * sides of a synchronous push/mutate/commit and the no-op guard throws the entry
 * away — measured in `solid-js@2.0.0-rc.13`, and the reason the real editors'
 * `read` functions are synchronous plain reads too.
 */
function counter() {
  let value = 0;
  const history = new UndoHistory({ label: "test" });
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
    edit(label: string, to: number) {
      history.with(label, ["n"], () => {
        value = to;
      });
    },
  };
}

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")] as HTMLButtonElement[];

describeWithUiKit("UndoRedo", () => {
  test("renders exactly two buttons, both disabled on an empty stack", () => {
    const { history } = counter();
    const { container } = render(() => <UndoRedo history={history} />);
    const [undo, redo] = buttons(container);
    expect(buttons(container)).toHaveLength(2);
    expect(undo!.disabled).toBe(true);
    expect(redo!.disabled).toBe(true);
    expect(undo!.getAttribute("aria-label")).toBe("Nothing to undo");
    expect(redo!.getAttribute("aria-label")).toBe("Nothing to redo");
  });

  test("the undo button enables and carries the entry label once there is one", () => {
    const c = counter();
    const { container } = render(() => <UndoRedo history={c.history} />);
    c.edit("move element", 1);
    flush();
    const [undo, redo] = buttons(container);
    expect(undo!.disabled).toBe(false);
    expect(undo!.getAttribute("aria-label")).toBe("Undo move element · Ctrl Z");
    // `title` and `aria-label` deliberately carry the same string: an Ark
    // Tooltip.Trigger on a DISABLED button never opens, and these buttons are
    // disabled in exactly the state a tooltip would be explaining.
    expect(undo!.getAttribute("title")).toBe(undo!.getAttribute("aria-label"));
    expect(redo!.disabled).toBe(true);
  });

  test("clicking undo travels, and the redo button then carries the redo label", () => {
    const c = counter();
    const { container } = render(() => <UndoRedo history={c.history} />);
    c.edit("move element", 42);
    flush();
    buttons(container)[0]!.click();
    flush();
    expect(c.value).toBe(0);
    const [undo, redo] = buttons(container);
    expect(undo!.disabled).toBe(true);
    expect(redo!.disabled).toBe(false);
    expect(redo!.getAttribute("aria-label")).toBe("Redo move element · Ctrl Shift Z");
    redo!.click();
    flush();
    expect(c.value).toBe(42);
  });

  test("`onUndo` replaces history.undo(), for an editor that must settle first", () => {
    // `LayoutEditor.travel()` is exactly this: an editor with an in-flight
    // gesture has to settle it before travelling, and the override must be the
    // same function the keyboard scope calls.
    const c = counter();
    let calls = 0;
    const { container } = render(() => (
      <UndoRedo
        history={c.history}
        onUndo={() => {
          calls++;
        }}
      />
    ));
    c.edit("move", 5);
    flush();
    buttons(container)[0]!.click();
    expect(calls).toBe(1);
    expect(c.value).toBe(5); // NOT travelled — the override owns it.
  });

  test("`disabled` forces both off regardless of history state", () => {
    const c = counter();
    const { container } = render(() => <UndoRedo history={c.history} disabled />);
    c.edit("move", 1);
    flush();
    expect(buttons(container).map((b) => b.disabled)).toEqual([true, true]);
  });

  test("the hint strip is opt-in", () => {
    const { history } = counter();
    const { container, unmount } = render(() => <UndoRedo history={history} />);
    expect(container.textContent).not.toContain("Undo");
    unmount();
    const withHint = render(() => <UndoRedo history={history} hint />);
    expect(withHint.container.textContent).toContain("Ctrl");
    expect(withHint.container.textContent).toContain("Shift");
  });
});

describeWithUiKit("UndoHint", () => {
  test("names both chords", () => {
    const { container } = render(() => <UndoHint />);
    const kbd = [...container.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(kbd).toEqual(["Ctrl", "Z", "Ctrl", "Shift", "Z"]);
    expect(container.textContent).toContain("Undo");
    expect(container.textContent).toContain("Redo");
  });

  test("the font size is a class, not an arbitrary utility that can be merged away", () => {
    // THE REGRESSION THIS PINS. `text-[11px] text-muted-foreground` is ONE
    // `unoMerge` conflict group, so one of the two is dropped. It was safe here
    // only because tLib's `cn` shields the `text-size` group (`cn.ts:197-208`) —
    // which means any consumer reaching `unoMerge` directly (tWeb, tCinematics
    // and every `internal/*` project do) lost one of them.
    //
    // The fix moves the size into `.tlib-undo-hint` in `undo-redo.css`, so the
    // class string carries a colour and no size at all and there is nothing left
    // to collide. Asserted as the ABSENCE of an arbitrary text size rather than
    // as the presence of the class, because the absence is the property that
    // makes it safe.
    const { container } = render(() => <UndoHint />);
    const cls = container.firstElementChild!.getAttribute("class")!;
    expect(cls).toContain("tlib-undo-hint");
    expect(cls).toContain("text-muted-foreground");
    expect(cls).not.toMatch(/text-\[/);
  });

  test("a caller's class is appended rather than replacing the recipe", () => {
    const { container } = render(() => <UndoHint class="ml-auto" />);
    const cls = container.firstElementChild!.getAttribute("class")!;
    expect(cls).toContain("ml-auto");
    expect(cls).toContain("tlib-undo-hint");
    expect(cls).toContain("text-muted-foreground");
  });
});

describeWithUiKit("UndoDirty", () => {
  test("absent while clean, present and a status role once dirty", () => {
    const c = counter();
    const { container } = render(() => <UndoDirty history={c.history} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    c.edit("move", 1);
    flush();
    const pill = container.querySelector('[role="status"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("Unsaved changes");
  });

  test("goes clean again when the stack is undone back to empty", () => {
    const c = counter();
    const { container } = render(() => <UndoDirty history={c.history} />);
    c.edit("move", 1);
    flush();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    c.history.undo();
    flush();
    // `dirty` IS `canUndo`, deliberately — one notion of dirty, not two. So
    // undoing to an empty past is clean even though a redo is available.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("carries a caller's own wording", () => {
    const c = counter();
    const { container } = render(() => (
      <UndoDirty history={c.history}>Unsaved vehicle changes</UndoDirty>
    ));
    c.edit("move", 1);
    flush();
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Unsaved vehicle changes");
  });

  test("no arbitrary text size here either", () => {
    // The same `unoMerge` hazard as `UndoHint`, on the same pair — `text-[11px]`
    // beside `text-primary`. The brief named only the hint; this one is the
    // identical defect two components down and is fixed with it.
    const c = counter();
    const { container } = render(() => <UndoDirty history={c.history} />);
    c.edit("move", 1);
    flush();
    const cls = container.querySelector('[role="status"]')!.getAttribute("class")!;
    expect(cls).toContain("text-primary");
    expect(cls).not.toMatch(/text-\[/);
  });
});

describeWithUiKit("useUndoState", () => {
  test("is readable on first render, with no initial gap", () => {
    // `onChange` fires the listener immediately, which is what makes a UI that
    // mounts AFTER the first edit show the right buttons rather than an empty
    // pair for one tick.
    const c = counter();
    c.edit("move", 1);
    // `unknown` rather than `boolean | null`: a `null` initialiser narrows
    // `toBe`'s overload to `null` and rejects `true`.
    let first: unknown = null;
    render(() => {
      const state = useUndoState(c.history);
      first = state().canUndo;
      return <div />;
    });
    expect(first).toBe(true);
  });

  test("two subscribers both update — the listener set is not single-slot", () => {
    const c = counter();
    const { container } = render(() => (
      <>
        <UndoRedo history={c.history} />
        <UndoDirty history={c.history} />
      </>
    ));
    c.edit("move", 1);
    flush();
    expect(buttons(container)[0]!.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  test("unsubscribes on cleanup, so a disposed editor stops being notified", () => {
    const c = counter();
    const { unmount } = render(() => <UndoRedo history={c.history} />);
    unmount();
    // No observable listener count on the public surface, so this asserts the
    // thing a leak would actually break: a push after unmount must not throw out
    // of a setter on a disposed signal.
    expect(() => {
      c.edit("move", 1);
      flush();
    }).not.toThrow();
  });
});
