import { Toggle as ArkToggle } from "@ark-ui/solid/toggle";
import { cva } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX, ValidComponent } from "solid-js";
import { mergeProps, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { unoMerge } from "unocss-merge";
import IconLoaderCircle from "~icons/lucide/loader-circle";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [background-image:none]",
  {
    variants: {
      variant: {
        default:
          "!bg-primary text-primary-foreground hover:!bg-primary/90 data-[pressed]:!bg-primary/80",
        destructive:
          "!bg-destructive text-destructive-foreground hover:!bg-destructive/90 data-[pressed]:!bg-destructive/80",
        outline:
          "border border-input !bg-background text-foreground hover:!bg-accent hover:text-accent-foreground data-[pressed]:!bg-accent",
        secondary:
          "!bg-secondary text-secondary-foreground hover:!bg-secondary/80 data-[pressed]:!bg-secondary/70",
        ghost:
          "!bg-transparent text-foreground hover:!bg-accent hover:text-accent-foreground data-[pressed]:!bg-accent",
        link: "!bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = {
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?: "default" | "sm" | "lg" | "icon";
  class?: string | undefined;
  children?: JSX.Element;
  toggle?: boolean;
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  // New props for loading state
  loading?: boolean;
  loadingText?: string;
  // Icons — pass as render functions so they are lazily evaluated inside
  // the Button's reactive render tree (avoids SSR/hydration mismatches).
  leftIcon?: () => JSX.Element;
  rightIcon?: () => JSX.Element;
  // Polymorphic as prop
  as?: ValidComponent;
  [key: string]: unknown;
};

const Button: Component<ButtonProps> = (props) => {
  const merged = mergeProps(
    { variant: "default" as const, size: "default" as const, toggle: false },
    props,
  );

  const [local, toggleProps, others] = splitProps(
    merged,
    [
      "variant",
      "size",
      "class",
      "toggle",
      "children",
      "loading",
      "loadingText",
      "leftIcon",
      "rightIcon",
      "disabled",
      "as",
    ],
    ["pressed", "defaultPressed", "onPressedChange"],
  );

  const isDisabled = () => !!(local.disabled || local.loading);

  // LeftIconSlot / RightIconSlot are tiny components defined inside Button so
  // they close over `local`. Defining them as named components (capital letter)
  // means SolidJS treats them as reactive nodes in the render tree — they
  // re-run when `local.loading` or `local.leftIcon` / `local.rightIcon` change,
  // rather than being evaluated once and baked into a static JSX snapshot.
  // This is the correct pattern to avoid "template is not a function" hydration
  // errors that occur when bare ternaries or called helper-functions are used.
  const LeftIconSlot: Component = () => {
    if (local.loading || !local.leftIcon) return null;
    return <>{local.leftIcon()}</>;
  };

  const RightIconSlot: Component = () => {
    if (local.loading || !local.rightIcon) return null;
    return <>{local.rightIcon()}</>;
  };

  // innerContent is assigned as a JSX value (not called as a function), so it
  // lives permanently inside SolidJS's reactive tree. Each Show / component
  // node re-evaluates independently when its signals change.
  const innerContent: JSX.Element = (
    <>
      <Show when={local.loading}>
        <IconLoaderCircle class="h-4 w-4 animate-spin" />
      </Show>
      <LeftIconSlot />
      <Show when={local.loading && local.loadingText} fallback={local.children}>
        {local.loadingText}
      </Show>
      <RightIconSlot />
    </>
  );

  if (local.toggle) {
    return (
      <ArkToggle.Root
        pressed={toggleProps.pressed as unknown as boolean | undefined}
        defaultPressed={
          toggleProps.defaultPressed as unknown as boolean | undefined
        }
        onPressedChange={toggleProps.onPressedChange}
        disabled={isDisabled()}
        class={cn(
          buttonVariants({ variant: local.variant, size: local.size }),
          local.class,
        )}
        {...others}
      >
        {innerContent}
      </ArkToggle.Root>
    );
  }

  // For polymorphic rendering without 'as' prop, use regular button
  if (!local.as) {
    return (
      <button
        disabled={isDisabled()}
        class={cn(
          buttonVariants({ variant: local.variant, size: local.size }),
          local.class,
        )}
        {...others}
      >
        {innerContent}
      </button>
    );
  }

  // For polymorphic rendering with 'as' prop, use Dynamic
  // Don't pass disabled to non-button elements (like anchor tags)
  const isNativeButton = local.as === "button";
  const extraProps = isNativeButton ? { disabled: isDisabled() } : {};

  return (
    <Dynamic
      component={local.as}
      class={cn(
        buttonVariants({ variant: local.variant, size: local.size }),
        local.class,
      )}
      {...extraProps}
      {...others}
    >
      {innerContent}
    </Dynamic>
  );
};

export { Button, buttonVariants };
export type { ButtonProps };
