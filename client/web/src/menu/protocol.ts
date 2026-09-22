import { normalizeBranding } from "./branding";
import { isLocale } from "./locales";
import type { Anchor, ItemPatch, Menu, MenuItem, NuiMessage, Snapshot } from "./types";

// The one list: the validator below, the stylesheet's .align-* rules and the
// Misc row's options all have to agree, and an anchor present in only two of the
// three is a panel that lands nowhere.
export const ANCHORS: readonly Anchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
// client/features/misc.lua has pushed 'left'/'right' since before there were
// nine anchors, so they still mean the corners they always meant. Spelled out
// rather than table-looked-up: a wire string indexing an object literal answers
// for 'constructor' and 'toString' as readily as for 'left'.
export function normalizeAnchor(value: unknown): Anchor | undefined {
  if (typeof value !== "string") return undefined;
  if (ANCHORS.includes(value as Anchor)) return value as Anchor;
  return value === "left" ? "top-left" : value === "right" ? "top-right" : undefined;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max = 1024) => value === undefined || text(value, max);
const scalar = (value: unknown) =>
  typeof value === "boolean" ||
  (typeof value === "string" && value.length <= 256) ||
  (typeof value === "number" && Number.isFinite(value));

export function sliderValueValid(item: MenuItem, value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 1e12 &&
    value >= item.min! &&
    value <= item.max! &&
    (value - item.min!) % item.step! === 0
  );
}

function selectRange(value: unknown): boolean {
  return (
    object(value) &&
    [value.min, value.max, value.step].every(
      (entry) => typeof entry === "number" && Number.isSafeInteger(entry)
    ) &&
    (value.min as number) >= -1 &&
    (value.max as number) <= 9999 &&
    (value.min as number) < (value.max as number) &&
    (value.step as number) > 0 &&
    ((value.max as number) - (value.min as number)) % (value.step as number) === 0
  );
}

function validWeaponStats(value: unknown): boolean {
  return (
    value === undefined ||
    (object(value) &&
      Object.keys(value).length === 4 &&
      ["damage", "speed", "accuracy", "range"].every(
        (key) =>
          typeof value[key] === "number" &&
          Number.isFinite(value[key]) &&
          value[key] >= 0 &&
          value[key] <= 1
      ))
  );
}

function validVehicleStats(value: unknown): boolean {
  return (
    value === undefined ||
    (object(value) &&
      Object.keys(value).length === 4 &&
      ["speed", "acceleration", "braking", "traction"].every(
        (key) =>
          typeof value[key] === "number" &&
          Number.isFinite(value[key]) &&
          value[key] >= 0 &&
          value[key] <= 1
      ))
  );
}

