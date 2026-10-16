/**
 * `ExportBadge`, rendered — the convergence this file exists to prove.
 *
 * What was unproven before it
 *
 * All of it, in both resources. The Discovery export control was written twice
 * (tELS, 164 lines on the shared kit; tRadio, 278 lines with five raw
 * `<button>`s) and between the two copies there was a typecheck, a dead-class
 * scan and a Vite build. Nothing clicked the trigger, nothing clicked a target,
 * nothing pressed Escape, and nothing noticed that four of tRadio's five
 * buttons and tELS's trigger painted no focus affordance at all.
 *
 * That is the whole reason a convergence is worth testing rather than merely
 * reviewing: the two copies were REVIEWED, repeatedly, and the review is what
 * produced two of them.
 *
 * Not provable here, said plainly
 *
 *  - **That the focus outline PAINTS.** happy-dom has no layout and no paint, so
 *    `scripts/probe-focus-paint.ts` — which measures pixels in the pinned
 *    Chromium 103 — remains the only thing that can. What is asserted below is
 *    the four tokens being present TOGETHER and the offset being the negative
 *    spelling, which is exactly the shape `unocss-merge` 0.10.0 silently breaks
 *    and which no other check in the repo can see (every class involved is real
 *    and resolves to CSS; only the merged output is wrong).
 *  - **That the sizes are legible in CEF, or that `--tlib-pe-u` resolves.** Both
 *    pixel questions. What IS asserted is the absence of an arbitrary
 *    `text-[Npx]` beside a text colour, which is the `unoMerge` collision the
 *    sizes were moved into `export-badge.css` to make structurally impossible.
 *  - **That Ark's popover positions itself.** No layout. Its OPEN/CLOSED
 *    behaviour, which is what the hand-rolled copy got wrong, is driven below.
 */

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createEscapeLayer, escapeLayers } from "../../../shared/ts/escape-layer";
import type {
  ExportBadgeStringKey,
  ExportTarget,
} from "../../../internal/shared-ts/ui/export-badge";

// The control kit moved to `internal/`, which publish-public.ts strips. This
// file stays in the published half for the reason prop-editor-guard.test.tsx
// gives: the DOM harness it needs -- happy-dom, @solidjs/testing-library and
// the dedupe rewrite in `_setup.ts` -- is a client/web devDependency, and a
// second copy of it under internal/ would be two harnesses to keep in step. So
// the suite declares that the private half may be absent instead.
//
// A STATIC import fails at module load in a public clone and takes the whole
// file with it, so the kit is awaited below. The `import type` beside it is
// erased before runtime and so cannot.
const HAS_UI_KIT = existsSync(new URL("../../../internal/shared-ts/ui/export-badge.tsx", import.meta.url));
const describeWithUiKit = HAS_UI_KIT ? describe : describe.skip;
const { DEFAULT_EXPORT_BADGE_STRINGS, ExportBadge } = HAS_UI_KIT
  ? await import("../../../internal/shared-ts/ui/export-badge")
  : {
      DEFAULT_EXPORT_BADGE_STRINGS: {} as never,
      ExportBadge: (() => null) as never,
    };

/** The shape `inst:getExportTargets()` really answers with, first row first. */
const TARGETS: ExportTarget[] = [
  { name: "tRadio", hasMetadata: true, isLocal: true },
  { name: "mrp_vehicles", hasMetadata: true },
  { name: "pd_pack_liveries", hasMetadata: true },
  { name: "ambulancejob", hasMetadata: false },
];

interface Harness {
  container: HTMLElement;
  requested: number;
  exported: string[];
}

let calls: { requested: number; exported: string[] };

beforeEach(() => {
  calls = { requested: 0, exported: [] };
});

afterEach(() => {
  cleanup();
  // The escape registry is a page-wide singleton, so a layer or guard left
  // behind by one test resolves against the next one's presses.
  escapeLayers().reset();
  document.body.innerHTML = "";
});

