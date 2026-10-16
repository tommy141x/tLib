/**
 * `ConfirmDelete`: what survives the control leaving the tree.
 *
 * ── ⚠️ What this file deliberately does NOT test, and why ───────────────────
 *
 * The defect that prompted it was `onCleanup(disarm)`, which called
 * `setArmed(false)` from inside the disposal pass. Solid 2 answers a reactive
 * write in an owned scope with [REACTIVE_WRITE_IN_OWNED_SCOPE], and because
 * disposal runs during the render that unmounts the row, the throw propagates
 * into the host's error boundary — in tELS, deleting a trigger rule removed the
 * rule and then replaced the whole editor with the boundary's fallback.
 *
 * That guard is DEV-ONLY and it is not live in this harness. Measured both ways
 * rather than assumed: a probe component writing a signal from its own
 * `onCleanup` reported "write silently allowed" under
 * `bun test --conditions=browser`, and the string
 * `REACTIVE_WRITE_IN_OWNED_SCOPE` appears zero times in tELS's built
 * `client/ui/assets/index.js`. So an `expect(unmount).not.toThrow()` here PASSES
 * AGAINST THE BUG — it was written, run against the reverted fix, and reported
 * 4/4 green. It has been removed rather than left in place looking like cover,
 * for the reason `scripts/dom-test.ts` already gives about this suite:
 * existence is not coverage.
 *
 * Where it IS covered: `tELS/scripts/preview/check-browser.ts` drives a real
 * delete through the rendered control against the DEV bundle, where the guard is
 * compiled in, and fails on any uncaught browser error. That is the only place
 * in either repo that can see this.
 *
 * Everything below is an assertion that can actually fail. The two of them are
 * the behaviours `clearTimer` had to keep when it was split out of `disarm`:
 * the self-expiring arm window, and a confirm whose own callback disposes the
 * control.
 */

import { existsSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

// The control kit moved to `internal/`, which publish-public.ts strips. This
// file stays in the published half for the reason prop-editor-guard.test.tsx
// gives: the DOM harness it needs -- happy-dom, @solidjs/testing-library and
// the dedupe rewrite in `_setup.ts` -- is a client/web devDependency, and a
// second copy of it under internal/ would be two harnesses to keep in step. So
// the suite declares that the private half may be absent instead.
//
// A STATIC import fails at module load in a public clone and takes the whole
// file with it, so the control is awaited below.
const HAS_UI_KIT = existsSync(new URL("../../../internal/shared-ts/ui/confirm-delete.tsx", import.meta.url));
const testWithUiKit = HAS_UI_KIT ? test : test.skip;
const { ConfirmDelete } = HAS_UI_KIT
  ? await import("../../../internal/shared-ts/ui/confirm-delete")
  : { ConfirmDelete: (() => null) as never };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

testWithUiKit("the arm window still expires on its own while mounted", async () => {
  // The half of `disarm` that must NOT have gone away with the cleanup change:
  // a timeout firing into a still-mounted component, where writing the signal is
  // the correct thing to do. Swap `disarm` for `clearTimer` in `handleClick`'s
  // `setTimeout` and this is what catches it.
  const { getByRole } = render(() => <ConfirmDelete onConfirm={() => {}} timeoutMs={20} />);
  flush();

  getByRole("button").click();
  flush();
  expect(getByRole("button").getAttribute("data-armed")).toBe("");
  expect(getByRole("button").getAttribute("aria-label")).toBe("Click again to confirm delete");

  await new Promise((resolve) => setTimeout(resolve, 60));
  flush();
  expect(getByRole("button").getAttribute("data-armed")).toBeNull();
  expect(getByRole("button").getAttribute("aria-label")).toBe("Delete");
});

testWithUiKit("a confirm fires exactly once, even when its callback unmounts the control", () => {
  // The shape every real call site has: `onConfirm` removes the row, so the
  // second click disposes the very component handling it. The count is the
  // assertion — a disarm that ran after the callback instead of before it could
  // re-enter here.
  let confirms = 0;
  let dispose!: () => void;
  const rendered = render(() => (
    <ConfirmDelete
      onConfirm={() => {
        confirms += 1;
        dispose();
      }}
    />
  ));
  dispose = rendered.unmount;
  flush();

  const button = rendered.getByRole("button");
  button.click();
  flush();
  expect(button.getAttribute("data-armed")).toBe("");

  button.click();
  flush();
  expect(confirms).toBe(1);
});

testWithUiKit("the first click never confirms", () => {
  let confirms = 0;
  const { getByRole } = render(() => <ConfirmDelete onConfirm={() => confirms++} />);
  flush();
  getByRole("button").click();
  flush();
  expect(confirms).toBe(0);
  getByRole("button").click();
  flush();
  expect(confirms).toBe(1);
});
