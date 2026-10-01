/**
 * The localisation fallback.
 *
 * tLib owns no consumer's locale file, so the whole contract is "take a
 * translator, ship English". The failure this pins is a half-done translation:
 * a key present but blank must read as English, not as an empty button.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROP_EDITOR_STRINGS,
  makePropEditorTranslator,
} from "../../shared/ts/prop-editor/strings";
import type { PropEditorStringKey } from "../../shared/ts/prop-editor/types";

describe("prop editor strings", () => {
  test("every key has a non-empty English default", () => {
    const entries = Object.entries(DEFAULT_PROP_EDITOR_STRINGS);
    expect(entries.length).toBe(36);
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  test("no translator at all still renders English", () => {
    const T = makePropEditorTranslator();
    expect(T("btn_save")).toBe("Save");
    expect(T("hint_esc_key")).toBe("Esc");
  });

  test("a host translation wins", () => {
    const T = makePropEditorTranslator((k) => (k === "btn_save" ? "Enregistrer" : undefined));
    expect(T("btn_save")).toBe("Enregistrer");
    expect(T("btn_cancel")).toBe("Cancel");
  });

  test("a key present but blank falls back rather than rendering nothing", () => {
    const T = makePropEditorTranslator(() => "");
    expect(T("btn_remove_prop")).toBe("Remove Prop");
  });

  test("the space title carries the {space} placeholder the chrome substitutes", () => {
    expect(DEFAULT_PROP_EDITOR_STRINGS.btn_space_title_format).toContain("{space}");
  });

  test("nothing Discovery-flavoured leaked in with the chrome", () => {
    // The export badge is a host slot on purpose; its seven strings belong to the
    // resource that owns the flow, not to tLib.
    const keys = Object.keys(DEFAULT_PROP_EDITOR_STRINGS) as PropEditorStringKey[];
    expect(keys.filter((k) => k.startsWith("export"))).toEqual([]);
  });
});
