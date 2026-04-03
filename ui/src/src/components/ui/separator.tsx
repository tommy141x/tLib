import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component } from "solid-js";
import { splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

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
  const [local, others] = splitProps(props, [
    "class",
    "orientation",
    "decorative",
  ]);

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamically set; aria-orientation is only present when role="separator"
    <div
      role={local.decorative ? "none" : "separator"}
      aria-orientation={
        local.decorative ? undefined : local.orientation || "horizontal"
      }
      class={cn(
        separatorVariants({ orientation: local.orientation }),
        local.class,
      )}
      {...others}
    />
  );
};

export default Separator;
