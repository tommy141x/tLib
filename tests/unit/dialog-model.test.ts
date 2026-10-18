import { describe, expect, test } from "bun:test";
import {
  type DialogData,
  type DialogField,
  clickIsSendable,
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
  test("a choice field with no options to choose from does not block the dialog", () => {
    // THE REGRESSION. `errors` gates submission, so reporting an error on a
    // list with nothing in it is a demand the player cannot satisfy. tRadio's
    // `/tradio` reached it: the microphone dropdown renders from a cache that is
    // empty until enumeration answers, and permanently empty for a player who
    // denied microphone permission — so the footer button, labelled "Close",
    // refused to close. Escape and X were the only exits.
    for (const options of [undefined, []]) {
      expect(
        fieldError({ id: "mic", type: "dropdown", label: "Microphone", options }, "default")
      ).toBeUndefined();
    }
    // The distinction being drawn: a value absent from options that EXIST is
    // still an error, because picking another row is an action the player can
    // actually take.
    expect(
      fieldError(
        { id: "mic", type: "dropdown", label: "Microphone", options: [{ value: "a", label: "A" }] },
        "default"
      )
    ).toBe("Choose an available option.");
    // …and `required` is still enforced on an empty value, independently.
    expect(
      fieldError({ id: "mic", type: "dropdown", label: "Microphone", options: [], required: true }, "")
    ).toBe("Microphone is required.");
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

describe("which clicks reach Lua", () => {
  const base: DialogData = { id: "settings", title: "Settings", size: "md", fields };

  test("an action tab is sendable even though it owns no field", () => {
    // The regression. Every sidebar action row in the estate was inert because
    // `fire()` demanded a matching button field and returned before sending.
    const d: DialogData = {
      ...base,
      tabs: [
        { id: "quick", label: "Quick" },
        { id: "openAdminPanel", label: "Admin Panel", action: true },
      ],
    };
    expect(clickIsSendable(d, "openAdminPanel")).toBe(true);
    // A plain tab is not a button: clicking it switches panel, it does not fire.
    expect(clickIsSendable(d, "quick")).toBe(false);
    // An id that names neither is still refused, as the Lua guard refuses it.
    expect(clickIsSendable(d, "nosuchthing")).toBe(false);
  });

  test("a button field still decides on its own type and disabled state", () => {
    expect(clickIsSendable(base, "action")).toBe(true);
    expect(clickIsSendable(base, "person.name")).toBe(false);
    expect(
      clickIsSendable(
        { ...base, fields: [{ id: "action", type: "button", label: "Action", disabled: true }] },
        "action"
      )
    ).toBe(false);
  });
});