/** Let happy-dom's event queue drain, then let Solid settle. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

async function mount(props: Partial<Parameters<typeof ExportBadge>[0]> = {}): Promise<Harness> {
  const { container } = render(() => (
    <ExportBadge
      targets={props.targets ?? TARGETS}
      externalSource={props.externalSource}
      showLabel={props.showLabel}
      edge={props.edge}
      translate={props.translate}
      class={props.class}
      onRequestTargets={() => {
        calls.requested++;
      }}
      onExport={(name) => {
        calls.exported.push(name);
      }}
    />
  ));
  await settle();
  return {
    container,
    get requested() {
      return calls.requested;
    },
    get exported() {
      return calls.exported;
    },
  };
}

const q = <T extends Element = HTMLElement>(c: ParentNode, sel: string) =>
  c.querySelector(sel) as T | null;

/**
 * The trigger, by its own hook rather than by shape.
 *
 * `querySelector("button")` would work here and is WRONG as an identity, which is the
 * finding that put `data-export-trigger` on the component. `propeditor-gallery.ts` found
 * this control as "the button with an svg and no text inside the editor", and that
 * stopped being unique when the shared `PropEditor`'s toolbar gained an icon-only
 * undo/redo pair ahead of the slot — so the gallery was clicking undo.
 */
const trigger = (c: HTMLElement) =>
  c.querySelector("button[data-export-trigger]") as HTMLButtonElement;

/**
 * The picker, and only while it is OPEN.
 *
 * `[data-state="open"]` IS REQUIRED and this is measured, not defensive.
 * Ark's popover content is NOT lazily mounted: the panel, the filter box and
 * every target row are in the document while the picker is closed, merely
 * `hidden` and marked `data-state="closed"`. A helper that matched the part
 * alone found four target rows before the trigger had ever been clicked, which
 * would have made "Confirm closes the picker" assert against a panel that is
 * always there.
 *
 * Note the value is a real string, not a boolean — Solid 2 writes a boolean
 * `true` as the EMPTY string, so a `[data-x="true"]` form would be dead. This
 * attribute is Ark's own and carries `"open"`/`"closed"`.
 *
 * Queried from `document` rather than from the container so a future move of
 * `PopoverContent` into a `Portal` does not quietly make everything vacuous.
 */
/*
 * `[data-popover-content]`, not zag 1's `[data-scope]`/`[data-part]` pair: zag 2's
 * createAnatomy emits one `data-<scope>-<part>` attribute. All fifteen tests here
 * failed on the old selector with "Received: null" from `openPicker`, which reads
 * as "the picker never opens". `data-state="open"` is unchanged.
 */
const panel = () =>
  document.querySelector('[data-popover-content][data-state="open"]') as HTMLElement | null;

/** The filter field, found by ELEMENT so its `type` attribute stays assertable. */
const filterBox = () => (panel()?.querySelector("input") ?? null) as HTMLInputElement | null;

const rows = () => [
  ...(panel()?.querySelectorAll<HTMLButtonElement>("button[data-export-target]") ?? []),
];

async function openPicker(h: Harness) {
  trigger(h.container).click();
  await settle();
  return panel();
}

function pressEscape(target: EventTarget = document.body) {
  const down = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(up);
  flush();
  return down;
}

