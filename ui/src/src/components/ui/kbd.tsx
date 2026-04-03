import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const kbdVariants = cva(
  "pointer-events-none inline-flex select-none items-center justify-center gap-1 rounded border border-border bg-muted font-mono font-medium opacity-100 text-muted-foreground",
  {
    variants: {
      size: {
        sm: "!text-[9px] min-h-4 min-w-4 px-1 py-0",
        default: "!text-[10px] min-h-5 min-w-5 px-1.5 py-0.5",
        lg: "!text-xs min-h-6 min-w-6 px-2 py-1",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

interface KbdProps extends VariantProps<typeof kbdVariants> {
  children?: JSX.Element;
  class?: string;
}

export const Kbd: Component<KbdProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class", "size"]);

  return (
    <kbd
      class={cn(kbdVariants({ size: local.size || "default" }), local.class)}
      {...others}
    >
      {local.children}
    </kbd>
  );
};

interface KbdGroupProps {
  children?: JSX.Element;
  class?: string;
}

export const KbdGroup: Component<KbdGroupProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <div class={cn("inline-flex items-center gap-1", local.class)} {...others}>
      {local.children}
    </div>
  );
};

export default Kbd;
