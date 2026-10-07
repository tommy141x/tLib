/**
 * Deliberately-wrong fixture for `scripts/boolean-attr-selector-scan.ts`.
 *
 * ⚠️ DO NOT "FIX" THIS FILE. Every defect in it is load-bearing. It is not
 * imported, not built, not type-checked against the app and renders nothing;
 * it exists so that a drifted scanner rule FAILS instead of reporting zero.
 *
 * The scanner requires all four verdicts to come out of this one file:
 *
 *   dead           `data-ctl-dead`   selector `="true"` + a boolean binding
 *                  `data-ctl-gone`   selector `="false"` + a boolean binding
 *                  `aria-ctl-raw`    aria selector + a RAW boolean binding
 *   correct        `data-ctl-ok`     selector `="true"` + a string binding
 *                  `data-ctl-imp`    selector `="true"` + a dataset write
 *   unknown        `data-ctl-opaque` selector `="true"` + an unprovable binding
 *   never-emitted  `data-ctl-ghost`  selector `="true"` + no producer anywhere
 *
 * The map is per-attribute and exact: a drifted rule has to turn a NAMED line
 * red. "all four verdicts appeared" was the first version and is satisfiable by
 * accident — one rule covers for another and the count still looks right.
 *
 * `data-ctl-dead` and `data-ctl-gone` additionally appear in BOTH spellings — a
 * plain selector in `CONTROL_SELECTORS` and an UnoCSS variant in
 * `CONTROL_CLASSES` — and the scanner requires both readers to find them.
 * Deleting the variant reader outright left the control at 7/7 and the run
 * green, because every attribute here was also reachable through the plain
 * selector. The variant form is the one that matters most in this codebase:
 * `data-[active=true]:` lives in a class string, with no stylesheet to read.
 *
 * If any of this stops being produced, the scanner exits 2 and says so. A zero
 * from a rule that no longer matches is indistinguishable from a clean tree, and
 * that indistinguishability is exactly how the original defect shipped.
 *
 * Both halves of the defect are covered on purpose. The `="false"` half is the
 * quieter one: it reads as a deliberate negative state, but Solid 2 REMOVES the
 * attribute on `false`, so there is no value left for the selector to match.
 */

// biome-ignore-all lint: a deliberately-Solid-1-shaped fixture, never rendered.

/* Selector sites. Written as querySelector strings rather than in a .css file
   so the fixture is ONE file — the scanner reads selectors out of .ts/.tsx and
   .css identically, and a two-file control is two things to drift apart. */
export const CONTROL_SELECTORS = [
  ".ctl[data-ctl-dead='true']",
  ".ctl[data-ctl-gone='false']",
  ".ctl[aria-ctl-raw='true']",
  ".ctl[data-ctl-ok='true']",
  ".ctl[data-ctl-imp='true']",
  ".ctl[data-ctl-opaque='true']",
  ".ctl[data-ctl-ghost='true']",
];

/** The UnoCSS variant spelling of the same mistake, including the group form. */
export const CONTROL_CLASSES =
  "data-[ctl-dead=true]:opacity-100 group-data-[ctl-gone=false]/ctl:hidden";

export function ControlFixture(props: {
  flag: boolean;
  label: string;
  passthrough?: string;
  ["data-ctl-opaque"]?: string;
}) {
  const open = () => props.flag;
  return (
    <div class="ctl">
      {/* DEAD: a boolean reaches the DOM as "" under Solid 2. */}
      <span data-ctl-dead={open() && props.label !== ""} />
      {/* DEAD, the false half: `false` removes the attribute outright. */}
      <span data-ctl-gone={!open()} />
      {/* DEAD on aria too: `aria-x=""` is invalid ARIA and matches no `="true"`. */}
      <span aria-ctl-raw={!!props.flag} />
      {/* CORRECT: the value reaching the DOM is a string. Not a finding. */}
      <span data-ctl-ok={open() ? "true" : undefined} />
      {/* UNKNOWN: a pass-through. The scanner must say it cannot prove this
          rather than guess, so the report stays trustworthy. */}
      <span data-ctl-opaque={props["data-ctl-opaque"]} />
    </div>
  );
}

/** CORRECT: an imperative write is a real string, whatever the condition was. */
export function latch(el: HTMLElement, on: boolean) {
  el.dataset.ctlImp = on ? "true" : "false";
}

/* `data-ctl-ghost` is referenced by CONTROL_SELECTORS above and produced by
   NOTHING. That selector has never matched and never will, which is a finding
   to report — not a selector to rewrite until it matches something that was
   never there. */
