/**
 * `shared/ts/solid-compat/solid-1-compat-web.ts`'s `spread` maps Solid 1's
 * signature onto Solid 2's, and the two disagree in position and meaning:
 *
 *   Solid 1:  spread(node, accessor, isSVG?, skipChildren?)
 *   Solid 2:  spread(node, accessor, skipChildren?, skip?, name?)
 *
 * Solid 1's boolean 4th arg lands in Solid 2's `skip`, a predicate called as
 * `skip("children")` — the one live caller is
 * `lucide-solid/dist/esm/Icon.mjs:37`: `spread(_el$, mergeProps(...), true, true)`.
 * A missing mapping throws `TypeError: skip is not a function` inside a
 * render effect, which halts Solid 2's reactive graph process-wide
 * (`[REACTIVITY_HALTED]`) — measured as an empty container here and a
 * cascade of unrelated-looking failures afterward. This file exists to
 * redden first, by name, instead of nine editor tests saying nothing.
 *
 * Assertions check content, not absence of a throw: a real `<svg>` in the
 * SVG namespace; the attributes `spread` applies (the half `skip` can eat,
 * since `collectProps` calls `skip(prop)` per property); and real child
 * geometry (the half `skipChildren` governs — a missing `<path>` still looks
 * like "an icon rendered" to a check that only counts the `<svg>`).
 *
 * The last test calls the shim's `spread` directly at Solid 1 arity, which
 * the icon tests can't substitute for: `skipChildren` is the one argument a
 * dropped value and a correct value both look right on an icon (lucide
 * inserts children separately either way), so getting it wrong there is
 * silent duplication, not a throw.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
// Imported by the same path a rewritten vendor import resolves to —
// `tests/_setup.ts` rewrites every vendor's `"solid-js/web"` to this exact
// file — so `spread` below is the production-shaped module, not a copy.
import * as shim from "@tlib/shared/solid-compat/solid-1-compat-web";
import { Anchor, Ban } from "lucide-solid";
import { createRoot, createSignal, flush } from "solid-js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const SVG_NS = "http://www.w3.org/2000/svg";

describe("a real lucide-solid icon", () => {
  test("renders an <svg> in the SVG namespace, not an empty container", () => {
    const { container } = render(() => <Anchor />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.namespaceURI).toBe(SVG_NS);
    // The container being empty is the measured symptom of the arity bug, so it
    // is asserted against as its own fact rather than implied by the one above.
    expect(container.innerHTML).not.toBe("");
  });

  test("carries the attributes `spread` is the only thing that applies", () => {
    // `viewBox`, `stroke-width` and the `lucide` class names come out of
    // `buildLucideIconNode`'s attribute object and reach the DOM ONLY through the
    // spread. `collectProps` runs `skip(prop)` per property, so a boolean in
    // Solid 2's `skip` slot takes all of these out together.
    const { container } = render(() => <Anchor />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("class")).toContain("lucide-anchor");
  });

  test("has real child geometry, not just an empty <svg>", () => {
    // The `skipChildren` half. lucide's glyph is a `<For>` of `<Dynamic>` child
    // elements, so an icon can be present and shaped correctly while being
    // visually blank.
    const { container } = render(() => <Anchor />);
    const svg = container.querySelector("svg")!;
    const geometry = svg.querySelectorAll("path, circle, line, rect, polyline, polygon");
    expect(geometry.length).toBeGreaterThan(0);
    for (const node of geometry) expect(node.namespaceURI).toBe(SVG_NS);
  });

  test("children are rendered ONCE — a dropped skipChildren duplicates them", () => {
    // `Ban` is a circle plus one path, chosen because its node list is short
    // enough to count exactly. Solid 1's argument four says "I will insert the
    // children myself"; lucide then does, via `insert(_el$, <For …>)`. Mapping
    // that argument to nothing instead leaves Solid 2 free to insert
    // `props.children` as well, and the glyph is drawn twice.
    const { container } = render(() => <Ban />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelectorAll("circle").length).toBe(1);
    expect(svg.querySelectorAll("path").length).toBe(1);
  });

  test("stays reactive — the graph was not halted", () => {
    // A halted reactive graph is process-wide and permanent, and it does not
    // throw at the assertion that notices it. A signal-driven size on a real icon
    // is the cheapest direct probe: if the icon's own render effect took the
    // graph down, this never updates.
    const [size, setSize] = createSignal(16);
    const { container } = render(() => <Anchor size={size()} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    setSize(32);
    flush();
    expect(svg.getAttribute("width")).toBe("32");
  });
});

describe("the shim's `spread` maps Solid 1's argument list onto Solid 2's", () => {
  // `createRoot`, not a bare call: `spread` installs a render effect, and an
  // effect with no owner is a different Solid 2 code path (warns, never
  // disposed — the owner bug `_setup.ts`'s dedupe block documents). Rooting
  // keeps each case on the path a rendered component takes.
  function spreadInto(...args: unknown[]): SVGElement {
    const node = document.createElementNS(SVG_NS, "svg");
    const dispose = createRoot((d) => {
      (shim.spread as (...a: unknown[]) => void)(node, ...args);
      return d;
    });
    flush();
    dispose();
    return node as SVGElement;
  }

  test("Solid 1's arg 3 (isSVG) is DROPPED, not read as skipChildren", () => {
    // `isSVG: true`, no fourth argument — so `skipChildren` is absent and the
    // children MUST be inserted. Forwarding arg 3 verbatim would land `true` in
    // Solid 2's `skipChildren` and silently drop them.
    const node = spreadInto({ children: "glyph" }, true);
    expect(node.textContent).toBe("glyph");
  });

  test("Solid 1's arg 4 becomes Solid 2's arg 3 (skipChildren)", () => {
    const node = spreadInto({ children: "glyph", "data-x": "1" }, true, true);
    expect(node.textContent).toBe("");
    // …and the non-children properties are still applied, which is what proves
    // the fourth argument did not reach Solid 2's `skip` predicate slot.
    expect(node.getAttribute("data-x")).toBe("1");
  });

  test("a Solid 2 caller's predicate 4th argument is forwarded verbatim", () => {
    // Unreachable through the plugin — this module is only resolved for the
    // `solid-js/web` specifier, which Solid 2 deleted — but handled explicitly
    // rather than silently mis-mapped, because a wrong mapping here would fail
    // quietly. `typeof === "function"` is the discriminator.
    const skipped: string[] = [];
    const skip = (key: string) => {
      skipped.push(key);
      return key === "data-y";
    };
    const node = spreadInto({ "data-x": "1", "data-y": "2" }, false, skip);
    expect(skipped).toContain("data-y");
    expect(node.getAttribute("data-x")).toBe("1");
    expect(node.getAttribute("data-y")).toBeNull();
  });
});
