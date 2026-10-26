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
    | "button"
    // Text, not a control: no value, never submitted, full opacity with no input
    // beside it. Added because five resources had each invented a substitute (see
    // `VALID_FIELD_TYPES` in client/lib/dialog/exports.lua) — a disabled button/input
    // means "you may not touch this", the wrong thing to say about a readout.
    | "display";
  label: string;
  description?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  defaultValue?: DialogValue;
  min?: number;
  max?: number;
  step?: number;
  /** Text-ish fields only: the cap the page enforces, so a server-side limit is visible. */
  maxLength?: number;
  /** `textarea` only. Was hard-coded to 3 with no way through. */
  rows?: number;
  options?: { value: string; label: string }[];
  variant?: "default" | "primary" | "destructive";
  // On a `button` field: require explicit confirmation before `onButtonClick`
  // fires, using this string as the question. `variant: "destructive"` is colour
  // only, so it doesn't gate anything. The menu has had this mechanism since the
  // beginning (schema-validated in shared/lib/menu/schema.lua, rendered by
  // menu/Menu.tsx) but it was never wired to dialog buttons — same field name,
  // same meaning, same two buttons, now reaching this surface too. Only `button`
  // fields read it; other types ignore it.
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
  // Render a built-in view in this tab's panel instead of the dialog's fields.
  // `"marketplace"` mounts components/marketplace/MarketplaceBrowser, fed by the
  // `marketplaceData` NUI message (exports.tLib:ProvideMarketplaceData) — lets a
  // consumer embed the browser in its own settings dialog instead of stacking the
  // standalone modal over it. Always a content tab, never `action` (which owns no panel).
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
  // Discard the remembered view (dialog-view-state.ts) and open at defaults.
  // Serialised from ShowDialog's `resetState` option; absent for most opens,
  // which want the restore.
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
      .filter((field) => field.type !== "button" && field.type !== "display")
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
  if (field.disabled || field.type === "button" || field.type === "display") return;
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
  if (["select", "dropdown", "radio"].includes(field.type)) {
    // An empty options list is not a user error — `errors` gates submission, so
    // reporting one would be a demand the player cannot satisfy. tRadio's microphone
    // dropdown hit this: empty until enumeration answers, or permanently for a player
    // who denied mic permission, leaving only X/Escape to close. A value absent from
    // options that DO exist is still a real, reportable error.
    const options = field.options;
    if (options?.length && !options.some((option) => option.value === value)) {
      return "Choose an available option.";
    }
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
// Whether a click on `fieldId` should be sent to Lua at all. An action tab owns no
// field by design (a sidebar row that opens something rather than switching panel),
// and client/lib/dialog/exports.lua allows a `dialogButtonClick` naming one — but the
// NUI required a matching enabled `button` field and returned before sending, so every
// action row in the estate (tRadio's two panels, tRadar/tDetector prop editors, tLS's
// LED editor, tUnit's element editor) was inert and silent.
export function clickIsSendable(dialog: DialogData, fieldId: string): boolean {
  const field = dialog.fields.find((entry) => entry.id === fieldId);
  if (field) return field.type === "button" && !field.disabled;
  // No field: allowed only when the id names an action tab. An unknown id is
  // still refused, exactly as the Lua guard refuses one.
  return effectiveTabs(dialog).some((tab) => tab.id === fieldId && tab.action);
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
