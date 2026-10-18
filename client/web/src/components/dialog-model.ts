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
    /**
     * Text, not a control. Carries no value, is never submitted, and is the
     * only type that renders at full opacity with no input beside it.
     *
     * It exists because five resources had each invented a substitute — see the
     * note on `VALID_FIELD_TYPES` in `client/lib/dialog/exports.lua`. A
     * `disabled` button or input is the stack's visual language for "you may
     * not touch this", which is the wrong thing to say about a readout.
     */
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
    // A CHOICE FIELD WITH NO OPTIONS IS NOT A USER ERROR, AND REPORTING IT AS
    // ONE LOCKS THE DIALOG.
    //
    // `errors` gates submission, so "Choose an available option." on a list with
    // nothing in it is a demand the player cannot satisfy — and tRadio's `/tradio`
    // made that reachable: its microphone dropdown renders from a cache that is
    // empty until enumeration answers, so the first open of a session, and EVERY
    // open for a player who denied microphone permission, met a blocked footer
    // button labelled "Close". X and Escape were the only ways out.
    //
    // A value that is not among options that EXIST is still a real error and is
    // still reported — that case the player can act on, by picking another row.
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
/**
 * Whether a click on `fieldId` should be sent to Lua at all.
 *
 * An ACTION TAB owns no field by design -- a sidebar row that opens something
 * rather than switching panel -- and `client/lib/dialog/exports.lua` allows a
 * `dialogButtonClick` naming one. The NUI required a matching enabled `button`
 * field and returned before sending, so every action row in the estate was
 * inert and silent: tRadio's two panels, the prop editors in tRadar and
 * tDetector, tELS's LED editor, tUnit's element editor.
 */
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
