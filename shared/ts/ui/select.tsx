import { Select as ArkSelect, createListCollection } from "@ark-ui/solid";
import { cn } from "@tlib/shared/cn";
import { createMemo, For } from "solid-js";
import { Portal } from "@solidjs/web";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";

/**
 * The dropdown.
 *
 * ── This file replaced an earlier tLib select, and why ──────────────────────
 *
 * The version before this was a cva component with three `size` tiers crossed with
 * three `density` tiers, whose smallest combination was 9px text in a 20px box. It
 * had ZERO importers across the seven UI-bearing resources — both editors that
 * needed a dropdown had looked at it, refused it, and written their own on
 * `@ark-ui/solid` directly. This is that fork, promoted back. The two things they
 * each refused it for:
 *
 *   1. It painted its Content `bg-background` — the token for a DIALOG'S SHELL, the
 *      bottom of tLib's elevation ladder at 6.67%. Opened from a `--card` panel
 *      that is the same 6.67%, the list and the panel behind it are one colour with
 *      a border between them. That is the "black text on a dark grey selector"
 *      report. It is `bg-popover` here, which is tLib's own floating surface at
 *      9.8% — one rung ABOVE the panel it opens from, which is what a floating
 *      surface is for. (See the ladder at the bottom of theme-tokens.css. A round
 *      of this was once "fixed" from the palette end by raising `--card`,
 *      `--popover` AND `--background`; that inverted the ladder and made every
 *      other control's `border-input` darker than its panel. The palette is not the
 *      place to fix one component.)
 *
 *   2. Its trigger's `border-input` edge was `--input` — the same token as its own
 *      fill, so the border was invisible by construction. The trigger here is
 *      `.prop-input` from `@tlib/shared/css/surface.css`, the same class
 *      `ui/input.tsx` uses, so the dropdown and the text field beside it are
 *      visibly the same kind of thing and cannot drift apart.
 *
 * Also: no elevation on the Content. FiveM's CEF does not composite a blurred one
 * usefully; it costs a compositor pass over a moving 3D scene and buys nothing.
 * Nothing in `shared/ts/ui/*` carries one any more, and the shared preset now
 * blocklists the family outright for a nui build.
 *
 * Consumers must import `@tlib/shared/css/surface.css` for `.prop-input`, and have
 * `unplugin-icons` configured — the two `~icons/lucide/*` imports are synthesised
 * by it at build time, as they already are for `ui/button`.
 */

export type SelectItem = { value: string; label: string } | string;

export interface SelectProps {
  items: SelectItem[];
  /** The empty string means "nothing chosen", which is how an unset value arrives. */
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  size?: "sm" | "default";
  /**
   * The accessible name for the control, announced before its value.
   *
   * Ark's trigger renders a combobox whose only text is the CURRENT VALUE, so
   * without this a screen reader reads "Inter, combobox" and never says what the
   * font applies to. Required rather than optional: a dropdown in these editors
   * sits under a `Field` caption that the control itself does not inherit.
   */
  label: string;
}

/**
 * Two tiers, and the small one is 11px.
 *
 * There is no third. The scale at the top of surface.css puts the floor at 11px,
 * measured: a 10px webfont on a dark surface in CEF 103 has almost no stem left,
 * and that — not the typeface — is every "the fonts are poor" report this library
 * has collected. A `dense` tier at 9px is what the previous select shipped and what
 * tELS then had to override back up to 12px with `!important` from its own
 * global.css.
 *
 * Exported so `select.test.ts` can assert the RESOLVED classes rather than trust
 * the table by eye. Sizes here are plain strings through `cn`, not cva: with one
 * variant axis there is no precedence to get wrong, which is what the cva version's
 * test was guarding.
 */
export const SELECT_SIZES = {
  sm: { trigger: "min-h-[26px] !text-[11px]", item: "px-2 py-1 text-[11px]" },
  default: { trigger: "min-h-[30px]", item: "px-2 py-1.5 text-[12px]" },
} as const;

