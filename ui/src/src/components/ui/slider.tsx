import { Slider as ArkSlider } from "@ark-ui/solid/slider";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

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
  name?: string;
  form?: string;
  id?: string;
  "aria-label"?: string[];
  "aria-labelledby"?: string[];
  class?: string;
  label?: JSX.Element;
  showValue?: boolean;
};

export const Slider: Component<SliderProps> = (props) => {
  const thumbCount = props.defaultValue?.length || props.value?.length || 1;

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
      name={props.name}
      form={props.form}
      id={props.id}
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      class={cn("relative flex flex-col gap-2 w-full", props.class)}
    >
      {(props.label || props.showValue) && (
        <div class="flex items-center justify-between">
          {props.label && (
            <ArkSlider.Label class="text-sm font-medium leading-none">
              {props.label}
            </ArkSlider.Label>
          )}
          {props.showValue && <ArkSlider.ValueText class="text-sm text-muted-foreground" />}
        </div>
      )}
      <ArkSlider.Control class="relative flex items-center w-full touch-none select-none">
        <ArkSlider.Track class="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
          <ArkSlider.Range class="absolute h-full bg-primary data-disabled:opacity-50" />
        </ArkSlider.Track>
        <ArkSlider.Thumb
          index={0}
          class="absolute block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <ArkSlider.HiddenInput />
        </ArkSlider.Thumb>
        {thumbCount >= 2 && (
          <ArkSlider.Thumb
            index={1}
            class="absolute block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            <ArkSlider.HiddenInput />
          </ArkSlider.Thumb>
        )}
        {thumbCount >= 3 && (
          <ArkSlider.Thumb
            index={2}
            class="absolute block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            <ArkSlider.HiddenInput />
          </ArkSlider.Thumb>
        )}
      </ArkSlider.Control>
    </ArkSlider.Root>
  );
};

export default Slider;