describeWithUiKit("the badge at rest", () => {
  test("renders a trigger, no source chip, and a closed picker", async () => {
    const h = await mount();
    expect(trigger(h.container)).not.toBeNull();
    expect(q(h.container, ".tlib-export-chip")).toBeNull();
    expect(panel()).toBeNull();
    expect(rows()).toHaveLength(0);
    // Nothing is requested until the picker opens: a resource can start or stop
    // between two openings, so a list fetched at mount is a list that lies.
    expect(h.requested).toBe(0);
  });

  test("the source chip names the resource the config came from", async () => {
    const h = await mount({ externalSource: "mrp_vehicles" });
    const chip = q(h.container, ".tlib-export-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("mrp_vehicles");
  });

  test("the trigger is icon-only by default and labelled on request", async () => {
    const bare = await mount();
    expect(trigger(bare.container).textContent?.trim()).toBe("");
    cleanup();
    const labelled = await mount({ showLabel: true });
    expect(labelled.container.textContent).toContain("Export");
  });

  test("the trigger carries its own identity hook, not a glyph shape", async () => {
    // What `propeditor-gallery.ts` now clicks. Asserted as PRESENCE, because
    // Solid 2 writes a boolean `true` as the EMPTY string — a `[data-x="true"]`
    // reading of this would be dead. It is written as `""` for that reason.
    const h = await mount();
    const hooks = h.container.querySelectorAll("button[data-export-trigger]");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.getAttribute("data-export-trigger")).toBe("");
  });

  test("an icon-only trigger still has an accessible name", async () => {
    // The whole point of adding `aria-label` to the shared `PopoverTrigger`.
    // `title` alone is a hover affordance, and in the game the cursor is the
    // game's — there is no OS tooltip layer to surface it.
    const h = await mount();
    const t = trigger(h.container);
    expect(t.getAttribute("aria-label")).toBe(DEFAULT_EXPORT_BADGE_STRINGS.export_title);
    expect(t.getAttribute("title")).toBe(t.getAttribute("aria-label"));
  });

  test("`edge` defaults to top and is a presence-safe string, not a boolean", async () => {
    // Solid 2 writes a boolean `true` as the EMPTY string, so a boolean-backed
    // `[data-x="true"]` selector is dead. `data-edge` carries a string union for
    // that reason and `export-badge.css` selects on the VALUE.
    const top = await mount();
    expect(q(top.container, ".tlib-export-badge")!.getAttribute("data-edge")).toBe("top");
    cleanup();
    const bottom = await mount({ edge: "bottom" });
    expect(q(bottom.container, ".tlib-export-badge")!.getAttribute("data-edge")).toBe("bottom");
  });

  test("a caller's class is appended rather than replacing the recipe", async () => {
    const h = await mount({ class: "ml-auto" });
    const cls = q(h.container, ".tlib-export-badge")!.getAttribute("class")!;
    expect(cls).toContain("ml-auto");
    expect(cls).toContain("tlib-export-badge");
    expect(cls).toContain("items-center");
  });
});

describeWithUiKit("the picker", () => {
  test("opening it asks the host for targets, exactly once", async () => {
    const h = await mount();
    expect(await openPicker(h)).not.toBeNull();
    expect(h.requested).toBe(1);
  });

  test("the filter box carries an explicit type attribute", async () => {
    // NOT COSMETIC. `tRadio/scripts/propeditor-gallery.ts` identifies the open
    // picker with `input[type="text"]`, an ATTRIBUTE selector that the implicit
    // default does not satisfy. tELS's copy omitted the attribute, so adopting
    // that copy verbatim would have silently broken the gallery.
    const h = await mount();
    await openPicker(h);
    expect(filterBox()).not.toBeNull();
    // Found by element above, so this reads the attribute rather than assuming
    // the selector that found it.
    expect(filterBox()!.getAttribute("type")).toBe("text");
    expect(panel()!.querySelectorAll('input[type="text"]')).toHaveLength(1);
  });

  test("every target is a row, with the owner first and suffixed", async () => {
    const h = await mount();
    await openPicker(h);
    expect(rows().map((r) => r.dataset.exportTarget)).toEqual([
      "tRadio",
      "mrp_vehicles",
      "pd_pack_liveries",
      "ambulancejob",
    ]);
    expect(rows()[0]!.textContent).toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_local_suffix);
    expect(rows()[1]!.textContent).not.toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_local_suffix);
  });

  test("a resource with no metadata key still gets a gutter, so the names line up", async () => {
    const h = await mount();
    await openPicker(h);
    // Three branches: the owner, a declaring resource, and one that does not.
    // The third renders a spacer rather than nothing — without it the names in
    // that row sit 10px left of every other row's.
    const last = rows().at(-1)!;
    expect(last.querySelector(".tlib-export-row-gutter")).not.toBeNull();
    expect(rows()[1]!.querySelector(".tlib-export-row-gutter")).toBeNull();
  });

  test("the filter narrows the list, case-insensitively", async () => {
    const h = await mount();
    await openPicker(h);
    const box = filterBox()!;
    box.value = "PACK";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(rows().map((r) => r.dataset.exportTarget)).toEqual(["pd_pack_liveries"]);
    box.value = "zzz";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(rows()).toHaveLength(0);
    expect(panel()!.textContent).toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_no_resources);
  });

  test("the list is capped at 30 rows, filtered or not", async () => {
    const many: ExportTarget[] = Array.from({ length: 45 }, (_v, i) => ({
      name: `res_${String(i).padStart(2, "0")}`,
      hasMetadata: false,
    }));
    const h = await mount({ targets: many });
    await openPicker(h);
    expect(rows()).toHaveLength(30);
    const box = filterBox()!;
    box.value = "res_";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(rows()).toHaveLength(30);
  });

  test("reopening clears the filter and any half-made decision", async () => {
    const h = await mount();
    await openPicker(h);
    filterBox()!.value = "amb";
    filterBox()!.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    rows()[0]!.click();
    await settle();
    expect(panel()!.textContent).toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_confirm_prefix);
    trigger(h.container).click(); // closes
    await settle();
    trigger(h.container).click(); // reopens
    await settle();
    expect(filterBox()!.value).toBe("");
    expect(rows()).toHaveLength(TARGETS.length);
    expect(h.requested).toBe(2);
  });
});

