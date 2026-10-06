import { Checkbox as ArkCheckbox } from "@ark-ui/solid";
import { cn } from "@tlib/shared/cn";
import type { JSX } from "@solidjs/web";
import { Show, omit } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconMinus from "~icons/lucide/minus";

/**
 * The checkbox, promoted from `tELS/client/web/src/components/ui/checkbox.tsx`
 * (which itself had been written twice across the suite).
 *
 * ── Two deliberate differences from the tELS original ──────────────────────
 *
 * 1. **The label sizes are on the scale.** The original's three tiers were the
 *    14/16/18px steps, which is a form-page scale, not an editor-chrome one, and
 *    beside 11px captions a 16px checkbox label reads as an unstyled control
 *    dropped into a dense panel. They are 11/12/13px here, the three body steps of
 *    the scale at the top of shared/css/surface.css, and the control boxes shrank
 *    to match. The middle tier is still the default, so a caller passing no size
 *    gets the 12px body step.
 *
 * 2. **No hover elevation.** CEF does not composite a blurred one, so the original's
 *    hover step was the border-colour change and nothing else — the elevation half of
 *    it never reached the screen. It is now only what was actually visible.
 *
 * Utility names are spelled out in words above on purpose: UnoCSS scans comments as
 * well as code, so a class name written here is emitted as dead CSS in every app
 * that imports this file. Measured — the two names this paragraph replaced were
 * shipping two unused rules into tAFK's bundle. Mind which words you pick: the
 * typography preset claims some ordinary English ones too.
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
/**
 * ⚠️ The BOX does not scale with the label, and that is the fix rather than an
 * oversight.
 *
 * It was 14/16/20px across the three tiers. nui-kit's checkbox — the same control,
 * drawn by `.tlib-nui-checkbox-control` for the same product — was a single 17px
 * box, so the two kits disagreed in three ways at once and at no size were they
 * the same object. A checkbox is a fixed-size hit target with a glyph in it; the
 * only thing a label step should move is the label.
 *
 * 16px, in both kits, with a 12px glyph. nui-kit's 17 came down to 16; the odd
 * pixel bought nothing and made the two impossible to compare.
 */
const CONTROL = "h-4 w-4";
const ICON = "h-3 w-3";

const SIZES = {
  sm: { label: "text-[11px]" },
  md: { label: "text-[12px]" },
  lg: { label: "text-[13px]" },
} as const;

/**
 * ⚠️ THE STATE SELECTORS HERE ARE DATA ATTRIBUTES, NOT PSEUDO-CLASSES.
 *    DO NOT "TIDY" THEM BACK.
 *
 * (Written in words below rather than spelled out: UnoCSS scans this comment, and
 * the keyboard-focus variant followed by a colon is itself extracted as a utility.
 * Measured — an earlier draft of this paragraph shipped a stray visibility rule
 * into tELS and tUnit. The hazard is the whole reason the note at the bottom of
 * this header exists; it caught this file twice.)
 *
 * `Checkbox.Control` is a `<div>`. It is never the focused element, and it is
 * never a disabled form control — Ark's `Checkbox.HiddenInput` is the real input,
 * and that is what takes focus and carries the disabled attribute. So the
 * keyboard-focus and disabled PSEUDO-CLASS variants, written on this part,
 * compile to selectors a div can never match. The rules were emitted into every
 * consumer's stylesheet and then never applied once: the box had no focus
 * affordance whatsoever.
 *
 * It was equally dead when focus was drawn as an elevation, so this is not a
 * regression — it is the bug that outlived the elevation-to-outline change. The
 * reason it survived review twice is that the string looks exactly like
 * `button.tsx`'s, where the same spelling is correct, because a `<button>` really
 * does take focus.
 *
 * What works instead: zag mirrors the machine's state onto EVERY part as data
 * attributes. Verified against Ark's own styling guide rather than assumed —
 * Root, Control, Label and Indicator each carry the keyboard-focus, disabled,
 * hover, state and invalid attributes. Presence form, hence the bracketed
 * attribute variants used below.
 *
 * The pointer-hover variant is deliberately left as a pseudo-class: a div
 * genuinely does hover, and only the pointer can cause it.
 *
 * The label follows the same rule for the same reason. Its old sibling-based
 * variant asked the Control to match the disabled pseudo-class — a div again — so
 * a disabled checkbox's label never dimmed either. It reads its own attribute now
 * and needs no sibling. `peer` stays on the Control only because consumers' own
 * markup (tELS's, via the composable parts below) may still target it.
 */
/*
 * `rounded-[var(--radius-tight)]`, NOT `rounded-sm`.
 *
 * On the web target `rounded-sm` is `calc(var(--radius) * 0.5)` — 5px on a 16px
 * box, which is most of the way to a circle and reads as a radio button. No named
 * step equals `--radius-tight` (`rounded-xs` is 2.5px, `rounded-sm` is 5px), so
 * the token is named directly. That is the same 4px nui-kit's
 * `--nui-radius-sm: var(--radius-tight)` resolves to, which is the point: one
 * shape, two kits.
 *
 * The edge at REST is the neutral border token, not `--primary`. It was the accent
 * colour, so an unchecked box advertised itself as the affirmative control before
 * anybody had affirmed anything — and nui-kit's equivalent was neutral, so the two
 * disagreed about the one state a checkbox is usually in. `border-border` is what
 * `.prop-input` in surface.css draws its edge with, so this box now matches the
 * field beside it rather than only the other checkbox. The accent still arrives on
 * hover, on keyboard focus, and as the checked fill.
 */
const CONTROL_BASE =
  "peer shrink-0 rounded-[var(--radius-tight)] border border-border transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] duration-200 ease-out hover:border-ring outline-none data-[focus-visible]:border-ring data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:outline-ring/40 data-[focus-visible]:-outline-offset-1 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";

const INDICATOR_BASE = "flex items-center justify-center w-full h-full [&[hidden]]:hidden";

const LABEL_BASE =
  "font-medium leading-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70 transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] duration-150 cursor-pointer select-none";

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

/* ── Composable parts, for markup that needs the layout it does not get above ── */

export const CheckboxRoot = ArkCheckbox.Root;
export const CheckboxHiddenInput = ArkCheckbox.HiddenInput;

export const CheckboxLabel = (props: { children?: JSX.Element; class?: string }) => {
  const others = omit(props, "class");
  return <ArkCheckbox.Label class={cn(LABEL_BASE, "text-[12px]", props.class)} {...others} />;
};

export const CheckboxControl = (props: { children?: JSX.Element; class?: string }) => {
  const others = omit(props, "class");
  return (
    <ArkCheckbox.Control class={cn(CONTROL_BASE, CONTROL, props.class)} {...others} />
  );
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
