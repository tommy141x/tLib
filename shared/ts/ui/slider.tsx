import { Slider as ArkSlider } from "@ark-ui/solid/slider";
import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import { type Component, Show } from "solid-js";

/**
 * The range control.
 *
 * Four things here were learned in a consumer and promoted back
 *
 * 1. **`thumbCount` is an accessor.** It was a plain `const` read in the component
 *    body, and a Solid body runs exactly once — so a slider that gained a second
 *    value after mount never grew its second thumb. tRadio hit this and fixed it
 *    locally; the fix lives here now, with the extra thumbs behind `Show` rather
 *    than a `&&` so the condition is actually tracked.
 *
 * 2. **No `id` is forwarded to the Ark Root.** Putting a raw id on an Ark part
 *    replaces the one zag generated, after which the machine cannot find its own
 *    element and the keyboard and pointer wiring fails silently. Ark's own escape
 *    hatch is the Root's `ids` prop, which is what is exposed.
 *
 * 3. **`srLabel` exists because Ark names the thumb from `Slider.Label`.** A
 *    slider rendered with the visible label outside this component exposed its
 *    thumb with no accessible name at all — measured as three unlabelled inputs
 *    per panel in tAFK. It renders screen-reader-only, so it names the control
 *    without drawing anything, and is ignored when a real `label` is given.
 *
 * 4. **The thumb's hit target is larger than the thumb.** The drawn thumb is below
 *    the 24px target WCAG 2.2 SC 2.5.8 asks for, and the spacing exception does not
 *    rescue a stacked column of them. A pseudo-element carries the remaining area —
 *    it is part of the thumb for hit-testing and draws nothing.
 *
 * `size` picks the drawn thumb only; both tiers keep the full 24px target.
 */

const THUMB_BASE =
  "absolute block rounded-full border-2 border-primary bg-background transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:-outline-offset-1 disabled:pointer-events-none disabled:opacity-50 after:absolute after:left-1/2 after:top-1/2 after:h-6 after:w-6 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:content-['']";

const THUMB_SIZES = {
  sm: "h-4 w-4",
  default: "h-5 w-5",
} as const;

type SliderProps = {
  defaultValue?: number[];
  value?: number[];
  onValueChange?: (details: { value: number[] }) => void;
  onValueChangeEnd?: (details: { value: number[] }) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  readOnly?: boolean;
  orientation?: "horizontal" | "vertical";
  origin?: "start" | "center" | "end";
  thumbAlignment?: "contain" | "center";
  name?: string;
  form?: string;
  /** Ark's own id escape hatch. Never put a raw `id` on one of its parts. */
  ids?: ArkSlider.RootProps["ids"];
  "aria-label"?: string[];
  "aria-labelledby"?: string[];
  class?: string;
  label?: JSX.Element;
  showValue?: boolean;
  size?: keyof typeof THUMB_SIZES;
  /** Names the thumb when the visible label is rendered outside this component. */
  srLabel?: string;
};

export const Slider: Component<SliderProps> = (props) => {
  const thumbCount = () => props.value?.length ?? props.defaultValue?.length ?? 1;
  const thumbClass = () => cn(THUMB_BASE, THUMB_SIZES[props.size ?? "default"]);

  return (
    <ArkSlider.Root
      defaultValue={props.defaultValue}
      value={props.value}
      onValueChange={props.onValueChange}
      onValueChangeEnd={props.onValueChangeEnd}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      readOnly={props.readOnly}
      orientation={props.orientation}
      origin={props.origin}
      thumbAlignment={props.thumbAlignment}
      name={props.name}
      form={props.form}
      ids={props.ids}
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      class={cn("relative flex flex-col gap-2 w-full", props.class)}
    >
      <Show when={props.srLabel && !props.label}>
        <ArkSlider.Label class="sr-only">{props.srLabel}</ArkSlider.Label>
      </Show>
      <Show when={props.label || props.showValue}>
        <div class="flex items-center justify-between">
          <Show when={props.label}>
            <ArkSlider.Label class="text-sm font-medium leading-none">
              {props.label}
            </ArkSlider.Label>
          </Show>
          <Show when={props.showValue}>
            <ArkSlider.ValueText class="text-sm text-muted-foreground" />
          </Show>
        </div>
      </Show>
      <ArkSlider.Control class="relative flex items-center w-full touch-none select-none">
        <ArkSlider.Track class="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
          <ArkSlider.Range class="absolute h-full bg-primary data-[disabled]:opacity-50" />
        </ArkSlider.Track>
        <ArkSlider.Thumb index={0} class={thumbClass()}>
          <ArkSlider.HiddenInput />
        </ArkSlider.Thumb>
        <Show when={thumbCount() >= 2}>
          <ArkSlider.Thumb index={1} class={thumbClass()}>
            <ArkSlider.HiddenInput />
          </ArkSlider.Thumb>
        </Show>
        <Show when={thumbCount() >= 3}>
          <ArkSlider.Thumb index={2} class={thumbClass()}>
            <ArkSlider.HiddenInput />
          </ArkSlider.Thumb>
        </Show>
      </ArkSlider.Control>
    </ArkSlider.Root>
  );
};

export default Slider;
