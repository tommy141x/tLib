import { Tooltip as ArkTooltip } from "@ark-ui/solid/tooltip";
import type { PositioningOptions } from "@zag-js/popper";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import { type JSX, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";
import { unoMerge } from "unocss-merge";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

interface TooltipProps {
  children?: JSX.Element;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  openDelay?: number;
  closeDelay?: number;
  positioning?: PositioningOptions;
  disabled?: boolean;
  interactive?: boolean;
  closeOnClick?: boolean;
  closeOnEscape?: boolean;
  closeOnPointerDown?: boolean;
  closeOnScroll?: boolean;
  "aria-label"?: string;
}

export const Tooltip = (props: TooltipProps) => {
  return <ArkTooltip.Root {...props}>{props.children}</ArkTooltip.Root>;
};

interface TooltipTriggerProps {
  children?: JSX.Element;
  class?: string;
  asChild?: (props: () => Record<string, any>) => JSX.Element;
}

export const TooltipTrigger = (props: TooltipTriggerProps) => {
  const [local, others] = splitProps(props, ["class", "asChild"]);

  return <ArkTooltip.Trigger class={cn(local.class)} asChild={local.asChild} {...others} />;
};

interface TooltipContentProps {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}

export const TooltipContent = (props: TooltipContentProps) => {
  const [local, others] = splitProps(props, ["children", "class", "showArrow"]);

  return (
    <ArkTooltip.Context>
      {(context) => (
        <Portal>
          <ArkTooltip.Positioner>
            <Presence>
              <Show when={context().open}>
                <Motion.div
                  animate={{ opacity: [0, 1], scale: [0.96, 1] }}
                  exit={{ opacity: [1, 0], scale: [1, 0.96] }}
                  transition={{ duration: 0.15, easing: "ease-out" }}
                >
                  <ArkTooltip.Content
                    class={cn(
                      "z-50 rounded-md bg-secondary text-secondary-foreground px-3 py-1.5 text-xs shadow-md",
                      local.class
                    )}
                    {...others}
                  >
                    {local.showArrow !== false && (
                      <ArkTooltip.Arrow class="[--arrow-size:8px] [--arrow-background:hsl(var(--secondary))]">
                        <ArkTooltip.ArrowTip />
                      </ArkTooltip.Arrow>
                    )}
                    {local.children}
                  </ArkTooltip.Content>
                </Motion.div>
              </Show>
            </Presence>
          </ArkTooltip.Positioner>
        </Portal>
      )}
    </ArkTooltip.Context>
  );
};

export default Tooltip;
