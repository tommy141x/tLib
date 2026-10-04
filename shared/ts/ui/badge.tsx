import { cn } from "@tlib/shared/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { Component, JSX } from "solid-js";
import { Show, splitProps } from "solid-js";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
      clickable: {
        true: "cursor-pointer",
        false: "cursor-default",
      },
    },
    defaultVariants: {
      variant: "default",
      clickable: false,
    },
  }
);

export interface BadgeProps {
  children?: JSX.Element;
  variant?: VariantProps<typeof badgeVariants>["variant"];
  clickable?: boolean;
  /**
   * Solid's own union, not a plain function. A Badge is a legitimate `asChild`
   * target for Tooltip and Popover, and those hand their trigger props straight
   * through — including the bound-handler form `[fn, data]` that Solid delegates.
   * Narrowing this to a bare function makes every such call site a type error.
   */
  onClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>;
  class?: string;
  style?: JSX.CSSProperties | string;
}

export const Badge: Component<BadgeProps> = (props) => {
  const [local, variantProps, others] = splitProps(
    props,
    ["children", "class", "onClick"],
    ["variant", "clickable"]
  );

  // An accessor, NOT a string. A Solid component body runs exactly once, so
  // evaluating this eagerly reads variant, clickable and class at setup and a prop
  // change on a mounted Badge never reaches the DOM. As a function the reads happen
  // inside the JSX class binding, which Solid tracks. Same reason the element choice
  // below is a Show and not a bare early return: an `if` in the body is decided once.
  const classes = () =>
    cn(
      badgeVariants({
        variant: variantProps.variant,
        clickable: variantProps.clickable,
      }),
      local.class
    );

  return (
    <Show
      when={variantProps.clickable || local.onClick}
      fallback={
        <span class={classes()} {...others}>
          {local.children}
        </span>
      }
    >
      <button type="button" class={classes()} onClick={local.onClick} {...others}>
        {local.children}
      </button>
    </Show>
  );
};

export default Badge;
