import { createListCollection, Select } from "@ark-ui/solid/select";
import { Portal } from "@solidjs/web";
import { Check, ChevronDown } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";

const collection = createListCollection({
  items: [
    { label: "Most downloads", value: "downloads" },
    { label: "Recently added", value: "created_at" },
  ],
});

/** Marketplace owns its sort state; Ark owns listbox navigation and focus return. */
export function MarketplaceSort(props: {
  value: "downloads" | "created_at";
  onChange: (value: "downloads" | "created_at") => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <Select.Root
      class="tlib-nui-select mp-sort"
      collection={collection}
      value={[props.value]}
      open={open()}
      onOpenChange={(d) => setOpen(d.open)}
      positioning={{ sameWidth: true, strategy: "fixed" }}
      onValueChange={(d) => {
        const value = d.value[0];
        if (value === "downloads" || value === "created_at") props.onChange(value);
      }}
    >
      <Select.Control>
        <Select.Trigger
          aria-label="Sort items"
          class="tlib-nui-control tlib-nui-input tlib-nui-select-trigger"
        >
          <Select.ValueText />
          <Select.Indicator class="tlib-nui-select-indicator">
            <ChevronDown size={16} />
          </Select.Indicator>
        </Select.Trigger>
      </Select.Control>
      <Show when={open()}>
        <Portal>
          <Select.Positioner class="tlib-nui-surface tlib-nui-select-positioner">
            <Select.Content class="tlib-nui-select-content">
              <For each={collection.items}>
                {(item) => (
                  <Select.Item item={item} class="tlib-nui-select-item">
                    <Select.ItemText>{item.label}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={14} />
                    </Select.ItemIndicator>
                  </Select.Item>
                )}
              </For>
            </Select.Content>
          </Select.Positioner>
        </Portal>
      </Show>
      <Select.HiddenSelect />
    </Select.Root>
  );
}
