import { Tabs as ArkTabs } from "@ark-ui/solid";
import { animate } from "@motionone/dom";
import { cva } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const tabTriggerVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5 text-sm font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative",
  {
    variants: {
      variant: {
        default:
          "text-muted-foreground hover:text-foreground data-[selected]:text-foreground data-[selected]:font-semibold rounded-md relative z-10",
        underline:
          "text-muted-foreground hover:text-foreground rounded-none pb-3 data-[selected]:text-foreground data-[selected]:font-semibold relative",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const tabListVariants = cva("flex items-center relative", {
  variants: {
    variant: {
      default: "gap-1 rounded-lg bg-muted p-1",
      underline: "border-b border-border gap-0 bg-transparent p-0",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

type TabsProps = {
  children?: JSX.Element;
  value?: string;
  defaultValue?: string;
  onValueChange?: (details: { value: string }) => void;
  orientation?: "horizontal" | "vertical";
  activationMode?: "manual" | "automatic";
  disabled?: boolean;
  loopFocus?: boolean;
  class?: string;
  lazyMount?: boolean;
  unmountOnExit?: boolean;
};

export const Tabs: Component<TabsProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);
  let containerRef: HTMLDivElement | undefined;
  const tabHeights = new Map<string, number>();
  let isInitialMount = true;
  let previousHeight = 0;
  let currentAnimations: Array<{ stop: () => void }> = [];

  // Excludes the content elements of any nested Tabs.
  const getDirectTabContents = (): HTMLElement[] => {
    if (!containerRef) return [];
    const allContents = Array.from(
      containerRef.querySelectorAll(
        "[data-scope='tabs'][data-part='content']"
      ) as NodeListOf<HTMLElement>
    );
    return allContents.filter((content) => {
      const closestRoot = content.closest("[data-scope='tabs'][data-part='root']");
      return closestRoot === containerRef;
    });
  };

  // Shows each tab in turn to measure it, then restores every hidden attribute.
  const measureHeights = () => {
    if (!containerRef) return;

    const directContents = getDirectTabContents();

    const hiddenStates = new Map<HTMLElement, boolean>(
      directContents.map((c) => [c, c.hasAttribute("hidden")])
    );

    directContents.forEach((content) => {
      // aria-labelledby points at the trigger, whose id carries the value.
      const labelledBy = content.getAttribute("aria-labelledby") || "";
      const value = labelledBy.replace("tabs:", "").split(":trigger-")[1];

      if (!value) return;

      directContents.forEach((other) => {
        if (other === content) {
          other.removeAttribute("hidden");
        } else {
          other.setAttribute("hidden", "");
        }
      });

      void containerRef.offsetHeight; // reflow before measuring
      const height = containerRef.offsetHeight;
      tabHeights.set(value, height);
    });

    hiddenStates.forEach((wasHidden, content) => {
      if (wasHidden) {
        content.setAttribute("hidden", "");
      } else {
        content.removeAttribute("hidden");
      }
    });
  };

  // Crossfades the two panels while animating the container between their
  // heights. Both are positioned absolutely for the duration so the old panel
  // can stay on screen past the point Ark UI has switched tabs.
  createEffect(() => {
    const currentValue = props.value;
    if (!containerRef || !currentValue) return;

    onCleanup(() => {
      currentAnimations.forEach((anim) => {
        anim.stop();
      });
      currentAnimations = [];
    });

    // The first render is left alone; it only seeds the height.
    if (isInitialMount) {
      isInitialMount = false;
      previousHeight = containerRef.offsetHeight;
      return;
    }

    const currentHeight = previousHeight;
    measureHeights();

    const targetHeight = tabHeights.get(currentValue);
    if (!targetHeight) return;

    if (!containerRef.style.overflow) {
      containerRef.style.overflow = "hidden";
    }

    const allContents = getDirectTabContents();

    const newContent =
      allContents.find((content) => {
        const labelledBy = content.getAttribute("aria-labelledby") || "";
        const value = labelledBy.replace("tabs:", "").split(":trigger-")[1];
        return value === currentValue;
      }) || null;

    const oldContent =
      allContents.find((content) => {
        const labelledBy = content.getAttribute("aria-labelledby") || "";
        const value = labelledBy.replace("tabs:", "").split(":trigger-")[1];
        return value !== currentValue;
      }) || null;

    if (oldContent) {
      oldContent.style.opacity = "1";
    }
    if (newContent) {
      newContent.style.opacity = "0";
    }

    void containerRef.offsetHeight; // lock in the current height
    const tabsList = containerRef.querySelector(
      "[data-scope='tabs'][data-part='list']"
    ) as HTMLElement;
    const tabsListHeight = tabsList ? tabsList.offsetHeight : 0;

    const firstContent = allContents[0];
    const contentMarginTop = firstContent
      ? parseFloat(window.getComputedStyle(firstContent).marginTop) || 0
      : 0;
    const contentTopOffset = tabsListHeight + contentMarginTop;

    allContents.forEach((content) => {
      content.style.position = "absolute";
      content.style.top = `${contentTopOffset}px`;
      content.style.left = "0";
      content.style.right = "0";
      content.style.marginTop = "0";
    });

    // display overrides Ark UI's hidden, so both panels show mid-transition.
    if (oldContent) {
      oldContent.style.display = "block";
      oldContent.style.zIndex = "0";
      oldContent.style.pointerEvents = "none";
    }
    if (newContent) {
      newContent.style.display = "block";
      newContent.style.zIndex = "10";
      newContent.style.pointerEvents = "auto";
    }

    currentAnimations.forEach((anim) => {
      anim.stop();
    });
    currentAnimations = [];

    // Explicit height, only now that positioning is applied.
    containerRef.style.height = `${currentHeight}px`;

    requestAnimationFrame(() => {
      if (!containerRef) return;

      if (oldContent) {
        const anim = animate(oldContent, { opacity: 0 }, { duration: 0.3, easing: "ease-in-out" });
        currentAnimations.push(anim);
      }

      if (newContent) {
        const anim = animate(newContent, { opacity: 1 }, { duration: 0.3, easing: "ease-in-out" });
        currentAnimations.push(anim);
      }

      const heightAnim = animate(
        containerRef,
        { height: `${targetHeight}px` },
        { duration: 0.3, easing: [0.16, 1, 0.3, 1] }
      );
      currentAnimations.push(heightAnim);

      heightAnim.finished.then(() => {
        if (!containerRef) return;

        previousHeight = containerRef.offsetHeight;
        currentAnimations = [];

        // Back to natural layout.
        containerRef.style.height = "";
        containerRef.style.overflow = "";

        allContents.forEach((content) => {
          content.style.position = "";
          content.style.top = "";
          content.style.left = "";
          content.style.right = "";
          content.style.opacity = "";
          content.style.zIndex = "";
          content.style.pointerEvents = "";
          content.style.display = "";
          content.style.marginTop = "";
        });
      });
    });
  });

  return (
    <ArkTabs.Root ref={containerRef} class={cn("w-full relative", local.class)} {...others}>
      {local.children}
    </ArkTabs.Root>
  );
};

type TabsListProps = {
  children?: JSX.Element;
  class?: string;
  variant?: "default" | "underline";
};

export const TabsList: Component<TabsListProps> = (props) => {
  const [local, variantProps, others] = splitProps(props, ["children", "class"], ["variant"]);

  return (
    <ArkTabs.List
      class={cn(tabListVariants({ variant: variantProps.variant }), local.class)}
      {...others}
    >
      {local.children}
    </ArkTabs.List>
  );
};

type TabsTriggerProps = {
  value: string;
  children?: JSX.Element;
  disabled?: boolean;
  class?: string;
  variant?: "default" | "underline";
};

export const TabsTrigger: Component<TabsTriggerProps> = (props) => {
  const [local, variantProps, others] = splitProps(props, ["children", "class"], ["variant"]);

  return (
    <ArkTabs.Trigger
      class={cn(tabTriggerVariants({ variant: variantProps.variant }), local.class)}
      {...others}
    >
      {local.children}
    </ArkTabs.Trigger>
  );
};

type TabsContentProps = {
  value: string;
  children?: JSX.Element;
  class?: string;
};

export const TabsContent: Component<TabsContentProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <ArkTabs.Content
      class={cn(
        "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "mt-4",
        local.class
      )}
      {...others}
    >
      {local.children}
    </ArkTabs.Content>
  );
};

type TabsIndicatorProps = {
  class?: string;
};

export const TabsIndicator: Component<
  TabsIndicatorProps & { variant?: "default" | "underline" }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "variant"]);
  const [mounted, setMounted] = createSignal(false);

  // Transitions are enabled a frame late, so the indicator does not slide in
  // from wherever it first rendered.
  onMount(() => {
    requestAnimationFrame(() => {
      setMounted(true);
    });
  });

  const isUnderline = () => local.variant === "underline";

  return (
    <ArkTabs.Indicator
      class={cn(
        "absolute z-0",
        isUnderline()
          ? "bottom-0 h-0.5 bg-foreground rounded-full"
          : "bg-background shadow-sm rounded-md",
        local.class
      )}
      style={{
        left: "var(--left)",
        top: isUnderline() ? undefined : "var(--top)",
        bottom: isUnderline() ? "0" : undefined,
        width: "var(--width)",
        height: isUnderline() ? "2px" : "var(--height)",
        transition: mounted()
          ? "left 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1)"
          : "none",
      }}
      {...others}
    />
  );
};

export const TabsRoot = Tabs;

export default Tabs;
