/**
 * The harness, asserting itself.
 *
 * tLib had ZERO component tests before this directory existed, so the first
 * thing that needs proving is not a component — it is that a component test here
 * can fail. Every one of these cases corresponds to a state the harness was
 * measured to be in during its construction, where some suites were green and
 * the thing they claimed to prove was not being measured at all.
 *
 * Read `_setup.ts` for the mechanisms. This file is the evidence that they fired.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { UndoRedo } from "../../../shared/ts/ui/undo-redo";
import { UndoHistory } from "../../../shared/ts/undo";
import { undoKeyDiagnostics } from "../../../shared/ts/undo-keys";

afterEach(cleanup);

const g = globalThis as unknown as {
  __dedupedFiles?: () => number;
  __solidVendorFilesRewritten?: () => number;
  __controlPlanted?: () => boolean;
};

describe("the DOM is real enough", () => {
  test("happy-dom is installed as globals", () => {
    expect(typeof document).toBe("object");
    expect(typeof window.KeyboardEvent).toBe("function");
    // The identity that matters: bun ships its own native `Event`, and
    // happy-dom's `dispatchEvent` type-checks against happy-dom's. A hand-copied
    // set of globals would pass the two lines above and then reject every event.
    const el = document.createElement("div");
    let seen = false;
    el.addEventListener("keydown", () => {
      seen = true;
    });
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(seen).toBe(true);
  });

  test("textContent = 0 appends a text node, as the spec and CEF both do", () => {
    // happy-dom's own setter gates on truthiness and appends NOTHING, which
    // leaves Solid's renderer with `current = 0` and a null `firstChild`. The
    // next update then throws inside an effect, and an uncaught throw in an
    // effect halts the reactive graph for the whole PROCESS — so this is not one
    // test's problem, it is every test that runs after it.
    const span = document.createElement("span");
    span.textContent = 0 as unknown as string;
    expect(span.textContent).toBe("0");
    expect(span.firstChild).not.toBeNull();
    span.textContent = null;
    expect(span.textContent).toBe("");
  });

  test("a number rendered by Solid survives a second update", () => {
    // The end-to-end form of the case above: first value numeric, which puts the
    // renderer on its fast path, then a second write through the same hole.
    const [n, set] = createSignal(0);
    const { container } = render(() => <span>{n()}</span>);
    expect(container.textContent).toBe("0");
    set(7);
    flush();
    expect(container.textContent).toBe("7");
  });
});

describe("the module graph is production's", () => {
  test("solid-js is the browser build, not the SSR build", () => {
    // `_setup.ts` throws if it is not, before any suite is collected; this is the
    // same fact asserted where a reader will see it. Without the browser
    // condition a component test throws and a bare reactivity test passes
    // VACUOUSLY, which is the only one of the two that is dangerous.
    const resolved = Bun.resolveSync("solid-js", import.meta.dir);
    expect(resolved).not.toMatch(/[\\/]server(\.dev|\.observe)?\.js$/);
  });

  test("the shared/ts dedupe rewrite actually fired", () => {
    // A rewrite that matches nothing is indistinguishable from one that works:
    // reactivity still functions with two copies of solid-js, so the suites stay
    // green while every `onCleanup` silently does nothing.
    expect(g.__dedupedFiles?.() ?? 0).toBeGreaterThan(0);
  });

  test("the Solid 1 vendor compat rewrite actually fired", () => {
    expect(g.__solidVendorFilesRewritten?.() ?? 0).toBeGreaterThan(0);
  });

  test("a shared/ts component gets a real owner, so its cleanups run", () => {
    // THIS IS THE ONE THAT WAS BROKEN AND GREEN. With two copies of solid-js
    // a component in shared/ts rendered with no owner at all: `onSettled` fired,
    // `onCleanup` never did, and the cleanup `onSettled` RETURNED never did.
    //
    // For this directory that is not a leak, it is a wrong answer:
    // `createUndoScope` and `createEscapeLayer` register on page-wide singletons
    // from inside `onSettled` and unregister from the returned cleanup. If the
    // cleanup never runs, every editor a suite mounts stays registered forever
    // and the depth arbitration the nesting tests assert resolves against
    // corpses from earlier files.
    //
    // Asserted through the public registry rather than through `getOwner()`,
    // because the registry is the thing that would actually be wrong.
    const before = undoKeyDiagnostics().scopes.length;
    const history = new UndoHistory({ label: "harness" });
    render(() => <UndoRedo history={history} />);
    cleanup();
    expect(undoKeyDiagnostics().scopes.length).toBe(before);
  });
});

describe("the negative control", () => {
  test("a baseline run plants nothing", () => {
    // The other direction — that a planted defect REACHED its file — cannot be
    // asserted from here: bun may run this file before the one that imports the
    // patched module, so the global is order-dependent. `_setup.ts` prints a
    // `PLANTED` line instead and `scripts/dom-control.ts` reads that, which is
    // also the only signal that crosses the process boundary.
    if (process.env.DOM_CONTROL !== undefined) return;
    expect(g.__controlPlanted?.() ?? false).toBe(false);
  });
});
