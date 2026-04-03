import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
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
  },
);

export interface BadgeProps {
  children?: JSX.Element;
  variant?: VariantProps<typeof badgeVariants>["variant"];
  clickable?: boolean;
  onClick?: (event: MouseEvent) => void;
  class?: string;
  style?: JSX.CSSProperties | string;
}

export const Badge: Component<BadgeProps> = (props) => {
  const [local, variantProps, others] = splitProps(
    props,
    ["children", "class", "onClick"],
    ["variant", "clickable"],
  );

  const classes = cn(
    badgeVariants({
      variant: variantProps.variant,
      clickable: variantProps.clickable,
    }),
    local.class,
  );

  if (variantProps.clickable || local.onClick) {
    return (
      <button type="button" class={classes} onClick={local.onClick} {...others}>
        {local.children}
      </button>
    );
  }

  return (
    <span class={classes} {...others}>
      {local.children}
    </span>
  );
};

export default Badge;
