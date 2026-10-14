import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import { For, Show } from "solid-js";

/**
 * A two-or-three-way choice between MODES, as one track of pressed buttons.
 *
 * Why this is not `ui/radio-group`
 *
 * It replaces one, for two reasons.
 *
 * Mechanically: `RadioGroupItem` hardcodes `text-sm` on its own `ItemText`, so a
 * `!text-[11px]` the caller passes lands on the Item wrapper and never reaches the
 * label. A "Literal text / Live value" row rendered at 14px with a 16px indicator
 * circle beside 11px monospace captions, and read as an unstyled form control
 * dropped into a dense panel. That was the reported symptom.
 *
 * Semantically: a radio group is a choice between MEMBERS of a set. What this
 * chooses is which of two mutually exclusive MODES something is in, where each
 * mode swaps the control below it. A segmented control is the established form for
 * that, and it is what the toolbars in these editors already looked like.
 *
 * Styling is `.segment` / `.segment-track` from `@tlib/shared/css/surface.css`.
 *
 * `aria-pressed` rather than `role="radio"`: these are buttons, and `aria-pressed`
 * is both what a screen reader needs and what the CSS selects on, so the styled
 * state and the announced state cannot disagree.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: () => JSX.Element;
  /** Shown as `title`, and the reason a disabled segment is disabled. */
  hint?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>(props: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  class?: string;
}) {
  return (
    // A `<fieldset>`, not a `<div role="group">`. Same semantics, and it is the
    // element the role exists to stand in for — `min-w-0` because a fieldset's
    // `min-inline-size: min-content` default would stop the track shrinking inside
    // a flex row.
    <fieldset class={cn("segment-track m-0 min-w-0", props.class)} aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="segment"
            title={option.hint}
            aria-pressed={props.value === option.value ? "true" : "false"}
            aria-disabled={option.disabled === true ? "true" : "false"}
            onClick={() => {
              if (option.disabled) return;
              if (props.value === option.value) return;
              props.onChange(option.value);
            }}
          >
            <Show when={option.icon}>{(icon) => icon()()}</Show>
            {option.label}
          </button>
        )}
      </For>
    </fieldset>
  );
}

export default Segmented;
