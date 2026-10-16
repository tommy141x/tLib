import { Checkbox as ArkCheckbox } from "@ark-ui/solid/checkbox";
import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import { omit, Show } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconMinus from "~icons/lucide/minus";

/**
 * The checkbox, promoted from `tELS/client/web/src/components/ui/checkbox.tsx`
 * (which itself had been written twice across the suite).
 *
 * Utility names are spelled out in words above on purpose: UnoCSS scans comments as
 * well as code, so a class name written here is emitted as dead CSS in every app
 * that imports this file. Measured — the two names this paragraph replaced were
 * shipping two unused rules into tAFK's bundle. Mind which words you pick: the
 * typography preset claims some ordinary English ones too.
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
 * The three label tiers are the body steps of the scale at the top of
 * shared/css/surface.css; the smallest is the 11px floor and there is nothing
 * below it. The BOX does not scale with the label -- a checkbox is a fixed-size
 * hit target with a glyph in it, and nui-kit draws the same control at the same
 * 16px, so the two kits can be compared.
 */
const CONTROL = "h-4 w-4";
const ICON = "h-3 w-3";

const SIZES = {
  sm: { label: "text-[11px]" },
  md: { label: "text-[12px]" },
  lg: { label: "text-[13px]" },
} as const;

/**
 * THE STATE SELECTORS HERE ARE DATA ATTRIBUTES, NOT PSEUDO-CLASSES.
 *    DO NOT "TIDY" THEM BACK.
 *
 * `Checkbox.Control` is a `<div>`: it is never the focused element and never a
 * disabled form control -- Ark's `Checkbox.HiddenInput` is the real input. So the
 * pseudo-class variants compiled to selectors a div can never match, were emitted
 * into every consumer's stylesheet, and never applied once; the box had no focus
 * affordance at all. zag mirrors the machine's state onto EVERY part as data
 * attributes, in presence form, hence the bracketed variants. Pointer hover stays
 * a pseudo-class, because a div genuinely does hover.
 *
 * The corner is the token directly rather than a named step: no named step equals
 * `--radius-tight`, and the nearest reads as a radio button. The edge at REST is
 * the neutral border token, not the accent -- an unchecked box advertising itself
 * as the affirmative control before anybody affirmed anything.
 */
// No colour transition: checkboxes come as a column of options, and at 200ms the
// box was still filling in after the click that checked it. Both the hover edge
// and the checked fill land on the frame they are asked for.
const CONTROL_BASE =
  "peer shrink-0 rounded-[var(--radius-tight)] border border-border hover:border-ring outline-none data-[focus-visible]:border-ring data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:outline-ring/40 data-[focus-visible]:-outline-offset-1 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";

const INDICATOR_BASE = "flex items-center justify-center w-full h-full [&[hidden]]:hidden";

const LABEL_BASE =
  "font-medium leading-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70 cursor-pointer select-none";

export const Checkbox = (props: CheckboxProps & { size?: keyof typeof SIZES }) => {
  const others = omit(props, "children", "class", "size");
  const sz = () => SIZES[props.size ?? "md"];

  return (
    <ArkCheckbox.Root class={cn("flex items-center gap-2", props.class)} {...others}>
      <ArkCheckbox.Control class={cn(CONTROL_BASE, CONTROL)}>
        <ArkCheckbox.Indicator class={INDICATOR_BASE}>
          <IconCheck class={ICON} />
        </ArkCheckbox.Indicator>
      </ArkCheckbox.Control>
      <Show when={props.children}>
        <ArkCheckbox.Label class={cn(LABEL_BASE, sz().label)}>{props.children}</ArkCheckbox.Label>
      </Show>
      <ArkCheckbox.HiddenInput />
    </ArkCheckbox.Root>
  );
};

/* Composable parts, for markup that needs the layout it does not get above */

export const CheckboxRoot = ArkCheckbox.Root;
export const CheckboxHiddenInput = ArkCheckbox.HiddenInput;

export const CheckboxLabel = (props: { children?: JSX.Element; class?: string }) => {
  const others = omit(props, "class");
  return <ArkCheckbox.Label class={cn(LABEL_BASE, "text-[12px]", props.class)} {...others} />;
};

export const CheckboxControl = (props: { children?: JSX.Element; class?: string }) => {
  const others = omit(props, "class");
  return <ArkCheckbox.Control class={cn(CONTROL_BASE, CONTROL, props.class)} {...others} />;
};

export const CheckboxIndicator = (props: {
  indeterminate?: boolean;
  children?: JSX.Element;
  class?: string;
}) => {
  const others = omit(props, "class", "children", "indeterminate");
  return (
    <ArkCheckbox.Indicator
      indeterminate={props.indeterminate}
      class={cn(INDICATOR_BASE, props.class)}
      {...others}
    >
      {props.children || (
        <Show when={props.indeterminate} fallback={<IconCheck class={ICON} />}>
          <IconMinus class={ICON} />
        </Show>
      )}
    </ArkCheckbox.Indicator>
  );
};

export const CheckboxGroup = (
  props: { children?: JSX.Element; class?: string } & Omit<ArkCheckbox.GroupProps, "class">
) => {
  const others = omit(props, "class");
  return <ArkCheckbox.Group class={cn("flex flex-col gap-2", props.class)} {...others} />;
};

export default Checkbox;
