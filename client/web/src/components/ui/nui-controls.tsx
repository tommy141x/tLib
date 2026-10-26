// The menu-row control set — the single permitted exception to the no-component-library
// rule for `internal/shared-ts/ui/*`. A checkbox box and range input, drawn once with
// one --nui-* theming contract shared with nui.css, deliberately with no interaction of
// their own: a menu row is a single <button> driven by Menu.tsx's navigateCommand, and
// wrapping it in Ark's Checkbox.Root/Slider.Root would nest a focusable element inside that
// button, breaking the navigation model. Anything that is not a menu row uses
// `internal/shared-ts/ui/*` instead of adding a control here.

import type { JSX } from "@solidjs/web";
import Check from "lucide-solid/icons/check";
import { omit, Show } from "solid-js";
import "../../../../../shared/ts/nui-kit/nui.css";

/** Shared with Ark's Checkbox.Control, which wears the same class. */
export const NUI_CHECKBOX_CLASS = "tlib-nui-control tlib-nui-checkbox-control";

/** Deep lucide import: the barrel is ~400KB and this module is on the menu's
 *  path. */
export function NuiCheckGlyph() {
  return <Check size={13} strokeWidth={3} />;
}

/** Presentational only — no interaction, no focus of its own. `data-state` is
 *  the attribute Ark sets, so one CSS rule dresses this and the dialog's. */
export function NuiCheckbox(props: { checked: boolean; class?: string }) {
  return (
    <span
      class={`${NUI_CHECKBOX_CLASS}${props.class ? ` ${props.class}` : ""}`}
      data-state={props.checked ? "checked" : "unchecked"}
      aria-hidden="true"
    >
      <Show when={props.checked}>
        <span class="tlib-nui-checkbox-indicator">
          <NuiCheckGlyph />
        </span>
      </Show>
    </span>
  );
}

/** A native range input dressed as Ark's slider. Native for the reason above:
 *  it is the one shape that stays keyboard-reachable without adding a focusable
 *  widget the menu's navigation does not know about.
 *
 *  `fill` is the filled share, 0-1, applied through a custom property so a row
 *  overriding the bar colour sets one token instead of the whole gradient. */
export function NuiRange(
  props: JSX.InputHTMLAttributes<HTMLInputElement> & { fill: number; color?: string }
) {
  // `omit` is Solid 2's `splitProps`, and it returns the REST BAG ALONE rather
  // than a [local, rest] pair. There are no defaults to merge in here, so the
  // four extracted keys are simply read back off `props`, which is still the
  // live, reactive source for them.
  const rest = omit(props, "fill", "color", "class", "style");
  return (
    <input
      {...rest}
      type="range"
      // Array form, not a template literal: UnoCSS tokenises `foo${` as two
      // broken candidates, so a utility immediately before an interpolation is
      // never extracted. These are hand-written `tlib-` classes rather than
      // utilities, but the form is the house rule because the failure is silent.
      class={["tlib-nui-control tlib-nui-range", props.class]}
      style={{
        "--nui-range-fill": `${Math.max(0, Math.min(1, props.fill)) * 100}%`,
        ...(props.color ? { "--nui-range-color": props.color } : {}),
        ...(typeof props.style === "object" ? props.style : {}),
      }}
    />
  );
}

/** Shared so the two readouts never disagree about width, alignment or numeral
 *  shaping. */
export function NuiRangeValue(props: { children: JSX.Element }) {
  return <output class="tlib-nui-slider-value">{props.children}</output>;
}
