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

// Variants for tab triggers
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

// Main Tabs component
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

  // Returns only the tab content elements that directly belong to this Tabs instance,
  // filtering out any content elements that belong to nested Tabs components.
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

  // Function to measure tab heights
  const measureHeights = () => {
    if (!containerRef) return;

    const directContents = getDirectTabContents();

    // Save the hidden state of every element BEFORE we start manipulating them
    const hiddenStates = new Map<HTMLElement, boolean>(
      directContents.map((c) => [c, c.hasAttribute("hidden")])
    );

    directContents.forEach((content) => {
      // Get the value from aria-labelledby which points to trigger id
      const labelledBy = content.getAttribute("aria-labelledby") || "";
      const value = labelledBy.replace("tabs:", "").split(":trigger-")[1];

      if (!value) return;

      // Temporarily show this tab and hide others
      directContents.forEach((other) => {
        if (other === content) {
          other.removeAttribute("hidden");
        } else {
          other.setAttribute("hidden", "");
        }
      });

      // Force reflow before measuring
      void containerRef.offsetHeight;

      // Measure the container's actual height with this tab visible
      const height = containerRef.offsetHeight;
      tabHeights.set(value, height);
    });

    // Restore ALL elements to their original hidden state
    hiddenStates.forEach((wasHidden, content) => {
      if (wasHidden) {
        content.setAttribute("hidden", "");
      } else {
        content.removeAttribute("hidden");
      }
    });
  };

  // Animate on value change
  createEffect(() => {
    const currentValue = props.value;
    if (!containerRef || !currentValue) return;

    // Cleanup animations on component unmount or effect re-run
    onCleanup(() => {
      currentAnimations.forEach((anim) => {
        anim.stop();
      });
      currentAnimations = [];
    });

    // Skip on initial mount - let it render naturally
    if (isInitialMount) {
      isInitialMount = false;
      // Capture initial height for next transition
      previousHeight = containerRef.offsetHeight;
      return;
    }

    // Use previous height as starting point (before Ark UI switches tabs)
    const currentHeight = previousHeight;

    // Measure heights now that we're switching tabs
    measureHeights();

    const targetHeight = tabHeights.get(currentValue);
    if (!targetHeight) return;

    // Prepare container for animation
    if (!containerRef.style.overflow) {
      containerRef.style.overflow = "hidden";
    }

    // Get only the direct tab content elements of this Tabs instance
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

    // Set initial opacity before changing layout
    if (oldContent) {
      oldContent.style.opacity = "1";
    }
    if (newContent) {
      newContent.style.opacity = "0";
    }

    // Force reflow to lock in current height
    void containerRef.offsetHeight;

    // Calculate the height of TabsList to position content below it
    const tabsList = containerRef.querySelector(
      "[data-scope='tabs'][data-part='list']"
    ) as HTMLElement;
    const tabsListHeight = tabsList ? tabsList.offsetHeight : 0;

    // Calculate the actual margin from the first content element
    const firstContent = allContents[0];
    const contentMarginTop = firstContent
      ? parseFloat(window.getComputedStyle(firstContent).marginTop) || 0
      : 0;
    const contentTopOffset = tabsListHeight + contentMarginTop;

    // Now set up absolute positioning for animation
    // Position content below TabsList + margin
    allContents.forEach((content) => {
      content.style.position = "absolute";
      content.style.top = `${contentTopOffset}px`;
      content.style.left = "0";
      content.style.right = "0";
      content.style.marginTop = "0";
    });

    // Override hidden with CSS to show both during transition
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

    // Cancel any ongoing animations
    currentAnimations.forEach((anim) => {
      anim.stop();
    });
    currentAnimations = [];

    // Set explicit height AFTER positioning is applied
    containerRef.style.height = `${currentHeight}px`;

    requestAnimationFrame(() => {
      if (!containerRef) return;

      // Fade out old content
      if (oldContent) {
        const anim = animate(oldContent, { opacity: 0 }, { duration: 0.3, easing: "ease-in-out" });
        currentAnimations.push(anim);
      }

      // Fade in new content simultaneously for smooth crossfade
      if (newContent) {
        const anim = animate(newContent, { opacity: 1 }, { duration: 0.3, easing: "ease-in-out" });
        currentAnimations.push(anim);
      }

      // Animate height
      const heightAnim = animate(
        containerRef,
        { height: `${targetHeight}px` },
        { duration: 0.3, easing: [0.16, 1, 0.3, 1] }
      );
      currentAnimations.push(heightAnim);

      heightAnim.finished.then(() => {
        if (!containerRef) return;

        // Capture height for next transition
        previousHeight = containerRef.offsetHeight;

        // Clear animation references
        currentAnimations = [];

        // Clean up: restore natural layout
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

// Tab List
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

// Tab Trigger
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

// Tab Content with smooth height and opacity animations
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

// Tab Indicator
type TabsIndicatorProps = {
  class?: string;
};

export const TabsIndicator: Component<
  TabsIndicatorProps & { variant?: "default" | "underline" }
> = (props) => {
  const [local, others] = splitProps(props, ["class", "variant"]);
  const [mounted, setMounted] = createSignal(false);

  onMount(() => {
    // Enable transitions after mount
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

// Composable exports
export const TabsRoot = Tabs;

export default Tabs;
