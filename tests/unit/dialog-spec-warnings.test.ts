/**
 * The dialog spec is data, so its authoring mistakes are checked like data.
 *
 * Every settings surface in the estate is a field list declared in a resource's Lua and
 * drawn by one shared renderer. That is why they all look alike — and why nothing caught
 * them drifting apart in CONTENT. A UI audit on 2026-10-24 measured three dialogs built
 * from this renderer that disagreed on exactly what a stylesheet cannot police: tELS
 * declared three `variant:"primary"` fields which, with the footer's own primary, painted
 * four blue buttons with no hierarchy, while tDetector and tAFK described every control
 * and tELS described none.
 *
 * These tests pin both directions: a clean spec is silent, and each defect is named.
 */
import { describe, expect, test } from "bun:test";
import { type DialogData, dialogSpecWarnings } from "../../client/web/src/components/dialog-model";

const base: DialogData = {
  id: "settings",
  title: "tExample settings",
  size: "md",
  fields: [],
};

const button = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "button" as const,
  label: id,
  description: "what this does",
  ...extra,
});

describe("dialogSpecWarnings", () => {
  test("a clean spec warns about nothing", () => {
    const spec = { ...base, fields: [button("recalibrate"), button("reposition")] };
    expect(dialogSpecWarnings(spec)).toEqual([]);
  });

  test("one primary is allowed — the footer owns the other", () => {
    const spec = { ...base, fields: [button("apply", { variant: "primary" }), button("reset")] };
    expect(dialogSpecWarnings(spec)).toEqual([]);
  });

  test("competing primaries are named, with the field ids", () => {
    // tELS's shape: three primaries plus the footer's, i.e. four blue buttons.
    const spec = {
      ...base,
      fields: [
        button("autoCalibrate", { variant: "primary" }),
        button("serverDefaults", { variant: "primary" }),
        button("openEditor", { variant: "primary" }),
      ],
    };
    const [warning] = dialogSpecWarnings(spec);
    expect(warning).toContain("3 fields");
    expect(warning).toContain("autoCalibrate");
    expect(warning).toContain("openEditor");
  });

  test("an undescribed button is named", () => {
    const spec = { ...base, fields: [button("wipeEverything", { description: undefined })] };
    expect(dialogSpecWarnings(spec).join(" ")).toContain("wipeEverything");
  });

  test("only button fields are judged on variant", () => {
    // A primary-looking slider is not a competing action; the check must not fire on it.
    const spec = {
      ...base,
      fields: [
        { id: "bloom", type: "slider" as const, label: "Bloom", variant: "primary" as const },
        button("apply", { variant: "primary" }),
      ],
    };
    expect(dialogSpecWarnings(spec)).toEqual([]);
  });
});
