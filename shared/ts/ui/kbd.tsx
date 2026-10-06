import { cn } from "@tlib/shared/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "@solidjs/web";
import type { Component } from "solid-js";
import { omit } from "solid-js";

/**
 * ⚠️ The three sizes are 11/12/13px, which is the WHOLE type scale at the top of
 * `shared/css/surface.css`, bottom to top. Nothing here may go below 11px.
 *
 * They were 9/10/12, and this file is the reason that scale needed writing down:
 * a shared component is the one place a floor can be broken for every consumer at
 * once, and `size="sm"` is the only size any of them uses -- tELS's toolbar and
 * status bar, tAFK's editor HUD, tUnit's status bar, all `sm`, all 9px. The
 * measurement behind the floor is in surface.css's header: CEF 103 renders a 10px
 * webfont on a dark surface with almost no stem left, and "the fonts are poor"
 * has been reported twice against exactly that.
 *
 * `lg` moved 12 -> 13 rather than staying at 12 so the three sizes stay three
 * sizes; `default` is now what `lg` used to be.
 *
 * The `!` on each is not decoration either: an arbitrary `text-[11px]` and the
 * base's `text-muted-foreground` are ONE conflict group to unocss-merge, so
 * without it a caller's `class` can annihilate the size silently.
 */
const kbdVariants = cva(
  "pointer-events-none inline-flex select-none items-center justify-center gap-1 rounded border border-border bg-muted font-mono font-medium opacity-100 text-muted-foreground",
  {
    variants: {
      size: {
        sm: "!text-[11px] min-h-4 min-w-4 px-1 py-0",
        default: "!text-xs min-h-5 min-w-5 px-1.5 py-0.5",
        lg: "!text-[13px] min-h-6 min-w-6 px-2 py-1",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

interface KbdProps extends VariantProps<typeof kbdVariants> {
  children?: JSX.Element;
  class?: string;
}

export const Kbd: Component<KbdProps> = (props) => {
  const others = omit(props, "children", "class", "size");

  return (
    <kbd class={cn(kbdVariants({ size: props.size || "default" }), props.class)} {...others}>
      {props.children}
    </kbd>
  );
};

interface KbdGroupProps {
  children?: JSX.Element;
  class?: string;
}

export const KbdGroup: Component<KbdGroupProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <div class={cn("inline-flex items-center gap-1", props.class)} {...others}>
      {props.children}
    </div>
  );
};

export default Kbd;