describeWithUiKit("the confirm step", () => {
  test("choosing a target asks rather than exporting", async () => {
    const h = await mount();
    await openPicker(h);
    rows()[1]!.click();
    await settle();
    expect(h.exported).toEqual([]);
    expect(panel()!.textContent).toContain("mrp_vehicles");
    expect(panel()!.textContent).toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_confirm_prefix);
    // The list is GONE, not merely covered: a stacked view is what a dialog
    // would be, and this control is reached from an already-open editor.
    expect(rows()).toHaveLength(0);
    expect(filterBox()).toBeNull();
  });

  test("the lossy answer is on the RIGHT, in source order", async () => {
    // Estate rule. Confirming MOVES this config out of the resource that owns
    // it, so the safe answer leads — and source order IS keyboard order, so
    // nothing may reorder this footer with CSS.
    const h = await mount();
    await openPicker(h);
    rows()[1]!.click();
    await settle();
    const labels = [...panel()!.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual([
      DEFAULT_EXPORT_BADGE_STRINGS.export_cancel_btn,
      DEFAULT_EXPORT_BADGE_STRINGS.export_confirm_btn,
    ]);
  });

  test("Confirm exports that resource and closes the picker", async () => {
    const h = await mount();
    await openPicker(h);
    rows()[2]!.click();
    await settle();
    const confirm = [...panel()!.querySelectorAll("button")].at(-1)!;
    confirm.click();
    await settle();
    expect(h.exported).toEqual(["pd_pack_liveries"]);
    expect(panel()).toBeNull();
  });

  test("Cancel returns to the list and exports nothing", async () => {
    const h = await mount();
    await openPicker(h);
    rows()[2]!.click();
    await settle();
    const cancel = panel()!.querySelector("button") as HTMLButtonElement;
    cancel.click();
    await settle();
    expect(h.exported).toEqual([]);
    expect(rows()).toHaveLength(TARGETS.length);
  });
});

