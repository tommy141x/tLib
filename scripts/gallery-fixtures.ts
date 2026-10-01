/**
 * The payloads `scripts/gallery.ts` posts at tLib's UI to photograph it.
 *
 * Deliberately NOT the fixtures in `tests/browser/*.ts`. Those are chosen to break things —
 * a 40-character label, a field with no options, a toast that never expires — because that is
 * what a test is for. These are chosen to be REPRESENTATIVE: what a resource author's menu,
 * dialog, toast or panel actually looks like when it is working. The two sets answer different
 * questions and sharing one would make both worse.
 *
 * Every shape here comes from the type that receives it, so a renamed field is a typecheck
 * failure rather than a picture of an empty panel:
 *   menu      client/web/src/menu/types.ts            (Snapshot)
 *   dialog    client/web/src/components/dialog-model.ts (DialogData)
 *   toast     client/web/src/lib/toast-lifetime.ts    (ToastData)
 *   market    shared/ts/marketplace/ui/types.ts       (OpenData, MarketplaceItem)
 *   layout    client/web/src/layout/LayoutEditor.tsx  (LayoutOpen)
 */

import type { DialogData } from "../client/web/src/components/dialog-model.ts";
import type { MarketplaceItem, OpenData } from "../shared/ts/marketplace/ui/types.ts";
import type { ToastData } from "../client/web/src/lib/toast-lifetime.ts";
import type { Anchor, Component } from "../client/web/src/layout/geometry.ts";
import type { LayoutOpen } from "../client/web/src/layout/LayoutEditor.tsx";
import type { Branding, Snapshot } from "../client/web/src/menu/types.ts";

// ── Menus ───────────────────────────────────────────────────────────────────

/** Every row kind on one page: that is the point of the shot. */
const CONTROLS: Snapshot = {
  version: 1,
  visible: true,
  menuId: "gallery:controls",
  menus: [
    {
      id: "gallery:controls",
      title: "Vehicle",
      subtitle: "Bravado Buffalo STX",
      description: "Every row kind a resource can put on a page.",
      items: [
        { id: "a", kind: "action", label: "Repair vehicle", icon: "wrench" },
        { id: "b", kind: "action", label: "Clean vehicle", rightLabel: "free" },
        { id: "c", kind: "toggle", label: "Engine", value: true },
        { id: "d", kind: "toggle", label: "Doors locked", value: false },
        {
          id: "e",
          kind: "select",
          label: "Livery",
          value: "police",
          options: [
            { label: "None", value: "none" },
            { label: "Police", value: "police" },
            { label: "Sheriff", value: "sheriff" },
          ],
        },
        { id: "g", kind: "slider", label: "Dirt level", value: 40, min: 0, max: 100, step: 5 },
        { id: "h", kind: "status", label: "Plate", rightLabel: "46EEK572" },
        { id: "i", kind: "submenu", label: "Performance", menu: "gallery:stats" },
        { id: "j", kind: "action", label: "Delete vehicle", danger: true },
        { id: "k", kind: "action", label: "Impound", description: "No impound lot nearby.", disabled: true },
      ],
    },
  ],
};

/** A list select: each option is its own row, under a group heading. It gets its own page
 *  because it expands to as many rows as it has options and would push every other row kind
 *  on CONTROLS below the fold. `groupLabel` is valid on this row and no other. */
const LIST: Snapshot = {
  version: 1,
  visible: true,
  menuId: "gallery:list",
  menus: [
    {
      id: "gallery:list",
      title: "Vehicle",
      subtitle: "Paint",
      parent: "gallery:controls",
      items: [
        {
          id: "paint",
          kind: "select",
          label: "Paint",
          display: "list",
          apply: "activate",
          groupLabel: "Appearance",
          value: "midnight",
          options: [
            { label: "Midnight blue", value: "midnight" },
            { label: "Gunmetal", value: "gunmetal" },
            { label: "Matte black", value: "matte" },
            { label: "Pearlescent white", value: "pearl" },
          ],
        },
      ],
    },
  ],
};

