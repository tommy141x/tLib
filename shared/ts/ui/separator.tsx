import { cn } from "@tlib/shared/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { Component } from "solid-js";
import { omit } from "solid-js";

const separatorVariants = cva("shrink-0 bg-border", {
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "h-full w-px",
    },
  },
  defaultVariants: {
    orientation: "horizontal",
  },
});

interface SeparatorProps extends VariantProps<typeof separatorVariants> {
  class?: string;
  decorative?: boolean;
}

export const Separator: Component<SeparatorProps> = (props) => {
  const others = omit(props, "class", "orientation", "decorative");

  return (
    <div
      role={props.decorative ? "none" : "separator"}
      aria-orientation={props.decorative ? undefined : props.orientation || "horizontal"}
      class={cn(separatorVariants({ orientation: props.orientation }), props.class)}
      {...others}
    />
  );
};

export default Separator;
