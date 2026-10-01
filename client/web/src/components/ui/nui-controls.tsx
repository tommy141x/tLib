// The checkbox and the slider, drawn once for every surface tLib has: one box,
// one glyph, one --nui-* theming contract shared between here and nui.css.
//
// The interaction is deliberately not shared. The menu is server-authoritative
// and driven by keyboard and controller through Menu.tsx's navigateCommand; a
// row is a single <button> whose value only the row changes. Wrapping a row in
// Ark's Checkbox.Root or Slider.Root would nest a focusable element inside that
// button — invalid content, and it breaks the navigation model. So the menu
// takes the rendered control and its theming and keeps aria-pressed, the draft
// and pending flow, onCycle and changeSlider for itself.

import Check from "lucide-solid/icons/check";
import { type JSX, Show, splitProps } from "solid-js";
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
  const [local, rest] = splitProps(props, ["fill", "color", "class", "style"]);
  return (
    <input
      {...rest}
      type="range"
      class={`tlib-nui-control tlib-nui-range${local.class ? ` ${local.class}` : ""}`}
      style={{
        "--nui-range-fill": `${Math.max(0, Math.min(1, local.fill)) * 100}%`,
        ...(local.color ? { "--nui-range-color": local.color } : {}),
        ...(typeof local.style === "object" ? local.style : {}),
      }}
    />
  );
}

/** Shared so the two readouts never disagree about width, alignment or numeral
 *  shaping. */
export function NuiRangeValue(props: { children: JSX.Element }) {
  return <output class="tlib-nui-slider-value">{props.children}</output>;
}
