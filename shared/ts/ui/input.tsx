import { cn } from "@tlib/shared/cn";
import { type JSX, splitProps } from "solid-js";

/**
 * The text input.
 *
 * ── Why this is in tLib now ─────────────────────────────────────────────────
 *
 * It had been written independently three times — tELS, tUnit, and one more — and
 * tLib shipped none, which is why. tLib exported the simple primitives (`button`,
 * `separator`, `kbd`, `slider`, `badge`, `switch`) and nothing with a text field or
 * a popover in it, so every editor re-derived the same control and rediscovered the
 * same two traps on the way. This is the good version, promoted.
 *
 * ── The surface is a CLASS, not a utility chain ─────────────────────────────
 *
 * `.prop-input`, from `@tlib/shared/css/surface.css`, which the consumer must
 * import. That is deliberate and it is the fix for a reported bug: the chain this
 * replaced opened `border border-input bg-input`, and `--input` is the FILL token —
 * so the border was the same colour as the field it was drawing around, i.e.
 * invisible, and the whole affordance was a 3% lightness step against the panel.
 * That is the "the text input is very dim" report.
 *
 * One class also means this control, the Select trigger and any hand-rolled field
 * in a consumer are one surface that cannot drift apart. `.prop-input` carries its
 * own 12px, its own disabled state, and its own focus ring — an `outline`, never a
 * blurred `box-shadow`, because CEF does not composite one.
 *
 * ── There is no `xs` ────────────────────────────────────────────────────────
 *
 * tELS declares one at 9px and then overrides every sub-10px size in its editor
 * chrome back up to 12px with `!important` from its own global.css. A size tier
 * that the type scale immediately contradicts is how "poor fonts" got in; see the
 * scale at the top of surface.css. 11px is the floor, so `sm` is 11px and that is
 * the smallest tier there is.
 */

const sizeClasses = {
  sm: "min-h-[26px] !text-[11px]",
  default: "min-h-[30px]",
};

export interface InputProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "default";
}

export function Input(props: InputProps) {
  const [local, others] = splitProps(props, ["class", "size"]);

  return (
    <input
      class={cn("prop-input", sizeClasses[local.size ?? "default"], local.class)}
      {...others}
    />
  );
}

export default Input;
