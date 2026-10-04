import { Tooltip as ArkTooltip } from "@ark-ui/solid/tooltip";
import { cn } from "@tlib/shared/cn";
import type { JSX } from "@solidjs/web";
import { Show, omit } from "solid-js";
import { Portal } from "@solidjs/web";

/**
 * The hover label, promoted from `tELS/client/web/src/components/ui/tooltip.tsx`.
 *
 * ── Read this before reaching for it in a NUI page ─────────────────────────
 *
 * Inside the game the cursor is the game's and there is no OS tooltip layer, so a
 * tooltip is the ONLY thing that will show the text — which also means text that
 * only exists in a tooltip is text most players never see. For a line of
 * explanation under a control, use `ui/field`'s `hint` slot, which is always
 * visible. This is for naming an icon-only button, which is what it is good at.
 *
 * ── Two deliberate differences from the tELS original ──────────────────────
 *
 * 1. **No solid-motionone.** The original wrapped Content in a Presence/Motion pair
 *    for a 150ms fade, which makes solid-motionone a runtime dependency of every
 *    consumer of this file. The enter transition here is CSS keyed off Ark's own
 *    state attribute; there is no exit animation, because a CSS one needs the
 *    element mounted and Ark unmounts it. A consumer migrating off the old copy
 *    loses the fade-out, which is the one visible difference.
 *
 * 2. **No elevation effect.** CEF does not composite a blurred one usefully. The
 *    secondary surface colour against the panel below it, plus the arrow, is the
 *    whole affordance.
 *
 * Text is 12px, the body step of the scale in surface.css — not the extra-small
 * step, which resolves to 10px and is below the floor. That is the single most
 * common place a sub-floor size gets reintroduced, because the extra-small step on
 * a tooltip reads as obviously right.
 *
 * Utility names are deliberately spelled out in words here: UnoCSS scans comments,
 * so writing one emits it as dead CSS in every consuming app.
 */

export type TooltipProps = Omit<ArkTooltip.RootProps, "children"> & {
  children?: JSX.Element;
};

export const Tooltip = (props: TooltipProps) => {
  return <ArkTooltip.Root {...props}>{props.children}</ArkTooltip.Root>;
};

export const TooltipTrigger = (props: {
  children?: JSX.Element;
  class?: string;
  asChild?: ArkTooltip.TriggerProps["asChild"];
}) => {
  const others = omit(props, "class", "asChild");
  return <ArkTooltip.Trigger class={cn(props.class)} asChild={props.asChild} {...others} />;
};

export const TooltipContent = (props: {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}) => {
  const others = omit(props, "children", "class", "showArrow");

  return (
    <Portal>
      <ArkTooltip.Positioner class="!z-[999]">
        <ArkTooltip.Content
          class={cn(
            "z-50 rounded-md bg-secondary px-3 py-1.5 text-[12px] text-secondary-foreground",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-out",
            "data-[state=open]:opacity-100 data-[state=open]:scale-100",
            "data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.96]",
            props.class
          )}
          {...others}
        >
          <Show when={props.showArrow !== false}>
            <ArkTooltip.Arrow class="[--arrow-size:8px] [--arrow-background:hsl(var(--secondary))]">
              <ArkTooltip.ArrowTip />
            </ArkTooltip.Arrow>
          </Show>
          {props.children}
        </ArkTooltip.Content>
      </ArkTooltip.Positioner>
    </Portal>
  );
};

export default Tooltip;
