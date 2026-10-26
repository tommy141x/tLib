import type { DialogData } from "./dialog-model";

// Authoring mistakes in a dialog spec. Dialogs are data — a field list declared in a
// resource's Lua, drawn by one renderer — so they drift apart in content where no
// stylesheet reaches: tLS has shipped three `variant:"primary"` fields (four blue
// buttons counting the footer's) and no field descriptions. Warns, never throws: an
// ugly dialog must still open.
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