export function isItem(value: unknown): value is MenuItem {
  if (
    !object(value) ||
    !validWeaponStats(value.weaponStats) ||
    !validVehicleStats(value.vehicleStats) ||
    (value.range !== undefined && (value.kind !== "select" || !selectRange(value.range))) ||
    !text(value.id) ||
    !text(value.label) ||
    !(value.rightLabel === "" || optionalText(value.rightLabel, 128)) ||
    !(value.icon === "" || optionalText(value.icon, 64)) ||
    !(value.rightIcon === "" || optionalText(value.rightIcon, 64)) ||
    (value.hidden !== undefined && typeof value.hidden !== "boolean") ||
    (value.barColor !== undefined &&
      (value.kind !== "slider" ||
        !object(value.barColor) ||
        !["r", "g", "b"].every(
          (key) =>
            typeof (value.barColor as Record<string, unknown>)[key] === "number" &&
            Number.isInteger((value.barColor as Record<string, number>)[key]) &&
            (value.barColor as Record<string, number>)[key]! >= 0 &&
            (value.barColor as Record<string, number>)[key]! <= 255
        ))) ||
    (value.danger !== undefined && typeof value.danger !== "boolean") ||
    (value.groupLabel !== undefined &&
      (value.kind !== "select" || value.display !== "list" || !text(value.groupLabel, 128))) ||
    !optionalText(value.description) ||
    !optionalText(value.confirm) ||
    (value.disabled !== undefined && typeof value.disabled !== "boolean") ||
    (value.value !== undefined && !scalar(value.value)) ||
    (value.display !== undefined && (value.kind !== "select" || value.display !== "list")) ||
    (value.panel !== undefined &&
      (value.kind !== "select" ||
        !["hair", "makeup", "opacity"].includes(value.panel as string))) ||
    (value.apply !== undefined &&
      ((value.kind !== "select" && value.kind !== "slider") ||
        !["change", "activate", "both"].includes(value.apply as string) ||
        (value.display === "list" && value.apply !== "activate"))) ||
    (value.nextMenu !== undefined && (value.kind !== "select" || !text(value.nextMenu)))
  )
    return false;
  switch (value.kind) {
    case "slider":
      return (
        [value.min, value.max, value.step].every(
          (entry) =>
            typeof entry === "number" && Number.isSafeInteger(entry) && Math.abs(entry) <= 1e12
        ) &&
        (value.min as number) < (value.max as number) &&
        (value.step as number) > 0 &&
        ((value.max as number) - (value.min as number)) % (value.step as number) === 0 &&
        sliderValueValid(value as unknown as MenuItem, value.value)
      );
    case "status":
      return value.value === undefined && value.menu === undefined && value.nextMenu === undefined;
    case "action":
      return true;
    case "toggle":
      return typeof value.value === "boolean";
    case "submenu":
      return text(value.menu);
    case "select":
      return (
        Array.isArray(value.options) &&
        (value.options.length > 0 || value.disabled === true || value.hidden === true) &&
        value.options.length <= 10001 &&
        new Set(value.options.map((option) => (object(option) ? JSON.stringify(option.value) : "")))
          .size === value.options.length &&
        value.options.every(
          (option) =>
            object(option) &&
            validWeaponStats(option.weaponStats) &&
            validVehicleStats(option.vehicleStats) &&
            (option.rightLabel === "" || optionalText(option.rightLabel, 128)) &&
            (option.icon === "" || optionalText(option.icon, 64)) &&
            (option.rightIcon === "" || optionalText(option.rightIcon, 64)) &&
            (option.danger === undefined || typeof option.danger === "boolean") &&
            text(option.label) &&
            (option.disabled === undefined || typeof option.disabled === "boolean") &&
            (typeof option.value === "string" || typeof option.value === "number") &&
            scalar(option.value)
        )
      );
    default:
      return false;
  }
}

export function isMenu(value: unknown): value is Menu {
  return (
    object(value) &&
    validWeaponStats(value.weaponStats) &&
    text(value.id) &&
    text(value.title) &&
    optionalText(value.subtitle, 256) &&
    optionalText(value.description) &&
    optionalText(value.parent, 256) &&
    optionalText(value.contextKey, 256) &&
    (value.placeholder === undefined || typeof value.placeholder === "boolean") &&
    Array.isArray(value.items) &&
    value.items.length <= 10000 &&
    value.items.every(isItem) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length &&
    (value.instructions === undefined ||
      (Array.isArray(value.instructions) &&
        value.instructions.length <= 2 &&
        new Set(
          value.instructions.map((instruction) =>
            object(instruction) ? instruction.control : null
          )
        ).size === value.instructions.length &&
        value.instructions.every(
          (instruction) =>
            object(instruction) &&
            ["jump", "delete"].includes(instruction.control as string) &&
            text(instruction.label, 128) &&
            (value.items as MenuItem[]).some(
              (item) =>
                item.id === instruction.itemId &&
                item.hidden &&
                ((instruction.valueFrom === undefined && item.kind === "action") ||
                  (instruction.valueFrom === "selection" && item.kind === "select"))
            )
        )))
  );
}

