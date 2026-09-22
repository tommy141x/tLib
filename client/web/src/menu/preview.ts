import generated from "./generated/menus.json";
import { registerStrings } from "./i18n";
import { normalizeSnapshot, sliderValueValid } from "./protocol";
import type { ActionRequest, NuiResult } from "./types";

declare const __MENU_PREVIEW__: unknown;
const fixture = typeof __MENU_PREVIEW__ === "undefined" ? generated : __MENU_PREVIEW__;
if (fixture && typeof fixture === "object" && "strings" in fixture)
  registerStrings(fixture.strings);
const snapshot = normalizeSnapshot(fixture);
if (!snapshot) throw new Error("Invalid generated preview; run bun run generate:preview.");
export const previewSnapshot = snapshot;

export async function previewRequest(event: string, data: unknown): Promise<NuiResult> {
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (event === "ready" || event === "resync")
    return { ok: true, snapshot: structuredClone(previewSnapshot) };
  if (
    event === "close" ||
    event === "input" ||
    event === "highlight" ||
    event === "selftest" ||
    event === "sound"
  )
    return { ok: true };
  if (event === "navigate")
    return previewSnapshot.menus.some((menu) => menu.id === (data as { menuId?: string })?.menuId)
      ? { ok: true }
      : { ok: false, error: "Menu unavailable." };
  if (event !== "action") return { ok: false, error: "Unknown preview callback." };
  const request = data as ActionRequest;
  const item = previewSnapshot.menus
    .find((menu) => menu.id === request.menuId)
    ?.items.find((item) => item.id === request.itemId);
  if (!item || item.disabled) return { ok: false, error: "Action unavailable." };
  if (item.kind === "slider" && !sliderValueValid(item, request.value))
    return { ok: false, error: "Invalid slider value." };
  if (item.kind === "toggle" && typeof request.value !== "boolean")
    return { ok: false, error: "Invalid toggle value." };
  if (
    item.kind === "select" &&
    !item.options?.some((option) => option.value === request.value && !option.disabled)
  )
    return { ok: false, error: "Invalid selection." };
  if (item.kind === "toggle" || item.kind === "select" || item.kind === "slider") {
    item.value = request.value;
    window.postMessage(
      {
        name: "menu:patch",
        args: [{ menuId: request.menuId, itemId: request.itemId, changes: { value: item.value } }],
      },
      window.location.origin
    );
  }
  return { ok: true };
}
