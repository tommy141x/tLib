import { Checkbox as ArkCheckbox } from "@ark-ui/solid";
import { cn } from "@tlib/shared/cn";
import { type JSX, Show, splitProps } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconMinus from "~icons/lucide/minus";

/**
 * The checkbox, promoted from `tELS/client/web/src/components/ui/checkbox.tsx`
 * (which itself had been written twice across the suite).
 *
 * ── Two deliberate differences from the tELS original ──────────────────────
 *
 * 1. **The label sizes are on the scale.** The original's tiers were `text-sm` /
 *    `text-base` / `text-lg` — 14/16/18px — which is a form-page scale, not an
 *    editor-chrome one, and beside 11px captions a 16px checkbox label reads as an
 *    unstyled control dropped into a dense panel. They are 11/12/13px here, the
 *    three body steps of the scale at the top of `shared/css/surface.css`, and the
 *    control boxes shrank to match. `md` is still the default, so a caller passing
 *    no size gets the 12px body step.
 *
 * 2. **No `hover:shadow-sm`.** CEF does not composite a blurred shadow, so the
 *    original's hover step was `hover:border-ring` and nothing else — the shadow
 *    half of it never reached the screen. It is now only what was actually visible.
 *
 * The composable parts below (`CheckboxRoot`, `CheckboxControl`, …) are kept
 * because tELS's markup uses them, so a later migration of tELS onto this file is a
 * change of import path and nothing more.
 */

export interface CheckboxProps {
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

/**
 * `sm` is 11px — the floor. There is nothing smaller, for the reason written up at
 * the top of surface.css: a 10px webfont on a dark surface in CEF 103 has almost no
 * stem left, and that is what every "the fonts are poor" report has been.
 */
const SIZES = {
  sm: { control: "h-3.5 w-3.5", icon: "h-2.5 w-2.5", label: "text-[11px]" },
  md: { control: "h-4 w-4", icon: "h-3 w-3", label: "text-[12px]" },
  lg: { control: "h-5 w-5", icon: "h-3.5 w-3.5", label: "text-[13px]" },
} as const;

const CONTROL_BASE =
  "peer shrink-0 rounded-sm border border-primary ring-offset-background transition-colors duration-200 ease-out hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";

const INDICATOR_BASE = "flex items-center justify-center w-full h-full [&[hidden]]:hidden";

const LABEL_BASE =
  "font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 transition-colors duration-150 cursor-pointer select-none";

export const Checkbox = (props: CheckboxProps & { size?: keyof typeof SIZES }) => {
  const [local, others] = splitProps(props, ["children", "class", "size"]);
  const sz = () => SIZES[local.size ?? "md"];

  return (
    <ArkCheckbox.Root class={cn("flex items-center gap-2", local.class)} {...others}>
      <ArkCheckbox.Control class={cn(CONTROL_BASE, sz().control)}>
        <ArkCheckbox.Indicator class={INDICATOR_BASE}>
          <IconCheck class={sz().icon} />
        </ArkCheckbox.Indicator>
      </ArkCheckbox.Control>
      <Show when={local.children}>
        <ArkCheckbox.Label class={cn(LABEL_BASE, sz().label)}>{local.children}</ArkCheckbox.Label>
      </Show>
      <ArkCheckbox.HiddenInput />
    </ArkCheckbox.Root>
  );
};

/* ── Composable parts, for markup that needs the layout it does not get above ── */

export const CheckboxRoot = ArkCheckbox.Root;
export const CheckboxHiddenInput = ArkCheckbox.HiddenInput;

export const CheckboxLabel = (props: { children?: JSX.Element; class?: string }) => {
  const [local, others] = splitProps(props, ["class"]);
  return <ArkCheckbox.Label class={cn(LABEL_BASE, "text-[12px]", local.class)} {...others} />;
};

export const CheckboxControl = (props: { children?: JSX.Element; class?: string }) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ArkCheckbox.Control class={cn(CONTROL_BASE, SIZES.md.control, local.class)} {...others} />
  );
};

export const CheckboxIndicator = (props: {
  indeterminate?: boolean;
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class", "children", "indeterminate"]);
  return (
    <ArkCheckbox.Indicator
      indeterminate={local.indeterminate}
      class={cn(INDICATOR_BASE, local.class)}
      {...others}
    >
      {local.children || (
        <Show when={local.indeterminate} fallback={<IconCheck class={SIZES.md.icon} />}>
          <IconMinus class={SIZES.md.icon} />
        </Show>
      )}
    </ArkCheckbox.Indicator>
  );
};

export const CheckboxGroup = (
  props: { children?: JSX.Element; class?: string } & Omit<ArkCheckbox.GroupProps, "class">
) => {
  const [local, others] = splitProps(props, ["class"]);
  return <ArkCheckbox.Group class={cn("flex flex-col gap-2", local.class)} {...others} />;
};

export default Checkbox;
