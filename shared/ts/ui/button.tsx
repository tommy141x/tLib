import { Toggle as ArkToggle } from "@ark-ui/solid/toggle";
// `ValidComponent` must come from `@solidjs/web`, NOT `solid-js`. Both packages
// export a type under that name and `solid-js`'s resolves fine, but it is
// `Component<any>` — function components only. `@solidjs/web`'s is the one that
// admits a tag name, which is what `as="button"` below needs, and it is also the
// constraint `dynamic()` itself is declared against.
import { dynamic, type JSX, type ValidComponent } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import { cva } from "class-variance-authority";
import type { Component } from "solid-js";
import { merge, omit, Show } from "solid-js";
import IconLoaderCircle from "~icons/lucide/loader-circle";

/**
 * Promoted verbatim from tELS's local `components/ui/button.tsx`. tELS is the
 * reference implementation and must keep rendering identically — its gallery is
 * the proof, and every class string below is byte-for-byte what it shipped.
 *
 * THE CVA LIVES IN THIS `.tsx` AND NOT IN A `.ts`, and that is measured rather
 * than stylistic: UnoCSS's default content pipeline matches `[jt]sx` only, so a
 * cva whose class strings live in a plain `.ts` module contributes NOTHING to the
 * generated stylesheet. Split out of tELS's built CSS, 22 rules vanished and
 * every Button lost its height, shifting whole panels up by 12px in 18 of 22
 * gallery shots. Nothing errors and no class is reported missing.
 * (`select-variants.ts` has this defect today; it is not the pattern to copy.)
 *
 * The important-prefixed background utilities and the explicit no-background-image
 * declaration are deliberate: this renders a bare `<button>` against Wind3's form
 * reset plus whatever element-level rules a consumer's stylesheet adds after the
 * utility layer. The history that would name the precise offending rule is not
 * recoverable, so removing one is an unmeasured change to every consumer --
 * prove it with a gallery shot, not with reasoning.
 *
 * `~icons/lucide/loader-circle` is an unplugin-icons virtual module, not a
 * package: it resolves only in a consumer whose vite config registers the plugin.
 * That is the kit's existing contract -- `select.tsx` imports icons the same way.
 *
 * (Class names are described rather than quoted on purpose: UnoCSS scans this
 * file's raw source, comments included, so writing one here emits a real, dead
 * CSS rule. Quoting two of them added 80 bytes of dead stylesheet to tELS.)
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,text-decoration-color,fill,stroke,outline-color] outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:-outline-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [background-image:none]",
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
  }
);

type ButtonProps = {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
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
  leftIcon?: () => JSX.Element;
  rightIcon?: () => JSX.Element;
  // Polymorphic as prop
  as?: ValidComponent;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "children"> & {
    /**
     * `data-*` must be spelled out, and this is NOT the old hole returning.
     */
    [key: `data-${string}`]: string | number | boolean | undefined;
  };

const Button: Component<ButtonProps> = (props) => {
  const merged = merge(
    { variant: "default" as const, size: "default" as const, toggle: false },
    props
  );

  const others = omit(
    merged,
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
    "pressed",
    "defaultPressed",
    "onPressedChange"
  );

  const isDisabled = () => !!(merged.disabled || merged.loading);

  const LeftIconSlot: Component = () => {
    if (merged.loading || !merged.leftIcon) return null;
    return <>{merged.leftIcon()}</>;
  };

  const RightIconSlot: Component = () => {
    if (merged.loading || !merged.rightIcon) return null;
    return <>{merged.rightIcon()}</>;
  };

  const innerContent: JSX.Element = (
    <>
      <Show when={merged.loading}>
        <IconLoaderCircle class="h-4 w-4 animate-spin" />
      </Show>
      <LeftIconSlot />
      <Show when={merged.loading && merged.loadingText} fallback={merged.children}>
        {merged.loadingText}
      </Show>
      <RightIconSlot />
    </>
  );

  if (merged.toggle) {
    return (
      <ArkToggle.Root
        pressed={merged.pressed as unknown as boolean | undefined}
        defaultPressed={merged.defaultPressed as unknown as boolean | undefined}
        onPressedChange={merged.onPressedChange}
        disabled={isDisabled()}
        class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
        {...others}
      >
        {innerContent}
      </ArkToggle.Root>
    );
  }

  // For polymorphic rendering without 'as' prop, use regular button
  if (!merged.as) {
    return (
      <button
        disabled={isDisabled()}
        class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
        {...others}
      >
        {innerContent}
      </button>
    );
  }

  // For polymorphic rendering with 'as' prop, use `dynamic()`.
  const isNativeButton = merged.as === "button";
  const extraProps = isNativeButton ? { disabled: isDisabled() } : {};
  const As = dynamic(() => merged.as as ValidComponent);

  return (
    <As
      class={cn(buttonVariants({ variant: merged.variant, size: merged.size }), merged.class)}
      {...extraProps}
      {...others}
    >
      {innerContent}
    </As>
  );
};

export type { ButtonProps };
export { Button, buttonVariants };
export default Button;
