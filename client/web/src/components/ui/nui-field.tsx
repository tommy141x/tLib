import { Checkbox } from "@ark-ui/solid/checkbox";
import { Field } from "@ark-ui/solid/field";
import { RadioGroup } from "@ark-ui/solid/radio-group";
import { createListCollection, Select } from "@ark-ui/solid/select";
import { Slider } from "@ark-ui/solid/slider";
import { Check, ChevronDown } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  Switch as MatchType,
  Show,
  splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { DialogField, DialogValue } from "../dialog-model";
import { NUI_CHECKBOX_CLASS, NuiCheckGlyph } from "./nui-controls";
import { applyNuiTheme } from "./nui-theme";
import "./nui.css";

export function NuiButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "primary" | "destructive" | "default";
  }
) {
  const [local, rest] = splitProps(props, ["tone", "class", "type"]);
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      data-tone={local.tone ?? "default"}
      class={`tlib-nui-control tlib-nui-button ${local.class ?? ""}`}
    />
  );
}
const inputClass = "tlib-nui-control tlib-nui-input";

/** Schema-neutral control binding. State and the NUI wire live in the dialog adapter. */
export function NuiField(props: {
  field: DialogField;
  value: DialogValue | undefined;
  error?: string;
  theme?: string;
  active?: boolean;
  onChange: (value: DialogValue) => void;
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
    "aria-invalid": !!props.error,
  });
  const [selectOpen, setSelectOpen] = createSignal(false);
  createEffect(() => {
    if (props.active === false) setSelectOpen(false);
  });
  return (
    <Field.Root
      class="tlib-nui-field"
      data-field-id={props.field.id}
      invalid={!!props.error}
      disabled={props.field.disabled}
    >
      <Show when={props.field.type !== "button" && props.field.type !== "checkbox"}>
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
                  <RadioGroup.ItemHiddenInput aria-required={props.field.required} />
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
                aria-required={props.field.required}
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
                  ref={(el) => createEffect(() => applyNuiTheme(props.theme, el))}
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
            onValueChange={(d) => props.onChange(d.value[0])}
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
        <Match when={props.field.type === "textarea"}>
          <Field.Textarea
            value={String(props.value ?? "")}
            class={`${inputClass} tlib-nui-textarea`}
            rows={3}
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