/** The stat bars, which are a whole presentation of their own and invisible anywhere else. */
const STATS: Snapshot = {
  version: 1,
  visible: true,
  menuId: "gallery:stats",
  menus: [
    {
      id: "gallery:stats",
      title: "Performance",
      subtitle: "Bravado Buffalo STX",
      parent: "gallery:controls",
      // Stat bars are 0..1 fractions of a full bar, not percentages — 61 is rejected outright.
      items: [
        {
          id: "s1",
          kind: "select",
          label: "Engine",
          value: "3",
          options: [
            { label: "Stock", value: "0", vehicleStats: { speed: 0.52, acceleration: 0.48, braking: 0.4, traction: 0.61 } },
            { label: "EMS Level 4", value: "3", vehicleStats: { speed: 0.71, acceleration: 0.78, braking: 0.4, traction: 0.61 } },
          ],
          vehicleStats: { speed: 0.71, acceleration: 0.78, braking: 0.4, traction: 0.61 },
        },
        {
          id: "s2",
          kind: "action",
          label: "Combat Pistol",
          weaponStats: { damage: 0.34, speed: 0.62, accuracy: 0.55, range: 0.41 },
        },
      ],
    },
  ],
};

/** A page with nothing on it — the state most likely to look broken rather than empty. */
const EMPTY: Snapshot = {
  version: 1,
  visible: true,
  menuId: "gallery:empty",
  menus: [
    {
      id: "gallery:empty",
      title: "Garage",
      subtitle: "No vehicles stored",
      description: "Nothing here yet.",
      items: [],
    },
  ],
};

/** A skin is not part of a snapshot — it arrives on `menu:branding`, per owner or per page.
 *  Sending the whole Branding rather than a bare skin name keeps the accent on the same path. */
const branded = (skin: "default" | "vmenu", accent?: string): Branding => ({
  themes: { owners: { gallery: { skin, accent } } },
});

export const MENUS: ReadonlyArray<{ id: string; snapshot: Snapshot; branding: Branding }> = [
  { id: "controls", snapshot: CONTROLS, branding: branded("default") },
  { id: "list", snapshot: LIST, branding: branded("default") },
  { id: "stats", snapshot: STATS, branding: branded("default") },
  { id: "empty", snapshot: EMPTY, branding: branded("default") },
  // Same page, the other stylesheet: the pair is the only way to see what a skin changes.
  { id: "controls-vmenu", snapshot: CONTROLS, branding: branded("vmenu") },
  // An owner accent, which is the one branding knob a server owner is most likely to touch.
  { id: "controls-accent", snapshot: CONTROLS, branding: branded("default", "#e0662a") },
];

// ── Dialogs ─────────────────────────────────────────────────────────────────

export const DIALOGS: readonly DialogData[] = [
  {
    id: "gallery:confirm",
    title: "Sell this vehicle?",
    description: "You will be paid $18,400. This cannot be undone.",
    size: "sm",
    submitLabel: "Sell",
    cancelLabel: "Keep it",
    fields: [],
  },
  {
    id: "gallery:standard",
    title: "Vehicle registration",
    size: "md",
    submitLabel: "Register",
    fields: [
      { id: "plate", type: "text", label: "Plate", defaultValue: "46EEK572", required: true },
      { id: "owner", type: "text", label: "Registered owner", placeholder: "Full name" },
      {
        id: "class",
        type: "select",
        label: "Class",
        defaultValue: "commercial",
        options: [
          { value: "private", label: "Private" },
          { value: "commercial", label: "Commercial" },
          { value: "emergency", label: "Emergency" },
        ],
      },
      { id: "insured", type: "checkbox", label: "Insured", defaultValue: true },
    ],
  },
  {
    id: "gallery:every-field",
    title: "Every field type",
    description: "One of each, so a styling change can be judged in a single picture.",
    size: "lg",
    fields: [
      { id: "text", type: "text", label: "Text", placeholder: "Type here" },
      { id: "number", type: "number", label: "Number", defaultValue: 12, min: 0, max: 100 },
      { id: "password", type: "password", label: "Password", defaultValue: "hunter2" },
      { id: "textarea", type: "textarea", label: "Notes", defaultValue: "Rear bumper damage, reported 14:20." },
      {
        id: "select",
        type: "select",
        label: "Select",
        defaultValue: "tow",
        options: [
          { value: "tow", label: "Tow" },
          { value: "release", label: "Release" },
        ],
      },
      {
        id: "dropdown",
        type: "dropdown",
        label: "Dropdown",
        defaultValue: "mission-row",
        options: [
          { value: "mission-row", label: "Mission Row" },
          { value: "vespucci", label: "Vespucci" },
        ],
      },
      {
        id: "radio",
        type: "radio",
        label: "Shift",
        defaultValue: "night",
        options: [
          { value: "day", label: "Day" },
          { value: "night", label: "Night" },
        ],
      },
      { id: "slider", type: "slider", label: "Tint", defaultValue: 35, min: 0, max: 100, step: 5 },
      { id: "checkbox", type: "checkbox", label: "Notify dispatch", defaultValue: false },
      { id: "button", type: "button", label: "Run plate", variant: "primary" },
    ],
  },
  {
    id: "gallery:tabbed",
    title: "Server settings",
    size: "xl",
    tabs: [
      { id: "general", label: "General" },
      { id: "audio", label: "Audio" },
      { id: "advanced", label: "Advanced", separator: true },
    ],
    fields: [
      { id: "name", type: "text", label: "Server name", defaultValue: "305 RP", tab: "general" },
      { id: "slots", type: "number", label: "Slots", defaultValue: 64, tab: "general" },
      { id: "volume", type: "slider", label: "Master volume", defaultValue: 80, tab: "audio" },
      { id: "debug", type: "checkbox", label: "Verbose logging", tab: "advanced" },
    ],
  },
];