/**
 * The Content surface, exported for the same reason: `bg-popover` vs `bg-background`
 * is the whole bug above, and it is one token edit away from coming back.
 */
export const SELECT_CONTENT_CLASS =
  "z-[100] max-h-[220px] w-full overflow-y-auto rounded-[var(--radius-control)] border border-border bg-popover p-1 text-popover-foreground";

export function Select(props: SelectProps) {
  // This used to take a picked-only `splitProps` bag and read through it. Solid 2's
  // `omit` has no picked half — it returns the rest object alone — and there is no
  // rest to bind here: SelectProps is closed over exactly these eight keys, so the
  // remainder is always empty, and a rest that is always empty reads like props are
  // being dropped somewhere. So the bag is simply gone and every read is `props.x`,
  // which is the reactive access anyway.

  const normalize = (item: SelectItem) =>
    typeof item === "string" ? { value: item, label: item } : item;

  const collection = createMemo(() =>
    createListCollection({
      items: props.items.map(normalize),
      itemToValue: (i) => i.value,
      itemToString: (i) => i.label,
    })
  );

  const sz = () => SELECT_SIZES[props.size ?? "default"];

  return (
    <ArkSelect.Root
      collection={collection()}
      // `[]`, not `undefined`, for the unset case. Passing `undefined` to a
      // controlled Ark Select hands the value back to its own internal state, so a
      // record cleared server-side would leave the old label on screen.
      value={props.value ? [props.value] : []}
      onValueChange={(d) => props.onChange?.(d.value[0] ?? "")}
      disabled={props.disabled}
      positioning={{ fitViewport: true, sameWidth: true }}
    >
      <ArkSelect.Control>
        <ArkSelect.Trigger
          aria-label={props.label}
          class={cn(
            // `.prop-input` already carries the `[data-state="open"]` focus
            // outline that Ark sets here.
            "prop-input inline-flex items-center justify-between gap-1.5 text-left",
            sz().trigger,
            props.class
          )}
        >
          <ArkSelect.ValueText
            placeholder={props.placeholder}
            class="min-w-0 flex-1 truncate text-foreground data-[placeholder]:text-muted-foreground"
          />
          <ArkSelect.Indicator class="shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-180">
            <IconChevronDown class="h-3.5 w-3.5" />
          </ArkSelect.Indicator>
        </ArkSelect.Trigger>
      </ArkSelect.Control>

      {/* Portalled to `document.body`, so the list is not clipped by an
          `overflow-y-auto` on the panel it opens inside. */}
      <Portal>
        <ArkSelect.Positioner>
          <ArkSelect.Content
            class={SELECT_CONTENT_CLASS}
            // A wheel over the list scrolls the LIST and stops there. Kept even
            // where nothing downstream would receive it today, because that is one
            // refactor away from being untrue and the failure — a dropdown that
            // zooms the game camera while it scrolls — gets blamed on the dropdown.
            onWheel={(e: WheelEvent) => e.stopPropagation()}
          >
            <For each={collection().items}>
              {(item) => (
                <ArkSelect.Item
                  item={item}
                  class={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-tight)] font-mono text-foreground outline-none",
                    "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                    "data-[state=checked]:text-primary data-[state=checked]:data-[highlighted]:text-accent-foreground",
                    sz().item
                  )}
                >
                  <ArkSelect.ItemText class="truncate">{item.label}</ArkSelect.ItemText>
                  <ArkSelect.ItemIndicator class="shrink-0">
                    <IconCheck class="h-3.5 w-3.5" />
                  </ArkSelect.ItemIndicator>
                </ArkSelect.Item>
              )}
            </For>
          </ArkSelect.Content>
        </ArkSelect.Positioner>
      </Portal>

      <ArkSelect.HiddenSelect />
    </ArkSelect.Root>
  );
}

export default Select;