// Full built-in weapon/component authority precedes native compatibility narrowing.
export const MAX_PRESENTED_OPTIONS = 65536;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
// Measuring the whole corpus costs ~11ms against a live refresh that pushes a
// page roughly every 750ms, which drops frames in CEF for as long as the menu is
// open. A delta caller passes a per-menu-id size cache and invalidates only what
// it changes; the total stays exact.
export function withinPresentationBudget(
  menus: readonly Menu[],
  sizes?: Map<string, number>
): boolean {
  let options = 0;
  for (const menu of menus)
    for (const item of menu.items) {
      options += item.options?.length ?? 0;
      if (options > MAX_PRESENTED_OPTIONS) return false;
    }
  try {
    // The array's brackets and separators: one byte per element, plus one.
    let bytes = 1;
    for (const menu of menus) {
      let size = sizes?.get(menu.id);
      if (size === undefined) {
        size = encoder.encode(JSON.stringify(menu)).byteLength;
        sizes?.set(menu.id, size);
      }
      bytes += size + 1;
      if (bytes > MAX_SNAPSHOT_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isSnapshot(value: unknown): value is Snapshot {
  return (
    object(value) &&
    (value.capabilities === undefined ||
      (object(value.capabilities) &&
        typeof value.capabilities.vehicleExtraDamageBypass === "boolean")) &&
    value.version === 1 &&
    typeof value.visible === "boolean" &&
    optionalText(value.menuId, 256) &&
    Array.isArray(value.menus) &&
    value.menus.length <= 320 &&
    value.menus.every(isMenu) &&
    new Set(value.menus.map((menu) => menu.id)).size === value.menus.length &&
    withinPresentationBudget(value.menus)
  );
}

function isPatch(value: unknown): value is ItemPatch {
  if (!object(value) || !text(value.menuId) || !text(value.itemId) || !object(value.changes))
    return false;
  return Object.entries(value.changes).every(([key, entry]) => {
    if (key === "rightLabel" || key === "icon" || key === "rightIcon")
      return typeof entry === "string" && entry.length <= (key === "rightLabel" ? 128 : 64);
    if (key === "danger") return typeof entry === "boolean";
    if (key === "value") return scalar(entry);
    if (key === "disabled") return typeof entry === "boolean";
    if (key === "label") return text(entry);
    if (key === "description") return typeof entry === "string" && entry.length <= 1024;
    return false;
  });
}

// An empty Lua table crosses the JSON boundary as {} rather than []. Collection
// fields only -- never a scalar or a nonempty object.
function collection(value: unknown): unknown {
  return object(value) && Object.keys(value).length === 0 ? [] : value;
}

function normalizeMenu(value: unknown): unknown {
  if (!object(value)) return value;
  const items = collection(value.items);
  return {
    ...value,
    ...(value.instructions !== undefined ? { instructions: collection(value.instructions) } : {}),
    items: Array.isArray(items)
      ? items.map((item) =>
          object(item) && item.kind === "select"
            ? { ...item, options: collection(item.options) }
            : item
        )
      : items,
  };
}

export function normalizeSnapshot(value: unknown): Snapshot | undefined {
  if (!object(value)) return;
  const menus = collection(value.menus);
  const normalized = { ...value, menus: Array.isArray(menus) ? menus.map(normalizeMenu) : menus };
  if (isSnapshot(normalized)) return normalized;
}

// Run only on rejection: identify the malformed row without logging player data.
export function snapshotError(value: unknown): string {
  if (object(value) && Array.isArray(value.menus)) {
    for (const candidate of value.menus) {
      const menu = normalizeMenu(candidate);
      if (!object(menu)) return "Invalid menu snapshot: malformed menu.";
      const name = text(menu.id) ? menu.id : "(missing ID)";
      if (Array.isArray(menu.items)) {
        for (const item of menu.items) {
          if (!isItem(item))
            return `Invalid menu snapshot: ${name}, item ${object(item) && text(item.id) ? item.id : "(missing ID)"}.`;
        }
      }
      if (!isMenu(menu)) return `Invalid menu snapshot: ${name} metadata or item identities.`;
    }
  }
  return "Invalid menu snapshot: header, duplicate menus, or presentation budget.";
}

export function parseMessage(value: unknown): NuiMessage | undefined {
  if (!object(value)) return;
  switch (value.action) {
    case "menu:input":
      if (typeof value.data === "boolean") return value as NuiMessage;
      break;
    case "menu:navigate":
      if (
        typeof value.data === "string" &&
        ["up", "down", "left", "right", "accept", "back", "jump", "delete"].includes(value.data)
      )
        return value as NuiMessage;
      break;
    case "menu:snapshot": {
      const data = normalizeSnapshot(value.data);
      if (data) return { action: "menu:snapshot", data };
      break;
    }
    case "menu:visible":
      if (typeof value.data === "boolean") return value as NuiMessage;
      break;
    case "menu:align":
      if (normalizeAnchor(value.data)) return value as NuiMessage;
      break;
    // Distinct from close on the wire: this preserves every uncommitted draft,
    // and 'menu:visible' false still discards them.
    case "menu:hidden":
      if (typeof value.data === "boolean") return value as NuiMessage;
      break;
    // Whole rather than per field: an accepted accent beside a dropped banner is
    // a look nobody configured. Normalized first because an unset banner leaves
    // Lua as an empty table and would otherwise fail the push.
    case "menu:branding": {
      const data = normalizeBranding(value.data);
      if (data) return { action: "menu:branding", data };
      break;
    }
    // Only a locale a dictionary ships for: an unrecognized tag would point every
    // lookup at a dictionary that is not there.
    case "menu:locale":
      if (isLocale(value.data)) return value as NuiMessage;
      break;
    case "menu:palettes": {
      // Exactly 64 six-digit hex swatches, the count source pushes into the
      // scaleform. A short one is dropped rather than drawn as a partial grid.
      const swatches = (entry: unknown) =>
        entry === undefined ||
        (Array.isArray(entry) &&
          entry.length === 64 &&
          entry.every((colour) => typeof colour === "string" && /^[0-9a-f]{6}$/.test(colour)));
      if (
        object(value.data) &&
        swatches(value.data.hair) &&
        swatches(value.data.makeup) &&
        Object.keys(value.data).every((key) => key === "hair" || key === "makeup")
      )
        return value as NuiMessage;
      break;
    }
    case "menu:menu": {
      const data = normalizeMenu(value.data);
      if (isMenu(data)) return { action: "menu:menu", data };
      break;
    }
    // Rejected whole rather than per entry: a partial index is a search that
    // silently cannot find part of the menu, which is worse than no index at all.
    // The caps are generous multiples of the real catalog (2,282 rows, 51,000
    // option labels, largest single list 917), so growth will not trip them while
    // a payload big enough to hang the tab still fails.
    case "menu:searchIndex": {
      const entry = (candidate: unknown) =>
        object(candidate) &&
        text(candidate.m) &&
        text(candidate.i) &&
        text(candidate.l, 512) &&
        optionalText(candidate.d, 1024) &&
        optionalText(candidate.r, 512) &&
        optionalText(candidate.g, 512) &&
        (candidate.o === undefined ||
          (Array.isArray(candidate.o) &&
            candidate.o.length <= 4096 &&
            candidate.o.every((label) => text(label, 512)))) &&
        Object.keys(candidate).every((key) => ["m", "i", "l", "d", "r", "g", "o"].includes(key));
      if (Array.isArray(value.data) && value.data.length <= 20000 && value.data.every(entry))
        return value as NuiMessage;
      break;
    }
    case "menu:selftest":
      if (object(value.data) && typeof value.data.done === "boolean") return value as NuiMessage;
      break;
    case "menu:patch":
      if (isPatch(value.data)) return value as NuiMessage;
      break;
    case "menu:remove":
      if (object(value.data) && text(value.data.menuId)) return value as NuiMessage;
  }
}
