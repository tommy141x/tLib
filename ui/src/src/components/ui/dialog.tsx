import { Dialog as ArkDialog } from "@ark-ui/solid";
import type { DialogInteractOutsideEvent } from "@ark-ui/solid/dialog";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import {
  createSignal,
  type JSX,
  mergeProps,
  children as resolveChildren,
  Show,
  splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Motion, Presence } from "solid-motionone";
import { unoMerge } from "unocss-merge";
import IconX from "~icons/lucide/x";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

// controlled dialog state — without this SolidStart SSR hydration breaks
export function createDialogState() {
  const [open, setOpen] = createSignal(false);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open()),
    isOpen: open,
    setOpen,
  };
}

interface DialogProps {
  children?: JSX.Element;
  open?: boolean;
  onOpenChange?: (details: { open: boolean }) => void;
  closeOnInteractOutside?: boolean;
  closeOnEscape?: boolean;
  modal?: boolean;
  role?: "dialog" | "alertdialog";
  preventScroll?: boolean;
  trapFocus?: boolean;
  lazyMount?: boolean;
  unmountOnExit?: boolean;
  initialFocusEl?: () => HTMLElement | null;
  finalFocusEl?: () => HTMLElement | null;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: DialogInteractOutsideEvent) => void;
}

export const Dialog = (props: DialogProps) => {
  const merged = mergeProps({ defaultOpen: false }, props);
  return <ArkDialog.Root {...merged}>{merged.children}</ArkDialog.Root>;
};

interface DialogTriggerProps {
  children?: JSX.Element;
}

// HACK: ArkDialog.Trigger doesn't attach click handlers on first SSR load.
// Render prop skips hydration so nothing wires up until a re-render.
// Workaround: display:contents div with our own onClick → setOpen(true).
// don't replace with <ArkDialog.Trigger> directly, it WILL break.
// don't try to clone children props either, Solid doesn't work like that.
export const DialogTrigger = (props: DialogTriggerProps) => {
  const resolved = resolveChildren(() => props.children);

  return (
    <ArkDialog.Context>
      {(context) => {
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: transparent wrapper div
          // biome-ignore lint/a11y/useKeyWithClickEvents: child element handles keyboard
          <div
            onClick={() => context().setOpen(true)}
            style={{ display: "contents" }}
          >
            {resolved()}
          </div>
        );
      }}
    </ArkDialog.Context>
  );
};

interface DialogContentProps {
  children?: JSX.Element;
  class?: string;
}

export const DialogContent = (props: DialogContentProps) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <Portal>
      <ArkDialog.Context>
        {(context) => {
          const isOpen = () => context().open;

          return (
            <Presence exitBeforeEnter>
              <Show when={isOpen()}>
                <Motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, easing: "ease-out" }}
                  class="fixed inset-0 z-50 bg-black/50"
                />
              </Show>
            </Presence>
          );
        }}
      </ArkDialog.Context>

      <ArkDialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <ArkDialog.Context>
          {(context) => {
            const isOpen = () => context().open;

            return (
              <Presence exitBeforeEnter>
                <Show when={isOpen()}>
                  <Motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{
                      duration: 0.3,
                      easing: [0.16, 1, 0.3, 1], // Custom easing for smooth spring-like effect
                    }}
                  >
                    <ArkDialog.Content
                      class={cn(
                        "relative w-full max-w-lg rounded-lg bg-background border border-border p-6 shadow-lg",
                        local.class,
                      )}
                      {...others}
                    >
                      <DialogCloseTrigger />
                      {local.children}
                    </ArkDialog.Content>
                  </Motion.div>
                </Show>
              </Presence>
            );
          }}
        </ArkDialog.Context>
      </ArkDialog.Positioner>
    </Portal>
  );
};

interface DialogTitleProps {
  children?: JSX.Element;
  class?: string;
}

export const DialogTitle = (props: DialogTitleProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return (
    <ArkDialog.Title
      class={cn("text-lg font-semibold text-foreground", local.class)}
      {...others}
    />
  );
};

interface DialogDescriptionProps {
  children?: JSX.Element;
  class?: string;
}

export const DialogDescription = (props: DialogDescriptionProps) => {
  const [local, others] = splitProps(props, ["class"]);

  return (
    <ArkDialog.Description
      class={cn("text-sm text-muted-foreground mt-2", local.class)}
      {...others}
    />
  );
};

interface DialogCloseTriggerProps {
  children?: JSX.Element;
  class?: string;
}

export const DialogCloseTrigger = (props: DialogCloseTriggerProps) => {
  const [local, others] = splitProps(props, ["children", "class"]);

  return (
    <ArkDialog.CloseTrigger
      class={cn(
        "absolute right-6 top-6 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none disabled:pointer-events-none",
        local.class,
      )}
      {...others}
    >
      {local.children || (
        <>
          <IconX class="h-4 w-4" />
          <span class="sr-only">Close</span>
        </>
      )}
    </ArkDialog.CloseTrigger>
  );
};

interface DialogFooterProps {
  children?: JSX.Element;
  class?: string;
}

export const DialogFooter = (props: DialogFooterProps) => {
  return (
    <div
      class={cn(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2 mt-6",
        props.class,
      )}
    >
      {props.children}
    </div>
  );
};

interface DialogCloseProps {
  children?: JSX.Element;
}

export const DialogClose = (props: DialogCloseProps) => {
  return <ArkDialog.CloseTrigger>{props.children}</ArkDialog.CloseTrigger>;
};

export default Dialog;