// ── Toasts ──────────────────────────────────────────────────────────────────

export const TOASTS: readonly ToastData[] = [
  { id: "t-success", type: "success", title: "Vehicle stored", description: "Buffalo STX · Legion Square" },
  { id: "t-error", type: "error", title: "Not enough cash", description: "$18,400 short." },
  { id: "t-warning", type: "warning", title: "Engine damaged", description: "Repair before the next call." },
  { id: "t-info", type: "info", title: "Shift starts in 5 minutes" },
  { id: "t-loading", type: "loading", title: "Installing layout…", description: "WCC2 · 1.4 MB" },
];

// ── Marketplace ─────────────────────────────────────────────────────────────

const item = (
  slug: string,
  name: string,
  type: string,
  description: string,
  downloads: number,
  bytes: number
): MarketplaceItem => ({
  id: `gallery-${slug}`,
  slug,
  type,
  name,
  description,
  creator_name: "305 Studios",
  current_version: "1.2.0",
  size_bytes: bytes,
  downloads,
  created_at: "2026-04-11T12:00:00.000Z",
});

export const MARKET_UIS: readonly MarketplaceItem[] = [
  item("wcc-slimline", "WCC Slimline", "ui", "A narrow lightbar HUD for a single-row chassis.", 1840, 412_000),
  item("wcc-console", "WCC Console", "ui", "Console-style HUD with per-stage readouts.", 906, 631_000),
  item("wcc-minimal", "WCC Minimal", "ui", "Four indicators and nothing else.", 2417, 184_000),
];

export const MARKET_SOUNDS: readonly MarketplaceItem[] = [
  item("wail-classic", "Wail — Classic", "sound", "Mechanical wail, 1.4 s loop.", 3120, 96_000),
  item("yelp-fast", "Yelp — Fast", "sound", "Fast yelp for intersection clearing.", 2201, 74_000),
];

export const MARKET_OPEN: OpenData = {
  baseUrl: "https://marketplace.invalid",
  installedSlugs: ["wcc-minimal"],
  installedLayouts: ["WCC", "WCC2", "wcc-minimal"],
  installedSounds: [{ filename: "wail.ogg", slug: "wail-classic" }],
  initialTab: "uis",
};

// ── Layout editor ───────────────────────────────────────────────────────────

/** Offsets are a ratio of a 1080px reference screen (geometry.ts REFERENCE_HEIGHT), NOT pixels —
 *  a literal 24 here is 24 screen-heights out and the widget lands nowhere. `ref()` converts. */
const ref = (px: number) => px / 1080;

const widget = (
  owner: string,
  id: string,
  label: string,
  width: number,
  height: number,
  x: number,
  y: number,
  anchor: Anchor
): Component => {
  const layout = { x: ref(x), y: ref(y), scale: 1, visible: true, anchor };
  return {
    key: `${owner}:${id}`,
    owner,
    id,
    label,
    width,
    height,
    defaults: layout,
    layout,
    minScale: 0.5,
    maxScale: 2,
    canHide: true,
    canScale: true,
  };
};

export const LAYOUT_OPEN: LayoutOpen = {
  session: 1,
  // A fraction of the shorter axis kept clear, like the game's own safe zone — not an inset.
  safezone: 0.9,
  // An offset moves AWAY from its anchor's own corner (geometry.ts layoutRect), so pulling a
  // bottom-right widget back on screen is negative on both axes, not positive.
  components: [
    widget("tELS", "hud", "Lightbar HUD", 440, 245, 40, -40, "bottom-left"),
    widget("tRadio", "radio", "Radio", 210, 427, -40, -40, "bottom-right"),
    widget("tRadar", "head", "Radar", 520, 157, 40, 40, "top-left"),
  ],
};
