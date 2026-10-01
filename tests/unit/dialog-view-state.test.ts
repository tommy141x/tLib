import { beforeEach, describe, expect, test } from "bun:test";
import type { DialogTab } from "../../client/web/src/components/dialog-model";
import {
  clampOffset,
  clearDialogViews,
  DIALOG_NO_TAB,
  forgetDialogView,
  recallDialogView,
  rememberDialogView,
  restoredTab,
} from "../../client/web/src/components/dialog-view-state";

// The dialog reopens constantly: a world editor, a HUD reposition and the 3D
// prop editor all close it and bring it back. Landing on the default tab every
// time is the bug this file exists to keep fixed.
const settingsTabs: DialogTab[] = [
  { id: "settings", label: "Settings" },
  { id: "sounds", label: "Sounds" },
  { id: "shop", label: "Marketplace", view: "marketplace" },
  { id: "editor", label: "Editor", action: true },
];

describe("dialog view state restores where the player left it", () => {
  beforeEach(clearDialogViews);

  test("a remembered tab is restored, and the default is the first non-action tab", () => {
    expect(restoredTab(settingsTabs, "sounds")).toBe("sounds");
    expect(restoredTab(settingsTabs, "shop")).toBe("shop");
    expect(restoredTab(settingsTabs, null)).toBe("settings");
    expect(restoredTab(settingsTabs, undefined)).toBe("settings");
    expect(restoredTab([], "sounds")).toBeNull();
  });

  test("a tab that no longer exists falls back rather than selecting an empty panel", () => {
    // Exactly what a permission change does: the Sounds and Marketplace tabs
    // are admin-only in tRadar/tDetector/tRadio and are simply not built for a
    // player who has since lost the rank.
    const asPlayer: DialogTab[] = [{ id: "settings", label: "Settings" }];
    expect(restoredTab(asPlayer, "sounds")).toBe("settings");
    // An action tab is a button owning no panel, so it is never restorable.
    expect(restoredTab(settingsTabs, "editor")).toBe("settings");
  });

  test("state is keyed per dialog id, so two settings dialogs restore independently", () => {
    rememberDialogView("tradar_settings", {
      tab: "sounds",
      scroll: { sounds: 120 },
      offset: { x: 10, y: -4 },
    });
    rememberDialogView("tradio_settings", { tab: "shop", scroll: {}, offset: { x: 0, y: 0 } });
    expect(recallDialogView("tradar_settings")?.tab).toBe("sounds");
    expect(recallDialogView("tradio_settings")?.tab).toBe("shop");
    expect(recallDialogView("tels_settings")).toBeUndefined();
  });

  test("scroll is remembered per tab, and a tabless dialog has exactly one panel", () => {
    rememberDialogView("tafk_main", {
      tab: null,
      scroll: { [DIALOG_NO_TAB]: 88 },
      offset: { x: 0, y: 0 },
    });
    expect(recallDialogView("tafk_main")?.scroll[DIALOG_NO_TAB]).toBe(88);
    rememberDialogView("tradar_settings", {
      tab: "settings",
      scroll: { settings: 40, sounds: 300 },
      offset: { x: 0, y: 0 },
    });
    expect(recallDialogView("tradar_settings")?.scroll).toEqual({ settings: 40, sounds: 300 });
  });

  test("remembered state is a copy, so a live session cannot mutate the store behind its back", () => {
    const live = { tab: "sounds", scroll: { sounds: 10 }, offset: { x: 1, y: 2 } };
    rememberDialogView("tradar_settings", live);
    live.scroll.sounds = 999;
    live.offset.x = 999;
    expect(recallDialogView("tradar_settings")?.scroll.sounds).toBe(10);
    expect(recallDialogView("tradar_settings")?.offset.x).toBe(1);
  });

  test("resetState forgets one dialog and only that dialog", () => {
    rememberDialogView("tradar_settings", { tab: "sounds", scroll: {}, offset: { x: 0, y: 0 } });
    rememberDialogView("tradio_settings", { tab: "shop", scroll: {}, offset: { x: 0, y: 0 } });
    forgetDialogView("tradar_settings");
    expect(recallDialogView("tradar_settings")).toBeUndefined();
    expect(recallDialogView("tradio_settings")?.tab).toBe("shop");
    // And a forgotten dialog opens at its default, not at nothing.
    expect(restoredTab(settingsTabs, recallDialogView("tradar_settings")?.tab)).toBe("settings");
  });

  test("a restored drag offset is clamped to the window it is coming back into", () => {
    const bounds = {
      panel: { width: 760, height: 600 },
      viewport: { width: 1600, height: 900 },
    };
    expect(clampOffset({ x: 100, y: -50 }, bounds)).toEqual({ x: 100, y: -50 });
    // Remembered from a larger window: unclamped this would put the panel's
    // controls off-screen, where nothing can reach them.
    expect(clampOffset({ x: 5000, y: 5000 }, bounds)).toEqual({ x: 420, y: 150 });
    expect(clampOffset({ x: -5000, y: -5000 }, bounds)).toEqual({ x: -420, y: -150 });
    // A panel larger than the window pins to centre rather than letting the
    // clamp go negative and invert.
    expect(
      clampOffset(
        { x: 200, y: 200 },
        { panel: { width: 1800, height: 1000 }, viewport: bounds.viewport }
      )
    ).toEqual({ x: 0, y: 0 });
  });
});