describeWithUiKit("the focus affordance", () => {
  /**
   * THE REGRESSION THIS PINS, and it is the one no other check can see.
   *
   * `presetWind3` compiles `ring-*` to a `box-shadow`, which CEF 103 clips to
   * nothing inside the `overflow: hidden` ancestor both hosts' panels are — so
   * focus must be an `outline`. And an outline assembled through `cn()` loses a
   * token silently: `unocss-merge` 0.10.0 files a POSITIVE outline-offset into
   * the outline COLOUR's group and annihilates one of the pair (`cn.ts`, Gap 4).
   * The negative spelling escapes that, with or without tLib's shield — which is
   * what a SHARED component needs, since tWeb, tCinematics and every
   * `internal/*` project reach `unoMerge` directly.
   *
   * Asserted as the four tokens being present TOGETHER plus the ABSENCE of a
   * positive offset, because the absence is the property that makes it safe.
   */
  function assertOutlineFocus(el: Element, what: string) {
    const cls = el.getAttribute("class") ?? "";
    expect(cls, `${what}: outline width`).toContain("focus-visible:outline-2");
    expect(cls, `${what}: outline style`).toContain("focus-visible:outline-solid");
    expect(cls, `${what}: outline colour`).toContain("focus-visible:outline-ring/40");
    expect(cls, `${what}: inset offset`).toContain("focus-visible:-outline-offset-1");
    // A ring would compile to a box-shadow and paint nothing here.
    expect(cls, `${what}: no ring`).not.toMatch(/(^|[\s:])ring-/);
    // A positive offset is what `unoMerge` eats the colour for.
    expect(cls, `${what}: no positive offset`).not.toMatch(/[\s:]outline-offset-/);
  }

  test("the trigger has one — it did not before, in EITHER resource", async () => {
    // Measured: tELS passed `PopoverTrigger` no focus utility and the shared
    // `PopoverTrigger` declares none, so the first control a player tabs to
    // painted nothing. tRadio's trigger was the one of its five raw buttons
    // that did have the recipe; this is that recipe, now in one place.
    const h = await mount();
    assertOutlineFocus(trigger(h.container), "trigger");
  });

  test("every target row has one — neither copy did", async () => {
    const h = await mount();
    await openPicker(h);
    expect(rows().length).toBeGreaterThan(0);
    for (const row of rows()) assertOutlineFocus(row, `row ${row.dataset.exportTarget}`);
  });

  test("the confirm footer's buttons get theirs from the shared Button", async () => {
    // Not the constant above: these go through `buttonVariants`, whose base
    // carries the identical four tokens. Asserted anyway, because "it comes
    // from the kit" is exactly the claim a regression would falsify.
    const h = await mount();
    await openPicker(h);
    rows()[1]!.click();
    await settle();
    const footer = [...panel()!.querySelectorAll("button")];
    expect(footer).toHaveLength(2);
    for (const b of footer) assertOutlineFocus(b, `footer ${b.textContent?.trim()}`);
  });
});

