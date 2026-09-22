import { describe, expect, test } from "bun:test";
import {
  type DialogData,
  type DialogField,
  effectiveTabs,
  fieldError,
  initialValues,
  matchesDialog,
  validationErrors,
} from "../../client/web/src/components/dialog-model";

const fields: DialogField[] = [
  { id: "person.name", type: "text", label: "Name", required: true },
  { id: "amount", type: "number", label: "Amount", min: 1, max: 5 },
  { id: "enabled", type: "checkbox", label: "Enabled", required: true },
  { id: "speed", type: "slider", label: "Speed", min: 2 },
  { id: "action", type: "button", label: "Action" },
];
describe("dialog schema and Lua wire contract", () => {
  test("defaults preserve string number values, empty optional numbers and false booleans", () => {
    expect(initialValues(fields)).toEqual({
      "person.name": "",
      amount: "",
      enabled: false,
      speed: 2,
    });
    expect(initialValues([{ ...fields[1], defaultValue: 3 }])).toEqual({ amount: "3" });
    expect(fieldError(fields[1], "")).toBeUndefined();
    expect(fieldError(fields[2], false)).toBeUndefined();
  });
  test("required, number bounds and current selection options validate", () => {
    expect(validationErrors(fields, initialValues(fields))).toEqual({
      "person.name": "Name is required.",
    });
    expect(fieldError(fields[1], "0")).toBe("Minimum: 1.");
    expect(fieldError(fields[1], "6")).toBe("Maximum: 5.");
    expect(fieldError(fields[1], "invalid")).toBe("Enter a valid number.");
    expect(
      fieldError(
        { id: "choice", type: "dropdown", label: "Choice", options: [{ value: "a", label: "A" }] },
        "b"
      )
    ).toBe("Choose an available option.");
  });
  test("schema reconciliation keeps edited values, drops removed fields and initializes added fields", () => {
    const changed = [
      fields[0],
      { id: "new", type: "number" as const, label: "New", defaultValue: 4 },
    ];
    expect(initialValues(changed, { "person.name": "Edited", amount: "3" })).toEqual({
      "person.name": "Edited",
      new: "4",
    });
  });
  test("disabled required fields do not prevent submit", () => {
    expect(fieldError({ ...fields[0], disabled: true }, "")).toBeUndefined();
  });
  test("close and update require matching id plus instance", () => {
    const dialog: DialogData = {
      id: "settings",
      instance: 2,
      title: "Settings",
      size: "md",
      fields,
    };
    expect(matchesDialog(dialog, "settings", 1)).toBe(false);
    expect(matchesDialog(dialog, "settings")).toBe(false);
    expect(matchesDialog(dialog, "settings", 2)).toBe(true);
    expect(effectiveTabs({ ...dialog, fields: [{ ...fields[0], tab: "general" }] })).toEqual([
      { id: "general", label: "general" },
    ]);
  });
});
