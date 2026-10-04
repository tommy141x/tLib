import { Tabs as ArkTabs } from "@ark-ui/solid";
import { cn } from "@tlib/shared/cn";
import { cva } from "class-variance-authority";
import type { JSX } from "@solidjs/web";
import { type Component, createSignal, omit, onSettled } from "solid-js";

/**
 * Tabs, promoted from `tELS/client/web/src/components/ui/tabs.tsx`.
 *
 * ── What was left behind, and why ──────────────────────────────────────────
 *
 * The tELS original is 399 lines, of which roughly 200 are a crossfade: on every
 * value change it measures each panel's height by unhiding it one at a time,
 * absolutely positions all of them, and animates `height` and `opacity` with
 * `@motionone/dom`. That is not ported, for three reasons.
 *
 *   - It makes `@motionone/dom` a runtime dependency of every consumer of this
 *     file, resolved from the consumer's own `node_modules`. tLib does not declare
 *     it even as a peer, so whether it resolved at all would depend on hoisting.
 *   - It animates `height` — a layout property — every 300ms over a page composited
 *     on top of a moving 3D scene in CEF 103, and it does a forced synchronous
 *     reflow per panel to measure first.
 *   - It reads each panel's value back out of `aria-labelledby` by string-splitting
 *     Ark's internal id format (`tabs:…:trigger-<value>`). That is a private
 *     contract of the version of Ark installed, and it fails silently — a changed
 *     id shape yields `undefined`, the measurement is skipped, and the tabs simply
 *     stop animating with nothing logged.
 *
 * tELS keeps its own copy and is untouched, so its crossfade still works there. If
 * a consumer of this file wants an enter transition, Ark sets `data-state` on the
 * Content and a CSS `transition` on opacity costs nothing.
 *
 * ── The other differences ──────────────────────────────────────────────────
 *
 * Trigger text is 12px, not `text-sm` (14px) — the body step of the scale at the
 * top of `shared/css/surface.css`. The `default` indicator lost its `shadow-sm`:
 * CEF does not composite it, so it was never on screen anyway.
 */

const tabTriggerVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5 text-[12px] font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative",
  {
    variants: {
      variant: {
        default:
          "text-muted-foreground hover:text-foreground data-[selected]:text-foreground data-[selected]:font-semibold rounded-md relative z-10",
        underline:
          "text-muted-foreground hover:text-foreground rounded-none pb-3 data-[selected]:text-foreground data-[selected]:font-semibold relative",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const tabListVariants = cva("flex items-center relative", {
  variants: {
    variant: {
      default: "gap-1 rounded-lg bg-muted p-1",
      underline: "border-b border-border gap-0 bg-transparent p-0",
    },
  },
  defaultVariants: { variant: "default" },
});

export type TabsVariant = "default" | "underline";

export type TabsProps = Omit<ArkTabs.RootProps, "children" | "class"> & {
  children?: JSX.Element;
  class?: string;
};

export const Tabs: Component<TabsProps> = (props) => {
  const others = omit(props, "children", "class");
  return (
    <ArkTabs.Root class={cn("w-full relative", props.class)} {...others}>
      {props.children}
    </ArkTabs.Root>
  );
};

export const TabsList: Component<{
  children?: JSX.Element;
  class?: string;
  variant?: TabsVariant;
}> = (props) => {
  const others = omit(props, "children", "class", "variant");
  return (
    <ArkTabs.List class={cn(tabListVariants({ variant: props.variant }), props.class)} {...others}>
      {props.children}
    </ArkTabs.List>
  );
};

export const TabsTrigger: Component<{
  value: string;
  children?: JSX.Element;
  disabled?: boolean;
  class?: string;
  variant?: TabsVariant;
}> = (props) => {
  const others = omit(props, "children", "class", "variant");
  return (
    <ArkTabs.Trigger
      class={cn(tabTriggerVariants({ variant: props.variant }), props.class)}
      {...others}
    >
      {props.children}
    </ArkTabs.Trigger>
  );
};

export const TabsContent: Component<{
  value: string;
  children?: JSX.Element;
  class?: string;
}> = (props) => {
  const others = omit(props, "children", "class");
  return (
    <ArkTabs.Content
      class={cn(
        "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "mt-4",
        props.class
      )}
      {...others}
    >
      {props.children}
    </ArkTabs.Content>
  );
};

export const TabsIndicator: Component<{ class?: string; variant?: TabsVariant }> = (props) => {
  const others = omit(props, "class", "variant");
  const [mounted, setMounted] = createSignal(false);

  // Transitions are enabled a frame AFTER mount, deliberately: Ark sets `--left`
  // and `--width` once it has measured the triggers, and with the transition
  // already live the indicator visibly slides in from 0 on every page load.
  //
  // `onSettled` is Solid 2's `onMount`; the cleanup is RETURNED, never registered
  // with a nested `onCleanup`, which `onSettled` refuses outright. The frame is
  // cancelled on teardown — previously there was nothing to cancel because there
  // was no cleanup at all, and a tab strip disposed inside one frame would have
  // written a signal on a dead owner.
  onSettled(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  });

  const isUnderline = () => props.variant === "underline";

  return (
    <ArkTabs.Indicator
      class={cn(
        "absolute z-0",
        isUnderline()
          ? "bottom-0 h-0.5 bg-foreground rounded-full"
          : // `bg-background`, not a shadow: the selected pill is the one place the
            // bottom rung of the ladder is the right fill, because the track above
            // it is `bg-muted`.
            "bg-background rounded-md",
        props.class
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
