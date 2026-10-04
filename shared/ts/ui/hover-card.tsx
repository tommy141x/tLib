import { HoverCard as ArkHoverCard } from "@ark-ui/solid/hover-card";
import { cn } from "@tlib/shared/cn";
import type { PositioningOptions } from "@zag-js/popper";
import type { JSX } from "@solidjs/web";
import { Show, omit } from "solid-js";
import { Motion, Presence } from "solid-motionone";

interface HoverCardProps {
  children?: JSX.Element;
  open?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  openDelay?: number;
  closeDelay?: number;
  positioning?: PositioningOptions;
  disabled?: boolean;
}

export const HoverCard = (props: HoverCardProps) => {
  return <ArkHoverCard.Root {...props}>{props.children}</ArkHoverCard.Root>;
};

interface HoverCardTriggerProps {
  children?: JSX.Element;
  class?: string;
}

export const HoverCardTrigger = (props: HoverCardTriggerProps) => {
  const others = omit(props, "class");

  return (
    <ArkHoverCard.Trigger
      class={cn("cursor-help underline decoration-dotted underline-offset-4", props.class)}
      {...others}
    />
  );
};

interface HoverCardContentProps {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}

export const HoverCardContent = (props: HoverCardContentProps) => {
  const others = omit(props, "children", "class", "showArrow");

  return (
    <ArkHoverCard.Context>
      {(context) => (
        <ArkHoverCard.Positioner>
          <Presence>
            <Show when={context().open}>
              <Motion.div
                animate={{ opacity: [0, 1], scale: [0.96, 1] }}
                exit={{ opacity: [1, 0], scale: [1, 0.96] }}
                transition={{ duration: 0.2, easing: "ease-in-out" }}
              >
                <ArkHoverCard.Content
                  class={cn(
                    "z-50 w-64 rounded-md border border-border bg-background p-4 outline-none",
                    props.class
                  )}
                  {...others}
                >
                  {props.showArrow !== false && (
                    <ArkHoverCard.Arrow class="[--arrow-size:12px] [--arrow-background:hsl(var(--background))]">
                      <ArkHoverCard.ArrowTip class="border-t border-l border-border" />
                    </ArkHoverCard.Arrow>
                  )}
                  {props.children}
                </ArkHoverCard.Content>
              </Motion.div>
            </Show>
          </Presence>
        </ArkHoverCard.Positioner>
      )}
    </ArkHoverCard.Context>
  );
};

export default HoverCard;
