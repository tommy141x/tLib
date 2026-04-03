import { Checkbox as ArkCheckbox } from "@ark-ui/solid";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import { type JSX, Show, splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";
import IconCheck from "~icons/lucide/check";
import IconMinus from "~icons/lucide/minus";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

// Simple Checkbox component - the easy way
interface CheckboxProps {
  children?: JSX.Element;
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean | "indeterminate";
  onCheckedChange?: (details: { checked: boolean | "indeterminate" }) => void;
  disabled?: boolean;
  invalid?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  class?: string;
}

export const Checkbox = (
  props: CheckboxProps & { size?: "sm" | "md" | "lg" },
) => {
  const [local, others] = splitProps(props, ["children", "class", "size"]);

  const sizes = {
    sm: { control: "h-4 w-4", icon: "h-3 w-3", label: "text-sm" },
    md: { control: "h-5 w-5", icon: "h-4 w-4", label: "text-base" },
    lg: { control: "h-6 w-6", icon: "h-5 w-5", label: "text-lg" },
  };

  const currentSize = sizes[local.size || "md"];

  return (
    <ArkCheckbox.Root
      class={cn("flex items-center gap-2", local.class)}
      {...others}
    >
      <ArkCheckbox.Control
        class={cn(
          "peer shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-all duration-200 ease-out hover:border-ring hover:shadow-sm",
          currentSize.control,
        )}
      >
        <ArkCheckbox.Indicator class="flex items-center justify-center w-full h-full transition-all duration-200 ease-out data-[state=checked]:animate-in data-[state=checked]:fade-in data-[state=checked]:zoom-in-50 [&[hidden]]:hidden">
          <IconCheck class={currentSize.icon} />
        </ArkCheckbox.Indicator>
      </ArkCheckbox.Control>
      <Show when={local.children}>
        <ArkCheckbox.Label
          class={cn(
            "font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 transition-colors duration-150 cursor-pointer select-none",
            currentSize.label,
          )}
        >
          {local.children}
        </ArkCheckbox.Label>
      </Show>
      <ArkCheckbox.HiddenInput />
    </ArkCheckbox.Root>
  );
};

// Composable API for advanced usage
export const CheckboxRoot = ArkCheckbox.Root;
export const CheckboxLabel = (props: {
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ArkCheckbox.Label
      class={cn(
        "text-base font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 transition-colors duration-150 cursor-pointer select-none",
        local.class,
      )}
      {...others}
    />
  );
};

export const CheckboxControl = (props: {
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ArkCheckbox.Control
      class={cn(
        "peer h-5 w-5 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-all duration-200 ease-out hover:border-ring hover:shadow-sm",
        local.class,
      )}
      {...others}
    />
  );
};

export const CheckboxIndicator = (props: {
  indeterminate?: boolean;
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, [
    "class",
    "children",
    "indeterminate",
  ]);
  return (
    <ArkCheckbox.Indicator
      indeterminate={local.indeterminate}
      class={cn(
        "flex items-center justify-center w-full h-full transition-all duration-200 ease-out data-[state=checked]:animate-in data-[state=checked]:fade-in data-[state=checked]:zoom-in-50 data-[state=indeterminate]:animate-in data-[state=indeterminate]:fade-in data-[state=indeterminate]:zoom-in-50 [&[hidden]]:hidden",
        local.class,
      )}
      {...others}
    >
      {local.children || (
        <Show
          when={local.indeterminate}
          fallback={<IconCheck class="h-4 w-4" />}
        >
          <IconMinus class="h-4 w-4" />
        </Show>
      )}
    </ArkCheckbox.Indicator>
  );
};

export const CheckboxHiddenInput = ArkCheckbox.HiddenInput;

// CheckboxGroup for multiple checkboxes
interface CheckboxGroupProps {
  children?: JSX.Element;
  class?: string;
}

export const CheckboxGroup = (
  props: CheckboxGroupProps & Omit<ArkCheckbox.GroupProps, "class">,
) => {
  const [local, others] = splitProps(props, ["class"]);

  return (
    <ArkCheckbox.Group
      class={cn("flex flex-col gap-2", local.class)}
      {...others}
    />
  );
};

export default Checkbox;