describeWithUiKit("sizes are classes, not mergeable utilities", () => {
  test("no arbitrary text size anywhere in the badge or its picker", async () => {
    // `unoMerge` files an arbitrary `text-[Npx]` and a text colour into ONE
    // conflict group and drops one of them. tLib's `cn` shields that pair, but
    // a shared component must not rest on the shield — so the sizes live in
    // `export-badge.css` and there is nothing left to collide.
    const h = await mount({ externalSource: "mrp_vehicles" });
    await openPicker(h);
    const elements = [
      ...h.container.querySelectorAll("*"),
      ...(panel()?.querySelectorAll("*") ?? []),
    ];
    const offenders = elements
      .map((el) => el.getAttribute("class") ?? "")
      .filter((cls) => /(^|\s)!?text-\[\d/.test(cls));
    expect(offenders).toEqual([]);
  });

  test("and no inline style object carrying one either", async () => {
    // The copy this replaced declared its metrics as `style={{ "font-size": … }}`.
    // An inline declaration is the highest priority in CSS, so a host could not
    // override the badge's size at all.
    const h = await mount({ externalSource: "mrp_vehicles" });
    await openPicker(h);
    const styled = [
      ...h.container.querySelectorAll("[style]"),
      ...(panel()?.querySelectorAll("[style]") ?? []),
    ].filter((el) => /font-size|padding/.test(el.getAttribute("style") ?? ""));
    expect(styled).toEqual([]);
  });

  test("the chip and the trigger carry their size classes", async () => {
    const h = await mount({ externalSource: "mrp_vehicles" });
    expect(q(h.container, ".tlib-export-chip")).not.toBeNull();
    expect(trigger(h.container).getAttribute("class")).toContain("tlib-export-trigger");
  });
});

describeWithUiKit("Escape", () => {
  /**
   * A LIVE BUG IN tRADIO BEFORE THIS CONVERGENCE, and this block is what
   * names it. Its picker closed through an `onKeyDown` on the filter input that
   * did NOT `preventDefault`, and `PropEditor`'s escape layer leaves
   * `ignoreWhenTyping` at its default — so one press closed the picker AND asked
   * the editor to cancel. "One key press, two dismissals", the failure
   * `shared/ts/escape-layer.ts` exists to end. A press on a target row rather
   * than in the input did not close the picker at all.
   *
   * What fixes it is Ark: zag's dismissable layer calls `preventDefault()` on
   * the Escape keydown, and `defaultPrevented` is exactly the channel the escape
   * registry reads, so it stands down for both halves of the press. An explicit
   * `registerEscapeGuard` was tried here and removed — its control reddened
   * nothing, because Ark had already done the work. `export-ark-escape-off` in
   * `_defects.ts` is the control that CAN reach this, and it reddens both tests
   * below.
   *
   * A host layer at depth 1 is used because that is `PropEditor`'s own depth,
   * which is the real host this control sits inside in tRadio.
   */
  function withHostLayer(): { escapes: () => number; dispose: () => void } {
    let escapes = 0;
    const dispose = createEscapeLayer({
      label: "test-host",
      depth: 1,
      onEscape: () => {
        escapes++;
      },
    });
    return { escapes: () => escapes, dispose };
  }

  // Split into two tests on purpose, because they are two separate claims and
  // one `export-ark-escape-off` run has to be able to say which of them broke.

  test("a press while the picker is open closes the picker", async () => {
    const h = await mount();
    await openPicker(h);
    pressEscape();
    await settle();
    expect(panel()).toBeNull();
  });

  test("and does not ALSO reach the host — one press, one dismissal", async () => {
    /*
     * NO CONTROL IN `_defects.ts` REDDENS THIS ONE, and that is said here
     * rather than left for a reader to assume otherwise.
     *
     * `export-ark-escape-off` was written for it and does not reach it:
     * measured, zag's dismissable layer calls `preventDefault()` on the Escape
     * keydown WHETHER OR NOT `closeOnEscape` is set — the option only decides
     * whether the popover closes, not whether the key is claimed. With it off,
     * `event.defaultPrevented` is still `true` and the registry still stands
     * down, so this assertion stays green while the test above goes red. (The
     * keyup half is NOT prevented, which is why the registry's own
     * `sample.consumed` flag is what protects the one `phase: "keyup"` layer in
     * the tree.)
     *
     * It is therefore an assertion about Ark's behaviour that would catch a zag
     * upgrade changing it, not a proven guard over first-party code. Defeating
     * it would mean not rendering the popover at all, which is not a one-line
     * substitution.
     */
    const host = withHostLayer();
    const h = await mount();
    await openPicker(h);
    pressEscape();
    await settle();
    expect(host.escapes()).toBe(0);
    host.dispose();
  });

  test("and a press while it is CLOSED reaches the host normally", async () => {
    // The half that makes the first one mean something: a control that stood
    // the registry down unconditionally would pass the test above while
    // breaking the editor's own Escape entirely.
    const host = withHostLayer();
    await mount();
    pressEscape();
    expect(host.escapes()).toBe(1);
    host.dispose();
  });

  test("an unmounted badge leaves the host's Escape alone", async () => {
    const host = withHostLayer();
    const h = await mount();
    await openPicker(h);
    cleanup();
    await settle();
    pressEscape();
    expect(host.escapes()).toBe(1);
    host.dispose();
  });
});

describeWithUiKit("strings", () => {
  test("a host translator wins, per key", async () => {
    const translate = (key: ExportBadgeStringKey) =>
      key === "export_no_resources" ? "Rien trouvé" : undefined;
    const h = await mount({ targets: [], translate });
    await openPicker(h);
    expect(panel()!.textContent).toContain("Rien trouvé");
    // Untranslated ids still read as English rather than as a raw key.
    expect(filterBox()!.getAttribute("placeholder")).toBe(
      DEFAULT_EXPORT_BADGE_STRINGS.export_filter_placeholder
    );
  });

  test("an EMPTY translation counts as untranslated", async () => {
    // A locale file with a key present but blank is how a translation is
    // commonly half-done; rendering "" there loses the control entirely.
    const h = await mount({ targets: [], translate: () => "" });
    await openPicker(h);
    expect(panel()!.textContent).toContain(DEFAULT_EXPORT_BADGE_STRINGS.export_no_resources);
  });

  test("every string the control can show has an English default", async () => {
    const keys: ExportBadgeStringKey[] = [
      "export_label",
      "export_title",
      "export_source_tooltip",
      "export_filter_placeholder",
      "export_no_resources",
      "export_local_suffix",
      "export_confirm_prefix",
      "export_cancel_btn",
      "export_confirm_btn",
    ];
    expect(Object.keys(DEFAULT_EXPORT_BADGE_STRINGS).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(DEFAULT_EXPORT_BADGE_STRINGS[key]).not.toBe("");
  });
});
