import { Select as ArkSelect, createListCollection } from "@ark-ui/solid";
import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import {
  createContext,
  createMemo,
  For,
  type JSX,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import { Motion, Presence } from "solid-motionone";
import { unoMerge } from "unocss-merge";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const selectTriggerVariants = cva(
  "inline-flex items-center justify-between gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:ring-2 data-[state=open]:ring-ring data-[state=open]:ring-offset-2 hover:border-ring/50 data-[invalid]:border-destructive data-[readonly]:opacity-70 data-[readonly]:cursor-not-allowed min-w-[8rem]",
  {
    variants: {
      variant: {
        default: "border border-input bg-background text-foreground",
        outline:
          "border border-input bg-transparent text-foreground hover:bg-accent",
        ghost: "border-0 hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-10 px-3 py-2",
        sm: "h-9 px-3 text-xs",
        lg: "h-11 px-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Context for Select
interface SelectContextValue {
  items: SelectItemData[];
  getPlaceholder: () => string;
  setPlaceholder: (text: string) => void;
  currentGroupLabel?: string;
  setGroupLabel?: (label: string) => void;
}

interface SelectItemData {
  value: string;
  label: string;
  content: JSX.Element;
  group?: string;
}

const SelectContext = createContext<SelectContextValue>();

// Main Select component
interface SelectProps extends VariantProps<typeof selectTriggerVariants> {
  children?: JSX.Element;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (details: { value: string[] }) => void;
  multiple?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  class?: string;
  positioning?: Record<string, unknown>;
}

export const Select = (props: SelectProps) => {
  const [local, triggerVariants, others] = splitProps(
    props,
    ["children", "class"],
    ["variant", "size"],
  );

  const itemsArray: SelectItemData[] = [];
  let placeholderText = "Select...";

  const contextValue: SelectContextValue = {
    items: itemsArray,
    getPlaceholder: () => placeholderText,
    setPlaceholder: (text: string) => {
      placeholderText = text;
    },
  };

  // Create a wrapper component to ensure items are collected before creating collection
  const SelectWithCollection = () => {
    const collection = createMemo(() => {
      const hasGroups = itemsArray.some((item) => item.group);

      if (hasGroups) {
        return createListCollection({
          items: itemsArray,
          itemToValue: (item: SelectItemData) => item.value,
          itemToString: (item: SelectItemData) => item.label,
          groupBy: (item: SelectItemData) => item.group || "",
        });
      }
      return createListCollection({
        items: itemsArray,
        itemToValue: (item: SelectItemData) => item.value,
        itemToString: (item: SelectItemData) => item.label,
      });
    });

    return (
      <ArkSelect.Root
        collection={collection()}
        class={local.class}
        positioning={{ sameWidth: true }}
        {...others}
      >
        <ArkSelect.Control>
          <ArkSelect.Trigger
            class={cn(
              selectTriggerVariants({
                variant: triggerVariants.variant,
                size: triggerVariants.size,
              }),
            )}
          >
            <ArkSelect.Context>
              {(context) => {
                const selectedValues = () => context().value;
                const selectedItems = () =>
                  itemsArray.filter((item) =>
                    selectedValues().includes(item.value),
                  );

                return (
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <Show
                      when={selectedItems().length > 0}
                      fallback={
                        <span class="text-muted-foreground">
                          {contextValue.getPlaceholder()}
                        </span>
                      }
                    >
                      <div class="flex items-center gap-2 flex-1 min-w-0">
                        <Show
                          when={selectedItems().length === 1}
                          fallback={
                            <div class="flex items-center gap-2 flex-wrap">
                              <For each={selectedItems()}>
                                {(item) => (
                                  <div class="flex items-center gap-1 bg-accent px-2 py-0.5 rounded text-xs">
                                    {item.content}
                                  </div>
                                )}
                              </For>
                            </div>
                          }
                        >
                          <div class="flex items-center gap-2 flex-1 min-w-0 truncate">
                            {selectedItems()[0]?.content}
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </ArkSelect.Context>
            <ArkSelect.Indicator class="transition-transform duration-200 data-[state=open]:rotate-180 shrink-0">
              <IconChevronDown class="h-4 w-4" />
            </ArkSelect.Indicator>
          </ArkSelect.Trigger>
        </ArkSelect.Control>

        <ArkSelect.Positioner>
          <ArkSelect.Context>
            {(context) => {
              const isOpen = () => context().open;

              return (
                <Presence exitBeforeEnter>
                  <Show when={isOpen()}>
                    <Motion.div
                      animate={{
                        opacity: [0, 1],
                        scale: [0.96, 1],
                        y: [-8, 0],
                      }}
                      exit={{ opacity: [1, 0], scale: [1, 0.96], y: [0, -8] }}
                      transition={{
                        duration: 0.2,
                        easing: [0.16, 1, 0.3, 1],
                      }}
                    >
                      <ArkSelect.Content class="z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-background p-1 shadow-md max-h-[300px] overflow-y-auto">
                        <Show
                          when={itemsArray.some((item) => item.group)}
                          fallback={
                            <For each={collection().items}>
                              {(item: SelectItemData) => (
                                <ArkSelect.Item
                                  item={item}
                                  class="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                                >
                                  <div class="flex items-center gap-2 flex-1 min-w-0">
                                    {item.content}
                                  </div>
                                  <ArkSelect.ItemIndicator class="inline-flex h-4 w-4 items-center justify-center shrink-0 ml-2 transition-all duration-200 data-[state=checked]:animate-in data-[state=checked]:fade-in data-[state=checked]:zoom-in-50 [&[hidden]]:hidden">
                                    <IconCheck class="h-4 w-4" />
                                  </ArkSelect.ItemIndicator>
                                </ArkSelect.Item>
                              )}
                            </For>
                          }
                        >
                          <For each={collection().group()}>
                            {([groupLabel, groupItems]: [
                              string,
                              SelectItemData[],
                            ]) => (
                              <ArkSelect.ItemGroup class="p-1 not-first:pt-2">
                                <ArkSelect.ItemGroupLabel class="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                                  {groupLabel}
                                </ArkSelect.ItemGroupLabel>
                                <For each={groupItems}>
                                  {(item: SelectItemData) => (
                                    <ArkSelect.Item
                                      item={item}
                                      class="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                                    >
                                      <div class="flex items-center gap-2 flex-1 min-w-0">
                                        {item.content}
                                      </div>
                                      <ArkSelect.ItemIndicator class="inline-flex h-4 w-4 items-center justify-center shrink-0 ml-2 transition-all duration-200 data-[state=checked]:animate-in data-[state=checked]:fade-in data-[state=checked]:zoom-in-50 [&[hidden]]:hidden">
                                        <IconCheck class="h-4 w-4" />
                                      </ArkSelect.ItemIndicator>
                                    </ArkSelect.Item>
                                  )}
                                </For>
                              </ArkSelect.ItemGroup>
                            )}
                          </For>
                        </Show>
                      </ArkSelect.Content>
                    </Motion.div>
                  </Show>
                </Presence>
              );
            }}
          </ArkSelect.Context>
        </ArkSelect.Positioner>
        <ArkSelect.HiddenSelect />
      </ArkSelect.Root>
    );
  };

  return (
    <SelectContext.Provider value={contextValue}>
      {local.children}
      <SelectWithCollection />
    </SelectContext.Provider>
  );
};

// SelectPlaceholder component
export const SelectPlaceholder = (props: { children: string }) => {
  const context = useContext(SelectContext);
  if (context) {
    context.setPlaceholder(props.children);
  }
  return null;
};

// SelectItem component
export const SelectItem = (props: { value: string; children: JSX.Element }) => {
  const context = useContext(SelectContext);
  if (context) {
    const label =
      typeof props.children === "string" ? props.children : props.value;
    const item: SelectItemData = {
      value: props.value,
      label: label,
      content: props.children,
    };
    if (context.currentGroupLabel) {
      item.group = context.currentGroupLabel;
    }
    context.items.push(item);
  }
  return null;
};

// SelectGroup component
export const SelectGroup = (props: { children: JSX.Element }) => {
  const parentContext = useContext(SelectContext);
  let groupLabelValue = "";

  const groupContext: SelectContextValue = {
    items: parentContext?.items ?? [],
    getPlaceholder: parentContext?.getPlaceholder ?? (() => "Select..."),
    setPlaceholder: parentContext?.setPlaceholder ?? (() => {}),
    setGroupLabel: (label: string) => {
      groupLabelValue = label;
    },
    get currentGroupLabel() {
      return groupLabelValue;
    },
  };

  return (
    <SelectContext.Provider value={groupContext}>
      {props.children}
    </SelectContext.Provider>
  );
};

// SelectLabel component (for group labels)
export const SelectLabel = (props: { children: string }) => {
  const context = useContext(SelectContext);
  if (context?.setGroupLabel) {
    context.setGroupLabel(props.children);
  }
  return null;
};

// Export createListCollection for advanced usage
export { createListCollection };

// Composable API for advanced usage
export const SelectRoot = ArkSelect.Root;

export const SelectTrigger = (props: {
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkSelect.Control>
      <ArkSelect.Trigger class={cn("", local.class)} {...others}>
        {local.children}
      </ArkSelect.Trigger>
    </ArkSelect.Control>
  );
};

export const SelectValueText = (props: {
  placeholder?: string;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class", "placeholder"]);
  return (
    <ArkSelect.ValueText
      class={cn(
        "flex-1 text-left truncate data-placeholder-shown:text-muted-foreground",
        local.class,
      )}
      placeholder={local.placeholder}
      {...others}
    />
  );
};

export const SelectIndicator = (props: {
  children?: JSX.Element;
  class?: string;
}) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <ArkSelect.Indicator
      class={cn(
        "transition-transform duration-200 data-[state=open]:rotate-180",
        local.class,
      )}
      {...others}
    >
      {local.children || <IconChevronDown class="h-4 w-4" />}
    </ArkSelect.Indicator>
  );
};

export const SelectHiddenSelect = ArkSelect.HiddenSelect;

export default Select;
