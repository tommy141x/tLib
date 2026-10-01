import { Popover as ArkPopover } from "@ark-ui/solid/popover";
import { cn } from "@tlib/shared/cn";
import { createSignal, type JSX, mergeProps, Show, splitProps } from "solid-js";
import IconX from "~icons/lucide/x";

/**
 * The floating panel, promoted from `tELS/client/web/src/components/ui/popover.tsx`.
 *
 * ── Two deliberate differences from the tELS original ───────────────────────
 *
 * 1. **No `solid-motionone`.** The original wrapped the Content in
 *    `<Presence><Motion.div animate={{opacity:[0,1], scale:[0.96,1]}}>`, which pulls
 *    `solid-motionone` (and through it `@motionone/dom`) into every consumer that
 *    imports this file. That is a runtime dependency for a 200ms fade, on a page
 *    rendering over a 3D scene in CEF 103. The enter transition here is a CSS
 *    transition keyed off Ark's own `data-state`, which costs nothing and no
 *    dependency; the trade is that there is no EXIT animation, because a CSS one
 *    needs the element to stay mounted and Ark unmounts it. A popover that vanishes
 *    on close is not a defect in a game overlay.
 *
 *    tELS keeps its own copy and is untouched by this, so nothing there regresses.
 *
 * 2. **No `shadow-md`.** FiveM's CEF does not composite a blurred drop shadow
 *    usefully. Elevation here is `bg-popover` — one rung above the `--card` panel
 *    this opens from, per the ladder at the bottom of theme-tokens.css — plus a
 *    `--border` edge. That is the same recipe `ui/select`'s dropdown uses, so a
 *    popover and a dropdown opened from the same panel look like the same layer.
 *
 * Consumers need `unplugin-icons` for the `~icons/lucide/x` import on
 * `PopoverCloseTrigger`, as they already do for `ui/button`.
 */

/**
 * State for a controlled popover.
 *
 * @example
 * const popover = createPopoverState();
 * return (
 *   <Popover open={popover.isOpen()} onOpenChange={(e) => popover.setOpen(e.open)}>
 *     <PopoverTrigger>Open</PopoverTrigger>
 *     <PopoverContent>…</PopoverContent>
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

export type PopoverProps = Omit<ArkPopover.RootProps, "children"> & {
  children?: JSX.Element;
};

export const Popover = (props: PopoverProps) => {
  const merged = mergeProps({ closeOnInteractOutside: true, closeOnEscape: true }, props);
  return <ArkPopover.Root {...merged} />;
};

export const PopoverTrigger = (props: {
  children?: JSX.Element;
  class?: string;
  title?: string;
}) => {
  const [local, others] = splitProps(props, ["class"]);
  return <ArkPopover.Trigger class={cn(local.class)} {...others} />;
};

export const PopoverAnchor = (props: { children?: JSX.Element; class?: string }) => {
  const [local, others] = splitProps(props, ["class"]);
  return <ArkPopover.Anchor class={cn(local.class)} {...others} />;
};

export const PopoverContent = (props: {
  children?: JSX.Element;
  class?: string;
  showArrow?: boolean;
}) => {
  const [local, others] = splitProps(props, ["children", "class", "showArrow"]);

  return (
    <ArkPopover.Positioner>
      <ArkPopover.Content
        class={cn(
          "z-50 w-72 rounded-lg border border-border bg-popover text-popover-foreground outline-none",
          // The enter transition, in CSS. `data-state` is Ark's own attribute, so
          // this cannot fall out of step with the component's state the way a
          // parallel `Presence` signal can.
          "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-out",
          "data-[state=open]:opacity-100 data-[state=open]:scale-100",
          "data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.96]",
          local.class
        )}
        {...others}
      >
        <Show when={local.showArrow !== false}>
          <ArkPopover.Arrow class="[--arrow-size:12px] [--arrow-background:hsl(var(--popover))]">
            <ArkPopover.ArrowTip class="border-t border-l border-border" />
          </ArkPopover.Arrow>
        </Show>
        {local.children}
      </ArkPopover.Content>
    </ArkPopover.Positioner>
  );
};

export const PopoverTitle = (props: { children?: JSX.Element; class?: string }) => {
  const [local, others] = splitProps(props, ["class"]);
  // 13px, the top step of the scale in surface.css — the heading of a floating
  // panel is the same weight as an editor's header identity and no larger.
  return (
    <ArkPopover.Title
      class={cn("text-[13px] font-semibold text-foreground", local.class)}
      {...others}
    />
  );
};

export const PopoverDescription = (props: { children?: JSX.Element; class?: string }) => {
  const [local, others] = splitProps(props, ["class"]);
  // 12px at FULL `--muted-foreground`, never a fractional one. See rule 2 of the
  // scale at the top of surface.css.
  return (
    <ArkPopover.Description
      class={cn("text-[12px] text-muted-foreground", local.class)}
      {...others}
    />
  );
};

export const PopoverCloseTrigger = (props: { children?: JSX.Element; class?: string }) => {
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

export const PopoverHeader = (props: { children?: JSX.Element; class?: string }) => (
  <div class={cn("flex items-center justify-between p-4 pb-0", props.class)}>{props.children}</div>
);

export const PopoverBody = (props: { children?: JSX.Element; class?: string }) => (
  <div class={cn("p-4", props.class)}>{props.children}</div>
);

export const PopoverFooter = (props: { children?: JSX.Element; class?: string }) => (
  <div class={cn("flex items-center justify-end gap-2 p-4 pt-0", props.class)}>
    {props.children}
  </div>
);

export default Popover;
