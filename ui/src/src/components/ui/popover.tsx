import type {
  PopoverFocusOutsideEvent,
  PopoverInteractOutsideEvent,
  PopoverPointerDownOutsideEvent,
} from "@ark-ui/solid/popover";
import { Popover as ArkPopover } from "@ark-ui/solid/popover";
import type { PositioningOptions } from "@zag-js/popper";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import { createSignal, type JSX, mergeProps, Show, splitProps } from "solid-js";
import { Motion, Presence } from "solid-motionone";
import { unoMerge } from "unocss-merge";
import IconX from "~icons/lucide/x";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

/**
 * Helper to create popover state for controlled popovers.
 *
 * @example
 * const popover = createPopoverState();
 * return (
 *   <Popover open={popover.isOpen()} onOpenChange={(e) => popover.setOpen(e.open)}>
 *     <Button onClick={popover.open}>Open Popover</Button>
 *     <PopoverContent>...</PopoverContent>
 *   </Popover>
 * );
 */
export function createPopoverState() {
  const [open, setOpen] = createSignal(false);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open()),
    isOpen: open,
    setOpen,
  };
}

interface PopoverProps {
  children?: JSX.Element;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  closeOnInteractOutside?: boolean;
  closeOnEscape?: boolean;
  modal?: boolean;
  autoFocus?: boolean;
  portalled?: boolean;
  positioning?: PositioningOptions;
  lazyMount?: boolean;
  unmountOnExit?: boolean;
  initialFocusEl?: () => HTMLElement | null;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: PopoverInteractOutsideEvent) => void;
  onFocusOutside?: (event: PopoverFocusOutsideEvent) => void;
  onPointerDownOutside?: (event: PopoverPointerDownOutsideEvent) => void;
}

export const Popover = (props: PopoverProps) => {
  const merged = mergeProps({ closeOnInteractOutside: true, closeOnEscape: true }, props);
  return <ArkPopover.Root {...merged} />;
};

interface PopoverTriggerProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverTrigger = (props: PopoverTriggerProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return <ArkPopover.Trigger class={cn(local.class)} {...others} />;
};

interface PopoverAnchorProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverAnchor = (props: PopoverAnchorProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return <ArkPopover.Anchor class={cn(local.class)} {...others} />;
};

interface PopoverContentProps {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}

export const PopoverContent = (props: PopoverContentProps) => {
  const [local, others] = splitProps(props, ["children", "class", "showArrow"]);

  return (
    <ArkPopover.Context>
      {(context) => (
        <ArkPopover.Positioner>
          <Presence>
            <Show when={context().open}>
              <Motion.div
                animate={{ opacity: [0, 1], scale: [0.96, 1] }}
                exit={{ opacity: [1, 0], scale: [1, 0.96] }}
                transition={{ duration: 0.2, easing: "ease-in-out" }}
              >
                <ArkPopover.Content
                  class={cn(
                    "z-50 w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none",
                    local.class
                  )}
                  {...others}
                >
                  {local.showArrow !== false && (
                    <ArkPopover.Arrow class="[--arrow-size:12px] [--arrow-background:hsl(var(--popover))]">
                      <ArkPopover.ArrowTip class="border-t border-l border-border" />
                    </ArkPopover.Arrow>
                  )}
                  {local.children}
                </ArkPopover.Content>
              </Motion.div>
            </Show>
          </Presence>
        </ArkPopover.Positioner>
      )}
    </ArkPopover.Context>
  );
};

interface PopoverTitleProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverTitle = (props: PopoverTitleProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return (
    <ArkPopover.Title
      class={cn("text-sm font-semibold text-foreground", local.class)}
      {...others}
    />
  );
};

interface PopoverDescriptionProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverDescription = (props: PopoverDescriptionProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return (
    <ArkPopover.Description class={cn("text-sm text-muted-foreground", local.class)} {...others} />
  );
};

interface PopoverCloseTriggerProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverCloseTrigger = (props: PopoverCloseTriggerProps) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <ArkPopover.CloseTrigger
      class={cn(
        "rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none disabled:pointer-events-none",
        local.class
      )}
      {...others}
    >
      {local.children || (
        <>
          <IconX class="h-4 w-4" />
          <span class="sr-only">Close</span>
        </>
      )}
    </ArkPopover.CloseTrigger>
  );
};

interface PopoverHeaderProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverHeader = (props: PopoverHeaderProps) => {
  return (
    <div class={cn("flex items-center justify-between p-4 pb-0", props.class)}>
      {props.children}
    </div>
  );
};

interface PopoverBodyProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverBody = (props: PopoverBodyProps) => {
  return <div class={cn("p-4", props.class)}>{props.children}</div>;
};

interface PopoverFooterProps {
  children?: JSX.Element;
  class?: string;
}

export const PopoverFooter = (props: PopoverFooterProps) => {
  return (
    <div class={cn("flex items-center justify-end gap-2 p-4 pt-0", props.class)}>
      {props.children}
    </div>
  );
};

export default Popover;
