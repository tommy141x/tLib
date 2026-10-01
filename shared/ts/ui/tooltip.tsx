import { Tooltip as ArkTooltip } from "@ark-ui/solid/tooltip";
import { cn } from "@tlib/shared/cn";
import { type JSX, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";

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
 * 1. **No `solid-motionone`.** The original wrapped Content in
 *    `<Presence><Motion.div>` for a 150ms fade, which makes `solid-motionone` a
 *    runtime dependency of every consumer of this file. The enter transition here
 *    is CSS keyed off Ark's own `data-state`; there is no exit animation, because a
 *    CSS one needs the element mounted and Ark unmounts it.
 *
 * 2. **No `shadow-md`.** CEF does not composite a blurred drop shadow usefully.
 *    `bg-secondary` against the surface below it plus the arrow is the whole
 *    affordance.
 *
 * tELS keeps its own copy, so nothing there changes.
 *
 * Text is 12px, the body step of the scale in surface.css — not `text-xs`, which
 * resolves to 10px and is below the floor. That is the single most common place a
 * sub-floor size gets reintroduced, because `text-xs` on a tooltip reads as
 * obviously right.
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
  const [local, others] = splitProps(props, ["class", "asChild"]);
  return <ArkTooltip.Trigger class={cn(local.class)} asChild={local.asChild} {...others} />;
};

export const TooltipContent = (props: {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}) => {
  const [local, others] = splitProps(props, ["children", "class", "showArrow"]);

  return (
    <Portal>
      <ArkTooltip.Positioner class="!z-[999]">
        <ArkTooltip.Content
          class={cn(
            "z-50 rounded-md bg-secondary px-3 py-1.5 text-[12px] text-secondary-foreground",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-out",
            "data-[state=open]:opacity-100 data-[state=open]:scale-100",
            "data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.96]",
            local.class
          )}
          {...others}
        >
          <Show when={local.showArrow !== false}>
            <ArkTooltip.Arrow class="[--arrow-size:8px] [--arrow-background:hsl(var(--secondary))]">
              <ArkTooltip.ArrowTip />
            </ArkTooltip.Arrow>
          </Show>
          {local.children}
        </ArkTooltip.Content>
      </ArkTooltip.Positioner>
    </Portal>
  );
};

export default Tooltip;
