import { cn } from "@tlib/shared/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "@solidjs/web";
import type { Component } from "solid-js";
import { omit } from "solid-js";

/**
 * ⚠️ `elevated` no longer elevates, and `default` and `elevated` now resolve to the
 * same classes.
 *
 * Every elevation utility in `shared/ts/ui/*` was stripped, here and in badge,
 * switch, hover-card, color-picker and select. FiveM's CEF does not composite a
 * blurred one usefully: it costs a compositor pass — over a moving 3D scene, in
 * the overlay case — and puts nothing on the screen. The variants below were
 * therefore already visually identical at runtime; removing the classes only makes
 * that legible in the source. The cancelling utility on `outlined`/`ghost` went
 * with them: it was cancelling something that no longer exists.
 *
 * Since 0.12.1 the shared preset BLOCKLISTS the whole family for every
 * `target: "nui"` build, so this is now enforced rather than remembered — and so
 * is the second-order defect, which is that naming one of those utilities in a
 * sentence like this one is enough for UnoCSS's extractor to emit it.
 *
 * If a card needs to read as raised, separate it with `--border`, which is above
 * every fill on the elevation ladder and composites. See `.panel` in
 * `shared/css/surface.css` for the recipe, and the ladder at the bottom of
 * `shared/css/theme-tokens.css` for why NOT to reach for a lighter `--card`.
 *
 * `elevated` is kept as a name rather than deleted so no consumer's call site
 * breaks; it is now an alias.
 */
const cardVariants = cva("rounded-lg text-card-foreground", {
  variants: {
    variant: {
      default: "bg-card",
      elevated: "bg-card",
      outlined: "bg-card border-2 border-primary",
      interactive: "bg-card hover:border-accent transition-all cursor-pointer",
      ghost: "bg-transparent border border-border",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface CardProps {
  children?: JSX.Element;
  variant?: VariantProps<typeof cardVariants>["variant"];
  class?: string;
}

export const Card: Component<CardProps> = (props) => {
  const others = omit(props, "children", "class", "variant");

  return (
    <div class={cn(cardVariants({ variant: props.variant }), props.class)} {...others}>
      {props.children}
    </div>
  );
};

export interface CardTitleProps {
  children?: JSX.Element;
  class?: string;
}

export const CardTitle: Component<CardTitleProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <h3 class={cn("text-2xl font-semibold leading-none tracking-tight", props.class)} {...others}>
      {props.children}
    </h3>
  );
};

export interface CardDescriptionProps {
  children?: JSX.Element;
  class?: string;
}

export const CardDescription: Component<CardDescriptionProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <p class={cn("text-sm text-muted-foreground", props.class)} {...others}>
      {props.children}
    </p>
  );
};

export interface CardContentProps {
  children?: JSX.Element;
  class?: string;
}

export const CardContent: Component<CardContentProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <div class={cn("p-6 pt-0", props.class)} {...others}>
      {props.children}
    </div>
  );
};

export interface CardHeaderProps {
  children?: JSX.Element;
  class?: string;
}

export const CardHeader: Component<CardHeaderProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <div class={cn("flex flex-col space-y-1.5 p-6", props.class)} {...others}>
      {props.children}
    </div>
  );
};

export interface CardFooterProps {
  children?: JSX.Element;
  class?: string;
}

export const CardFooter: Component<CardFooterProps> = (props) => {
  const others = omit(props, "children", "class");

  return (
    <div class={cn("flex items-center p-6 pt-0", props.class)} {...others}>
      {props.children}
    </div>
  );
};

export default Card;
