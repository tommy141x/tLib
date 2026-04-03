/**
 * Input Component - Multi-variant input with support for text, password, tags, textarea, and combobox
 *
 * Fixed: Controlled input handling (value prop)
 * - 'value', 'defaultValue', and 'onValueChange' are now only extracted for tags variant
 * - For all other input types, these props pass through {...others} to Field.Input
 * - This allows proper controlled component behavior with value={signal()}
 */

import { Field } from "@ark-ui/solid";
import {
  Combobox as ArkCombobox,
  useListCollection,
} from "@ark-ui/solid/combobox";
import { useFilter } from "@ark-ui/solid/locale";
import { TagsInput as ArkTagsInput } from "@ark-ui/solid/tags-input";
import { cva, type VariantProps } from "class-variance-authority";
import type { ClassValue } from "clsx";
import clsx from "clsx";
import {
  type Component,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  type JSX,
  Show,
  splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import { unoMerge } from "unocss-merge";
import IconAlertCircle from "~icons/lucide/alert-circle";
import IconCheck from "~icons/lucide/check";
import IconCheckCircle from "~icons/lucide/check-circle";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";
import IconX from "~icons/lucide/x";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

const inputVariants = cva(
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 ease-out hover:border-ring/50 focus-visible:border-ring",
  {
    variants: {
      variant: {
        default: "",
        password: "pr-10",
        tags: "h-auto min-h-10 flex flex-wrap items-center gap-1.5 p-1.5 focus-visible:ring-0",
        textarea: "min-h-20 resize-none",
        combobox: "",
      },
      size: {
        default: "h-10 text-sm",
        sm: "h-9 text-xs",
        lg: "h-12 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const tagVariants = cva(
  "inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-0.5 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      size: {
        default: "text-xs h-6",
        sm: "text-[10px] h-5 px-1.5",
        lg: "text-xs h-7 px-2.5",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

// Input component with variants
type InputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement> &
    JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "type"
> &
  VariantProps<typeof inputVariants> & {
    type?:
      | "text"
      | "email"
      | "password"
      | "tags"
      | "textarea"
      | "number"
      | "tel"
      | "url"
      | "search"
      | "combobox";
    class?: string;
    // Combobox-specific props
    options?: Array<string | { label: string; value: string }>;
    onSelect?: (details: { value: string[] }) => void;
    clearable?: boolean;
    // Field-related props
    id?: string;
    name?: string;
    form?: string;
    disabled?: boolean;
    readOnly?: boolean;
    required?: boolean;
    invalid?: boolean;
    // Label and validation props
    label?: string;
    labelClass?: string;
    error?: string;
    success?: string;
    helperText?: string;
    wrapperClass?: string;
    // Password-specific props
    autoComplete?: "current-password" | "new-password";
    defaultVisible?: boolean;
    visible?: boolean;
    onVisibilityChange?: (details: { visible: boolean }) => void;
    ignorePasswordManagers?: boolean;
    // Textarea-specific props
    autoresize?: boolean;
    // Tags-specific props
    value?: string | string[];
    defaultValue?: string[];
    onValueChange?: (details: { value: string[] }) => void;
    max?: number;
    maxLength?: number;
    addOnPaste?: boolean;
    blurBehavior?: "add" | "clear";
    delimiter?: string | RegExp;
    editable?: boolean;
    allowOverflow?: boolean;
    validate?: (details: { value: string[]; inputValue: string }) => boolean;
  };

export const Input = (props: InputProps) => {
  // Determine if this is a tags variant to conditionally extract value props
  const isTagsVariant = props.type === "tags" || props.variant === "tags";

  // Generate unique ID if not provided
  const inputId = createUniqueId();
  const fieldId = () => props.id || inputId;

  // Split props - extract label and validation props first
  const [wrapperProps, inputPropsWithLocal] = splitProps(props, [
    "label",
    "labelClass",
    "error",
    "success",
    "helperText",
    "wrapperClass",
  ]);

  // Then split the rest
  const [local, others] = splitProps(inputPropsWithLocal, [
    "class",
    "size",
    "variant",
    "type",
    "name",
    "form",
    "disabled",
    "readOnly",
    "required",
    "invalid",
    "autoComplete",
    "defaultVisible",
    "visible",
    "onVisibilityChange",
    "ignorePasswordManagers",
    "autoresize",
    // Only extract these for tags variant - otherwise let them pass through
    ...(isTagsVariant
      ? (["value", "defaultValue", "onValueChange"] as const)
      : []),
    "max",
    "maxLength",
    "addOnPaste",
    "blurBehavior",
    "delimiter",
    "editable",
    "allowOverflow",
    "validate",
    "options",
    "onSelect",
    "clearable",
  ] as const);

  // Determine if field has error or success state
  const hasError = createMemo(() => !!wrapperProps.error);
  const hasSuccess = createMemo(() => !!wrapperProps.success && !hasError());

  const [showPassword, setShowPassword] = createSignal(
    local.defaultVisible ?? false,
  );

  // Handle controlled visibility
  const isPasswordVisible = () => local.visible ?? showPassword();

  const togglePasswordVisibility = () => {
    const newValue = !isPasswordVisible();
    setShowPassword(newValue);
    local.onVisibilityChange?.({ visible: newValue });
  };

  // Determine variant based on type
  const effectiveVariant = () => {
    if (local.variant) return local.variant;
    if (local.type === "password") return "password";
    if (local.type === "tags") return "tags";
    if (local.type === "textarea") return "textarea";
    if (local.type === "combobox") return "combobox";
    return "default";
  };

  // Password variant
  const isPassword = () => effectiveVariant() === "password";

  // Tags variant
  const isTags = () => effectiveVariant() === "tags";

  // Textarea variant
  const isTextarea = () => effectiveVariant() === "textarea";

  // Combobox variant
  const isCombobox = () => effectiveVariant() === "combobox";

  // ComboboxInput is a named component that owns the useFilter /
  // useListCollection hook calls for the combobox variant. Placing these
  // hooks inside an IIFE that is called inline in JSX creates them outside
  // a stable Solid owner and causes SSR/client hydration mismatches
  // ("template is not a function"). A named component fixes this.
  const ComboboxInput: Component = () => {
    const filterFn = useFilter({ sensitivity: "base" });
    const items = (local.options || []).map((opt) =>
      typeof opt === "string" ? opt : opt.label,
    );

    const { collection, filter } = useListCollection({
      initialItems: items,
      filter: filterFn().contains,
    });

    const handleInputChange = (details: { inputValue: string }) => {
      filter(details.inputValue);
    };

    const handleValueChange = (details: { value: string[] }) => {
      local.onSelect?.(details);
    };

    return (
      <ArkCombobox.Root
        collection={collection()}
        onInputValueChange={handleInputChange}
        onValueChange={handleValueChange}
        disabled={local.disabled}
        readOnly={local.readOnly}
        invalid={local.invalid}
        required={local.required}
        name={local.name}
        form={local.form}
        id={fieldId()}
        positioning={{ sameWidth: true }}
      >
        <ArkCombobox.Context>
          {(context) => (
            <>
              <ArkCombobox.Control class="relative">
                <ArkCombobox.Input
                  class={cn(
                    inputVariants({
                      variant: effectiveVariant(),
                      size: local.size,
                    }),
                    local.clearable &&
                      (context().value.length > 0 || context().inputValue)
                      ? "pr-20"
                      : "pr-10",
                    local.class,
                  )}
                  {...others}
                />
                <Show
                  when={
                    local.clearable &&
                    (context().value.length > 0 || context().inputValue)
                  }
                >
                  <ArkCombobox.ClearTrigger class="absolute right-10 top-0 h-full px-2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-50">
                    <IconX class="h-3.5 w-3.5" />
                  </ArkCombobox.ClearTrigger>
                </Show>
                <ArkCombobox.Trigger class="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-50">
                  <IconChevronDown class="h-4 w-4" />
                </ArkCombobox.Trigger>
              </ArkCombobox.Control>
              <Portal>
                <ArkCombobox.Positioner>
                  <Show when={context().open}>
                    <ArkCombobox.Content class="z-50 min-w-(--reference-width) max-h-[300px] overflow-y-auto rounded-md border border-border bg-background p-1 shadow-md outline-none focus:outline-none focus-visible:outline-none">
                      <Show when={collection().items.length === 0}>
                        <div class="px-2 py-6 text-center text-sm text-muted-foreground">
                          No results found
                        </div>
                      </Show>
                      <For each={collection().items}>
                        {(item) => (
                          <ArkCombobox.Item
                            item={item}
                            class="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
                          >
                            <ArkCombobox.ItemText>{item}</ArkCombobox.ItemText>
                            <Show
                              when={
                                collection().stringifyItem(item) &&
                                context().value.includes(
                                  collection().stringifyItem(item) ?? "",
                                )
                              }
                            >
                              <ArkCombobox.ItemIndicator class="ml-auto inline-flex h-4 w-4 items-center justify-center shrink-0">
                                <IconCheck class="h-4 w-4" />
                              </ArkCombobox.ItemIndicator>
                            </Show>
                          </ArkCombobox.Item>
                        )}
                      </For>
                    </ArkCombobox.Content>
                  </Show>
                </ArkCombobox.Positioner>
              </Portal>
            </>
          )}
        </ArkCombobox.Context>
      </ArkCombobox.Root>
    );
  };

  // InputContent is a named component so SolidJS treats it as a reactive node
  // in the render tree. Calling a plain helper as {renderInput()} bakes its
  // result into a static snapshot — a named component re-runs when its tracked
  // signals (isPasswordVisible, effectiveVariant, etc.) change, preventing
  // "template is not a function" hydration errors.
  const InputContent: Component = () => (
    <Show
      when={!isTags() && !isTextarea() && !isCombobox()}
      fallback={
        <Show
          when={isCombobox()}
          fallback={
            <Show
              when={isTags()}
              fallback={
                <Field.Textarea
                  autoresize={local.autoresize}
                  class={cn(
                    inputVariants({
                      variant: effectiveVariant(),
                      size: local.size,
                    }),
                    local.class,
                  )}
                  // biome-ignore lint/suspicious/noExplicitAny: ark-ui type compatibility
                  {...(others as any)}
                />
              }
            >
              <ArkTagsInput.Root
                value={Array.isArray(local.value) ? local.value : undefined}
                defaultValue={local.defaultValue}
                onValueChange={local.onValueChange}
                max={local.max}
                maxLength={local.maxLength}
                addOnPaste={local.addOnPaste}
                blurBehavior={local.blurBehavior}
                delimiter={local.delimiter}
                editable={local.editable}
                allowOverflow={local.allowOverflow}
                validate={local.validate}
                disabled={local.disabled}
                readOnly={local.readOnly}
                invalid={local.invalid}
                required={local.required}
                name={local.name}
                form={local.form}
                id={fieldId()}
              >
                <ArkTagsInput.Context>
                  {(api) => (
                    <>
                      <ArkTagsInput.Control
                        class={cn(
                          inputVariants({
                            variant: effectiveVariant(),
                            size: local.size,
                          }),
                          local.class,
                        )}
                      >
                        <Index each={api().value}>
                          {(value, index) => (
                            <ArkTagsInput.Item index={index} value={value()}>
                              <ArkTagsInput.ItemPreview
                                class={cn(
                                  tagVariants({ size: local.size }),
                                  "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                                )}
                              >
                                <ArkTagsInput.ItemText class="select-none">
                                  {value()}
                                </ArkTagsInput.ItemText>
                                <ArkTagsInput.ItemDeleteTrigger class="inline-flex items-center justify-center rounded-sm hover:bg-accent hover:text-accent-foreground transition-colors focus:outline-none">
                                  <IconX class="h-2.5 w-2.5" />
                                </ArkTagsInput.ItemDeleteTrigger>
                              </ArkTagsInput.ItemPreview>
                              <ArkTagsInput.ItemInput class="bg-transparent outline-none placeholder:text-muted-foreground" />
                            </ArkTagsInput.Item>
                          )}
                        </Index>
                        <ArkTagsInput.Input
                          class="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          // biome-ignore lint/suspicious/noExplicitAny: ark-ui type compatibility
                          {...(others as any)}
                        />
                      </ArkTagsInput.Control>
                      <ArkTagsInput.HiddenInput />
                    </>
                  )}
                </ArkTagsInput.Context>
              </ArkTagsInput.Root>
            </Show>
          }
        >
          {/* Combobox variant — ComboboxInput is a named component so SolidJS
              treats it as a reactive node. Calling an IIFE that returns JSX
              bakes the result (including hook calls like useFilter /
              useListCollection) into a static snapshot, causing "template is
              not a function" on hydration. A named component re-runs
              reactively and keeps hooks inside a stable owner. */}
          <ComboboxInput />
        </Show>
      }
    >
      <Show
        when={!isPassword()}
        fallback={
          <div class="relative">
            <Field.Input
              type={isPasswordVisible() ? "text" : "password"}
              autocomplete={local.autoComplete}
              id={fieldId()}
              name={local.name}
              form={local.form}
              disabled={local.disabled}
              readOnly={local.readOnly}
              required={local.required}
              data-1p-ignore={local.ignorePasswordManagers}
              data-lpignore={local.ignorePasswordManagers}
              data-form-type={
                local.ignorePasswordManagers ? "other" : undefined
              }
              class={cn(
                inputVariants({
                  variant: effectiveVariant(),
                  size: local.size,
                }),
                local.class,
              )}
              {...others}
            />
            <button
              type="button"
              onClick={togglePasswordVisibility}
              disabled={local.disabled}
              class="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPasswordVisible() ? (
                <IconEyeOff class="h-4 w-4" />
              ) : (
                <IconEye class="h-4 w-4" />
              )}
            </button>
          </div>
        }
      >
        <Field.Input
          // biome-ignore lint/suspicious/noExplicitAny: Field.Input type narrowing
          type={local.type as any}
          id={fieldId()}
          name={local.name}
          form={local.form}
          disabled={local.disabled}
          readOnly={local.readOnly}
          required={local.required}
          class={cn(
            inputVariants({ variant: effectiveVariant(), size: local.size }),
            hasError() && "border-destructive focus-visible:ring-destructive",
            hasSuccess() && "border-green-500 focus-visible:ring-green-500",
            local.class,
          )}
          {...others}
        />
      </Show>
    </Show>
  );

  // If no label or validation props, return the input directly
  if (
    !wrapperProps.label &&
    !wrapperProps.error &&
    !wrapperProps.success &&
    !wrapperProps.helperText
  ) {
    return <InputContent />;
  }

  // Otherwise, wrap with label and validation feedback
  return (
    <div class={cn("space-y-2", wrapperProps.wrapperClass)}>
      {/* Label */}
      <Show when={wrapperProps.label}>
        <label
          for={fieldId()}
          class={cn(
            "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
            wrapperProps.labelClass,
          )}
        >
          {wrapperProps.label}
          <Show when={local.required}>
            <span class="text-destructive ml-1">*</span>
          </Show>
        </label>
      </Show>

      {/* Input */}
      <InputContent />

      {/* Error Message */}
      <Show when={hasError()}>
        <div class="flex items-start gap-1.5 text-sm text-destructive">
          <IconAlertCircle class="h-4 w-4 mt-0.5 shrink-0" />
          <span>{wrapperProps.error}</span>
        </div>
      </Show>

      {/* Success Message */}
      <Show when={hasSuccess()}>
        <div class="flex items-start gap-1.5 text-sm text-green-600 dark:text-green-400">
          <IconCheckCircle class="h-4 w-4 mt-0.5 shrink-0" />
          <span>{wrapperProps.success}</span>
        </div>
      </Show>

      {/* Helper Text */}
      <Show when={wrapperProps.helperText && !hasError() && !hasSuccess()}>
        <p class="text-sm text-muted-foreground">{wrapperProps.helperText}</p>
      </Show>
    </div>
  );
};

export default Input;
