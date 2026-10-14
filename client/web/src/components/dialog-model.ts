export type DialogValue = string | number | boolean;
export type DialogValues = Record<string, DialogValue>;
export interface DialogField {
  id: string;
  type:
    | "text"
    | "number"
    | "password"
    | "textarea"
    | "select"
    | "dropdown"
    | "radio"
    | "slider"
    | "checkbox"
    | "button";
  label: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  defaultValue?: DialogValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  variant?: "default" | "primary" | "destructive";
  /**
   * On a `button` field: require an explicit confirmation before
   * `onButtonClick` fires, and use this string as the question.
   *
   * Why `variant` was not enough, and why this is not a second mechanism
   *
   * `variant: "destructive"` is COLOUR. It makes a button that deletes something
   * look like one and does nothing else, so "Clear all patterns" and "Rename"
   * were one click apart and one of them was unrecoverable.
   *
   * The confirmation itself is not new. The MENU has had it since the beginning:
   * an item's `confirm` string is schema-validated in
   * `shared/lib/menu/schema.lua` and documented in `docs/content/exports.mdx`,
   * and `menu/Menu.tsx` renders the Cancel/Confirm pair from it. It was simply
   * never wired to dialog buttons — built, validated, documented and, across six
   * resources, passed by none of them. This is the same field name, the same
   * meaning and the same two buttons, on the surface that was missing it.
   *
   * Only `button` fields read it. A value on any other type is ignored rather
   * than rejected: a confirmation on a text input has no click to gate.
   */
  confirm?: string;
  section?: string;
  row?: string;
  flex?: "shrink";
  tab?: string;
}
export interface DialogTab {
  id: string;
  label: string;
  icon?: string;
  action?: boolean;
  separator?: boolean;
  /**
   * Render a built-in view in this tab's panel instead of the dialog's fields.
   *
   * `"marketplace"` mounts `components/marketplace/MarketplaceBrowser`, fed by
   * the `marketplaceData` NUI message (`exports.tLib:ProvideMarketplaceData`).
   * That is how a consumer gets the browser INSIDE its own settings dialog
   * rather than closing the dialog and opening the standalone modal over it.
   *
   * A view tab is a content tab, never an `action` one — `action` is a button
   * that fires `onButtonClick` and owns no panel.
   */
  view?: "marketplace";
}
export interface DialogData {
  id: string;
  instance?: number;
  title: string;
  description?: string;
  size: "sm" | "md" | "lg" | "xl";
  submitLabel?: string;
  cancelLabel?: string;
  theme?: string;
  /**
   * Discard anything remembered about where this dialog id was last left (see
   * `dialog-view-state.ts`) and open it at its defaults. Serialised from
   * `ShowDialog`'s `resetState` option; absent for the overwhelming majority of
   * opens, which want the restore.
   */
  resetState?: boolean;
  fields: DialogField[];
  tabs?: DialogTab[];
}
export function matchesDialog(dialog: DialogData | null, id: string, instance?: number) {
  return !!dialog && dialog.id === id && dialog.instance === instance;
}
export function initialValues(fields: DialogField[], previous: DialogValues = {}): DialogValues {
  return Object.fromEntries(
    fields
      .filter((field) => field.type !== "button")
      .map((field) => {
        const value = Object.hasOwn(previous, field.id)
          ? previous[field.id]
          : (field.defaultValue ??
            (field.type === "checkbox" ? false : field.type === "slider" ? (field.min ?? 0) : ""));
        // Lua's number control contract is text, including the empty optional value.
        return [field.id, field.type === "number" ? String(value) : value];
      })
  );
}
export function fieldError(field: DialogField, value: DialogValue | undefined): string | undefined {
  if (field.disabled || field.type === "button") return;
  const empty = value === undefined || value === "";
  if (empty) return field.required ? `${field.label || "This field"} is required.` : undefined;
  if (field.type === "checkbox")
    return typeof value === "boolean" ? undefined : "Choose on or off.";
  if (field.type === "number" || field.type === "slider") {
    const number = typeof value === "boolean" || String(value).trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(number)) return "Enter a valid number.";
    if (field.min !== undefined && number < field.min) return `Minimum: ${field.min}.`;
    if (field.max !== undefined && number > field.max) return `Maximum: ${field.max}.`;
  }
  if (
    ["select", "dropdown", "radio"].includes(field.type) &&
    !field.options?.some((option) => option.value === value)
  ) {
    return "Choose an available option.";
  }
}
export function validationErrors(
  fields: DialogField[],
  values: DialogValues
): Record<string, string> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const error = fieldError(field, values[field.id]);
      return error ? [[field.id, error]] : [];
    })
  );
}
export function effectiveTabs(dialog: DialogData): DialogTab[] {
  if (dialog.tabs?.length) return dialog.tabs;
  return [...new Set(dialog.fields.flatMap((field) => (field.tab ? [field.tab] : [])))].map(
    (id) => ({ id, label: id })
  );
}
export function groupFieldsByRow(fields: DialogField[]): DialogField[][] {
  const groups: DialogField[][] = [];
  for (const field of fields) {
    const last = groups.at(-1);
    if (field.row && last?.[0].row === field.row) last.push(field);
    else groups.push([field]);
  }
  return groups;
}
