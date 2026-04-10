import { RadioGroup as ArkRadioGroup } from "@ark-ui/solid/radio-group";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { Motion } from "solid-motionone";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

type RadioGroupProps = {
  children?: JSX.Element;
  value?: string;
  defaultValue?: string;
  onValueChange?: (details: { value: string | null }) => void;
  disabled?: boolean;
  form?: string;
  id?: string;
  ids?: Partial<{
    root: string;
    label: string;
    indicator: string;
    item: (value: string) => string;
    itemLabel: (value: string) => string;
    itemControl: (value: string) => string;
    itemHiddenInput: (value: string) => string;
  }>;
  name?: string;
  orientation?: "horizontal" | "vertical";
  readOnly?: boolean;
  class?: string;
};

export const RadioGroup: Component<RadioGroupProps> = (props) => {
  return <ArkRadioGroup.Root {...props} class={cn("flex flex-col gap-3", props.class)} />;
};

type RadioGroupLabelProps = {
  children?: JSX.Element;
  class?: string;
};

export const RadioGroupLabel: Component<RadioGroupLabelProps> = (props) => {
  return (
    <ArkRadioGroup.Label class={cn("text-sm font-medium leading-none", props.class)} {...props} />
  );
};

type RadioGroupItemProps = {
  value: string;
  children?: JSX.Element;
  class?: string;
  disabled?: boolean;
  invalid?: boolean;
};

export const RadioGroupItem: Component<RadioGroupItemProps> = (props) => {
  return (
    <ArkRadioGroup.Item
      value={props.value}
      disabled={props.disabled}
      invalid={props.invalid}
      class={cn(
        "flex items-center gap-2 cursor-pointer data-disabled:cursor-not-allowed data-disabled:opacity-50",
        props.class
      )}
    >
      <ArkRadioGroup.ItemControl class="relative h-4 w-4 rounded-full border border-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden">
        <ArkRadioGroup.ItemContext>
          {(context) => (
            <>
              {context().checked && (
                <Motion.div
                  class="absolute inset-[2px] rounded-full bg-primary"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{
                    duration: 0.2,
                    easing: [0.16, 1, 0.3, 1],
                  }}
                />
              )}
            </>
          )}
        </ArkRadioGroup.ItemContext>
      </ArkRadioGroup.ItemControl>
      <ArkRadioGroup.ItemText class="text-sm leading-none select-none">
        {props.children}
      </ArkRadioGroup.ItemText>
      <ArkRadioGroup.ItemHiddenInput />
    </ArkRadioGroup.Item>
  );
};

export default RadioGroup;
