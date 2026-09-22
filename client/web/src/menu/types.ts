// Re-exported so the message union and its payload types import from one place.
export type { BannerSource, Branding } from "./branding";

import type { Branding } from "./branding";
import type { Locale } from "./locales";

export type ItemValue = boolean | string | number;

export interface WeaponStats {
  damage: number;
  speed: number;
  accuracy: number;
  range: number;
}

export interface VehicleStats {
  speed: number;
  acceleration: number;
  braking: number;
  traction: number;
}

export interface MenuItem {
  weaponStats?: WeaponStats;
  vehicleStats?: VehicleStats;
  id: string;
  label: string;
  description?: string;
  kind: "action" | "toggle" | "select" | "slider" | "submenu" | "status";
  hidden?: boolean;
  barColor?: { r: number; g: number; b: number };
  rightLabel?: string;
  icon?: string;
  rightIcon?: string;
  danger?: boolean;
  groupLabel?: string;
  range?: { min: number; max: number; step: number };
  min?: number;
  max?: number;
  step?: number;
  value?: ItemValue;
  options?: {
    label: string;
    value: string | number;
    disabled?: boolean;
    vehicleStats?: VehicleStats;
    weaponStats?: WeaponStats;
    rightLabel?: string;
    icon?: string;
    rightIcon?: string;
    danger?: boolean;
  }[];
  menu?: string;
  display?: "list";
  // MenuListItem.ShowColorPanel/ShowOpacityPanel. List rows only, as upstream.
  panel?: "hair" | "makeup" | "opacity";
  apply?: "change" | "activate" | "both";
  nextMenu?: string;
  disabled?: boolean;
  confirm?: string;
}

export interface Menu {
  weaponStats?: WeaponStats;
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  parent?: string;
  contextKey?: string;
  // Navigation metadata only, no rows yet -- as distinct from a page that
  // genuinely has none, which is what decides whether opening it can be painted
  // at once. Absent on every page the game has projected.
  placeholder?: boolean;
  instructions?: {
    control: "jump" | "delete";
    label: string;
    itemId: string;
    valueFrom?: "selection";
  }[];
  items: MenuItem[];
}

export interface Snapshot {
  capabilities?: { vehicleExtraDamageBypass: boolean };
  version: 1;
  visible: boolean;
  // The page the game considers current; every other page in the snapshot is an
  // uncontextualized placeholder, so the UI follows this rather than its own.
  menuId?: string;
  menus: Menu[];
}

// One searchable row of the whole granted catalog. Its own message because a
// snapshot carries items for one page only, leaving the filter structurally
// unable to see past it.
//
// Single-letter keys: at ~2,282 rows and ~51,000 option labels this payload's
// size is dominated by the repetition of its own field names, and nothing but
// the matcher ever reads one.
export interface SearchEntry {
  /** Menu the row lives on. */
  m: string;
  /** Row id, so a result can put the cursor on the exact row. */
  i: string;
  /** Label. */
  l: string;
  /** Description. */
  d?: string;
  /** Right-hand label. */
  r?: string;
  /** Group heading. */
  g?: string;
  /** Option labels. A list row's count: each is its own row on screen, and the
      only place a vehicle or ped name ever appears. */
  o?: string[];
}

export interface ItemPatch {
  menuId: string;
  itemId: string;
  changes: Partial<
    Pick<
      MenuItem,
      | "value"
      | "disabled"
      | "description"
      | "label"
      | "rightLabel"
      | "icon"
      | "rightIcon"
      | "danger"
    >
  >;
}

export interface ActionRequest {
  event?: "change" | "activate";
  contextKey?: string;
  menuId: string;
  itemId: string;
  value?: ItemValue;
}

export interface NuiResult {
  nextMenu?: string;
  ok: boolean;
  error?: string;
  snapshot?: Snapshot;
  menus?: Menu[];
}

export type NavigationCommand =
  | "up"
  | "down"
  | "left"
  | "right"
  | "accept"
  | "back"
  | "jump"
  | "delete";

// Measured off --safe-top/--safe-left, not the raw viewport edge. The runtime
// list and the legacy mapping live in protocol.ts, beside the validator that is
// the only thing allowed to mint one of these from the wire.
export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type NuiMessage =
  | { action: "menu:navigate"; data: NavigationCommand }
  | { action: "menu:input"; data: boolean }
  | { action: "menu:snapshot"; data: Snapshot }
  | { action: "menu:visible"; data: boolean }
  | { action: "menu:patch"; data: ItemPatch }
  | { action: "menu:remove"; data: { menuId: string } }
  | { action: "menu:menu"; data: Menu }
  // Read once from the natives feeding source's COLOUR_SWITCHER_02 scaleform.
  // Outside the snapshot because every colour row shares them.
  | { action: "menu:palettes"; data: { hair?: string[]; makeup?: string[] } }
  // 'left' and 'right' are source's own two anchors and stay accepted verbatim:
  // the Lua Misc row has always pushed those words, and an older resource must
  // keep landing in the same two corners.
  | { action: "menu:align"; data: Anchor | "left" | "right" }
  // Branding from config.lua, rather than by editing the stylesheet and
  // rebuilding the bundle.
  | { action: "menu:branding"; data: Branding }
  // Hide, as distinct from close: the pause menu and a screen fade take the menu
  // off screen without ending the session, and closing would discard every
  // uncommitted selector and slider draft. Closing still arrives as
  // 'menu:visible' false and still clears everything.
  | { action: "menu:hidden"; data: boolean }
  // Content is translated here, after the wire, so catalog.signature on the Lua
  // side is identical for every player whatever language they read it in. A
  // locale with no dictionary is rejected, as an unknown alignment is.
  | { action: "menu:locale"; data: Locale }
  // Sent after the snapshot it describes.
  | { action: "menu:searchIndex"; data: SearchEntry[] }
  // Self-test pages are deliberately unvalidated here; judging them is the point.
  | { action: "menu:selftest"; data: { menu?: unknown; done: boolean } };
