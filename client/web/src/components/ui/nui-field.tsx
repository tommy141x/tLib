import { Checkbox } from "@ark-ui/solid/checkbox";
import { Field } from "@ark-ui/solid/field";
import { RadioGroup } from "@ark-ui/solid/radio-group";
import { createListCollection, Select } from "@ark-ui/solid/select";
import { Slider } from "@ark-ui/solid/slider";
import { Portal } from "@solidjs/web";
import { Check, ChevronDown } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  Switch as MatchType,
  Show,
} from "solid-js";
// NuiButton moved into the shared package so tELS, tDetector and tRadar can
// mount the marketplace components that use it; nothing in this app is
// reachable from a sibling resource. Re-exported here so the existing import
// sites in tLib keep working. nui.css comes along with it.
import { NuiButton } from "../../../../../shared/ts/nui-kit/NuiButton";
import type { DialogField, DialogValue } from "../dialog-model";
import { NUI_CHECKBOX_CLASS, NuiCheckGlyph } from "./nui-controls";
import { applyNuiTheme, nuiThemeDeps } from "./nui-theme";

export { NuiButton };

const inputClass = "tlib-nui-control tlib-nui-input";

/** Schema-neutral control binding. State and the NUI wire live in the dialog adapter. */
export function NuiField(props: {
  field: DialogField;
  value: DialogValue | undefined;
  error?: string;
  theme?: string;
  active?: boolean;
  /** Commit: local state AND the `dialogChange` push to Lua. */
  onChange: (value: DialogValue) => void;
  /**
   * Local state only, no wire traffic. For a continuous control, where the
   * in-flight value is worth drawing and not worth telling the game about yet.
   * Falls back to `onChange` if a host does not provide it, so the behaviour of
   * an older caller is unchanged rather than silently dropped.
   */
  onPreview?: (value: DialogValue) => void;
  onBlur: () => void;
  onAction: () => void;
}) {
  const uid = createUniqueId();
  const label = `${uid}-label`,
    helper = `${uid}-helper`,
    error = `${uid}-error`;
  const describedBy = () =>
    [props.field.description && helper, props.error && error].filter(Boolean).join(" ") ||
    undefined;
  const collection = createMemo(() => createListCollection({ items: props.field.options ?? [] }));
  const a11y = () => ({
    "aria-labelledby": label,
    "aria-describedby": describedBy(),
    "aria-invalid": props.error ? ("true" as const) : ("false" as const),
  });
  const [selectOpen, setSelectOpen] = createSignal(false);
  // Plain `let`, not a signal: nothing renders from it. It only has to remember
  // what was last put on the wire so an identical value is not put there twice.
  //
  // `previewSlider` CLEARS it, and that is what keeps the de-duplication honest
  // without an effect watching `props.value`. The memory must not outlive the
  // value it describes: commit 10, let Lua push the field back to 5 with
  // `UpdateDialogField`, then drag to 10 again, and a bare `last === next` guard
  // drops a commit the game is waiting for. zag moves the value through
  // `onValueChange` before `onValueChangeEnd` on every path that actually changes
  // it -- drag and keyboard alike -- so "the value moved" and "clear the memory"
  // are the same event. The only path that reaches the commit WITHOUT it is a
  // keypress against a boundary, which is exactly the one to drop.
  let committedSlider: number | undefined;
  const previewSlider = (value: number | undefined) => {
    committedSlider = undefined;
    if (value !== undefined) (props.onPreview ?? props.onChange)(value);
  };
  const commitSlider = (value: number | undefined) => {
    if (value === undefined || value === committedSlider) return;
    committedSlider = value;
    props.onChange(value);
  };
  createEffect(
    () => props.active,
    (active) => {
      if (active === false) setSelectOpen(false);
    }
  );
  return (
    <Field.Root
      class="tlib-nui-field"
      data-field-id={props.field.id}
      invalid={!!props.error}
      disabled={props.field.disabled}
    >
      <Show
        when={
          props.field.type !== "button" &&
          props.field.type !== "checkbox" &&
          props.field.type !== "display"
        }
      >
        <Field.Label id={label} class="tlib-nui-label">
          {props.field.label}
          <Show when={props.field.required}>
            <span aria-hidden="true" class="tlib-nui-required">
              *
            </span>
          </Show>
        </Field.Label>
      </Show>
      <MatchType>
        <Match when={props.field.type === "button"}>
          <NuiButton
            disabled={props.field.disabled}
            tone={props.field.variant}
            onClick={props.onAction}
          >
            {props.field.label}
          </NuiButton>
        </Match>
        <Match when={props.field.type === "checkbox"}>
          {/* Required means a boolean is present, NOT that it must be true. Do not set native required. */}
          <Checkbox.Root
            checked={props.value === true}
            disabled={props.field.disabled}
            invalid={!!props.error}
            onCheckedChange={(d) => props.onChange(d.checked === true)}
            class="tlib-nui-checkbox"
            onFocusOut={props.onBlur}
          >
            {/* The box and the glyph come from nui-controls, which is also what a
              menu row renders — one implementation, two call sites. Ark still
              owns the interaction here; the menu keeps its own. */}
            <Checkbox.Control class={NUI_CHECKBOX_CLASS}>
              <Checkbox.Indicator class="tlib-nui-checkbox-indicator">
                <NuiCheckGlyph />
              </Checkbox.Indicator>
            </Checkbox.Control>
            <Checkbox.Label id={label} class="tlib-nui-label">
              {props.field.label}
              <Show when={props.field.required}>
                <span aria-hidden="true" class="tlib-nui-required">
                  *
                </span>
              </Show>
            </Checkbox.Label>
            <Checkbox.HiddenInput {...a11y()} />
          </Checkbox.Root>
        </Match>
        <Match when={props.field.type === "select" || props.field.type === "radio"}>
          <RadioGroup.Root
            {...a11y()}
            value={String(props.value ?? "")}
            disabled={props.field.disabled}
            onValueChange={(d) => d.value !== null && props.onChange(d.value)}
            onFocusOut={props.onBlur}
            class="tlib-nui-segments"
          >
            <For each={props.field.options ?? []}>
              {(option) => (
                <RadioGroup.Item value={option.value} class="tlib-nui-control tlib-nui-segment">
                  <RadioGroup.ItemText>{option.label}</RadioGroup.ItemText>
                  <RadioGroup.ItemHiddenInput
                    aria-required={props.field.required ? "true" : "false"}
                  />
                </RadioGroup.Item>
              )}
            </For>
          </RadioGroup.Root>
        </Match>
        <Match when={props.field.type === "dropdown"}>
          <Select.Root
            class="tlib-nui-select"
            collection={collection()}
            value={props.value === "" || props.value === undefined ? [] : [String(props.value)]}
            open={props.active !== false && selectOpen()}
            onOpenChange={(d) => setSelectOpen(d.open)}
            disabled={props.field.disabled}
            positioning={{ sameWidth: true, strategy: "fixed" }}
            onValueChange={(d) => d.value[0] !== undefined && props.onChange(d.value[0])}
            onFocusOutside={props.onBlur}
          >
            <Select.Control>
              <Select.Trigger
                {...a11y()}
                aria-required={props.field.required ? "true" : "false"}
                class={`${inputClass} tlib-nui-select-trigger`}
              >
                <Select.ValueText placeholder={props.field.placeholder ?? "Select…"} />
                <Select.Indicator class="tlib-nui-select-indicator">
                  <ChevronDown size={14} />
                </Select.Indicator>
              </Select.Trigger>
            </Select.Control>
            {/* Mount with open, not just with the field: an empty pre-mounted Solid
              portal can be aria-hidden by the parent dialog before aria-controls
              points to its listbox. Closing removes it immediately, including on
              backend close; only the dialog shell owns a visual exit interval. */}
            <Show when={props.active !== false && selectOpen()}>
              <Portal>
                <Select.Positioner
                  class="tlib-nui-surface tlib-nui-select-positioner"
                  ref={(el) =>
                    createEffect(
                      // See nuiThemeDeps: its revision reads must be in compute.
                      () => {
                        nuiThemeDeps();
                        return props.theme;
                      },
                      (theme) => applyNuiTheme(theme, el)
                    )
                  }
                >
                  <Select.Content class="tlib-nui-select-content">
                    <For each={collection().items}>
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
        </Match>
        <Match when={props.field.type === "slider"}>
          <Slider.Root
            min={props.field.min ?? 0}
            max={props.field.max ?? 100}
            step={props.field.step ?? 1}
            value={[Number(props.value ?? props.field.min ?? 0)]}
            disabled={props.field.disabled}
            /* The DISPLAY value only. zag fires this on every pointer move of a
               drag, so committing from here was one `dialogChange` per step —
               and `tRadar/client/cl_settings.lua` answers each one with an
               `UpdateDialogField` push back, making a single drag a full
               NUI→Lua→NUI round trip per pixel in every resource using a tLib
               dialog. This is the only field type with that property; everything
               else here fires once per discrete interaction. */
            onValueChange={(d) => previewSlider(d.value[0])}
            /* The commit. zag calls this on pointer-up AND on each keyboard
               increment/decrement/home/end — verified in
               `@zag-js/slider/dist/slider.machine.mjs`, where `invokeOnChangeEnd`
               is an action on all of those transitions. So keyboard driving still
               commits per keypress, which is what it always did, and only the
               continuous pointer path is debounced to its end.

               `commitSlider` drops a commit whose value equals the last one sent,
               and that is not belt-and-braces. Measured on the drag probe: an
               ArrowRight pressed with the thumb ALREADY at max used to send
               nothing (zag fires no `onValueChange` when the value does not move)
               and would now send one `dialogChange` per keypress, because
               `invokeOnChangeEnd` runs on the transition whether the value moved
               or not. Held against a boundary that is a stream of identical
               writes, which is the bug this whole change is about, just slower. */
            onValueChangeEnd={(d) => commitSlider(d.value[0])}
            onFocusOut={props.onBlur}
          >
            <div class="tlib-nui-slider">
              <Slider.Control class="tlib-nui-slider-control">
                <Slider.Track class="tlib-nui-slider-track">
                  <Slider.Range class="tlib-nui-slider-range" />
                </Slider.Track>
                <Slider.Thumb index={0} {...a11y()} class="tlib-nui-control tlib-nui-slider-thumb">
                  <Slider.HiddenInput />
                </Slider.Thumb>
              </Slider.Control>
              <Slider.ValueText class="tlib-nui-slider-value" />
            </div>
          </Slider.Root>
        </Match>
        {/*
          Text, not a control — no input, no disabled styling, full opacity.
          The label is the text itself, which is why the caption above is
          suppressed for this type; `description` is the second line.
        */}
        <Match when={props.field.type === "display"}>
          <p class="tlib-nui-display">{props.field.label}</p>
        </Match>
        <Match when={props.field.type === "textarea"}>
          <Field.Textarea
            value={String(props.value ?? "")}
            class={`${inputClass} tlib-nui-textarea`}
            rows={props.field.rows ?? 3}
            maxlength={props.field.maxLength}
            required={props.field.required}
            placeholder={props.field.placeholder}
            disabled={props.field.disabled}
            onBlur={props.onBlur}
            onInput={(e) => props.onChange(e.currentTarget.value)}
          />
        </Match>
        <Match when={["text", "number", "password"].includes(props.field.type)}>
          <Field.Input
            type={props.field.type}
            value={String(props.value ?? "")}
            class={inputClass}
            required={props.field.required}
            placeholder={props.field.placeholder}
            disabled={props.field.disabled}
            maxlength={props.field.maxLength}
            min={props.field.min}
            max={props.field.max}
            step="any"
            onBlur={props.onBlur}
            onInput={(e) => props.onChange(e.currentTarget.value)}
          />
        </Match>
      </MatchType>
      <Show when={props.field.description}>
        <Field.HelperText id={helper} class="tlib-nui-helper">
          {props.field.description}
        </Field.HelperText>
      </Show>
      <Show when={props.error}>
        <Field.ErrorText id={error} role="alert" class="tlib-nui-error">
          {props.error}
        </Field.ErrorText>
      </Show>
    </Field.Root>
  );
}
