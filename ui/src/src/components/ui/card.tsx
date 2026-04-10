import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const cardVariants = cva("rounded-lg text-card-foreground", {
  variants: {
    variant: {
      default: "bg-card shadow-sm",
      elevated: "bg-card shadow-xl",
      outlined: "bg-card border-2 border-primary shadow-none",
      interactive:
        "bg-card shadow-sm hover:shadow-md hover:border-accent transition-all cursor-pointer",
      ghost: "bg-transparent border border-border shadow-none",
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
  const [local, variantProps, others] = splitProps(props, ["children", "class"], ["variant"]);

  return (
    <div class={cn(cardVariants({ variant: variantProps.variant }), local.class)} {...others}>
      {local.children}
    </div>
  );
};

export interface CardTitleProps {
  children?: JSX.Element;
  class?: string;
}

export const CardTitle: Component<CardTitleProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <h3 class={cn("text-2xl font-semibold leading-none tracking-tight", local.class)} {...others}>
      {local.children}
    </h3>
  );
};

export interface CardDescriptionProps {
  children?: JSX.Element;
  class?: string;
}

export const CardDescription: Component<CardDescriptionProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <p class={cn("text-sm text-muted-foreground", local.class)} {...others}>
      {local.children}
    </p>
  );
};

export interface CardContentProps {
  children?: JSX.Element;
  class?: string;
}

export const CardContent: Component<CardContentProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <div class={cn("p-6 pt-0", local.class)} {...others}>
      {local.children}
    </div>
  );
};

export interface CardHeaderProps {
  children?: JSX.Element;
  class?: string;
}

export const CardHeader: Component<CardHeaderProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <div class={cn("flex flex-col space-y-1.5 p-6", local.class)} {...others}>
      {local.children}
    </div>
  );
};

export interface CardFooterProps {
  children?: JSX.Element;
  class?: string;
}

export const CardFooter: Component<CardFooterProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <div class={cn("flex items-center p-6 pt-0", local.class)} {...others}>
      {local.children}
    </div>
  );
};

export default Card;
