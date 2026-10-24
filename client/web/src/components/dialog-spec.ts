import type { DialogData } from "./dialog-model";

/**
 * Authoring mistakes in a dialog SPEC. These dialogs are DATA — a field list declared in
 * a resource's Lua, drawn by one renderer — so they look alike while drifting apart in
 * content, where no stylesheet reaches. Measured 2026-10-24: tLS declared three
 * `variant:"primary"` fields (four blue buttons with the footer's); tDetector and tAFK
 * described every control, tLS none. Warns, never throws: an ugly dialog must open.
 */
export function dialogSpecWarnings(dialog: DialogData): string[] {
  const warnings: string[] = [];

  // The footer's submit is already primary, so a primary FIELD competes with it.
  const primaries = dialog.fields.filter(
    (field) => field.type === "button" && field.variant === "primary"
  );
  if (primaries.length > 1) {
    warnings.push(
      `${primaries.length} fields declare variant:"primary" (${primaries
        .map((f) => f.id)
        .join(", ")}). The footer's submit button is already the primary action, so ` +
        `these compete with it and with each other — leave one, or none.`
    );
  }

  // A button that acts on the world with nothing saying what it will do.
  const undescribed = dialog.fields.filter(
    (field) => field.type === "button" && !field.description
  );
  if (undescribed.length > 0) {
    warnings.push(
      `button field(s) with no description: ${undescribed.map((f) => f.id).join(", ")}. ` +
        `A button in a settings dialog changes something; say what, as tDetector and ` +
        `tAFK do on every control.`
    );
  }

  return warnings;
}
