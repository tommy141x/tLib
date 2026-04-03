# tLib

A shared utility library for Helix & FiveM resources. Provides a UI component suite (menus, dialogs, toasts, themes), reusable Lua import modules (settings, KVP, coords, layouts, move mode), and TypeScript/NUI utilities (3D gizmo, undo system, coordinate helpers) that other resources can depend on.

> Full documentation is coming soon. This README covers the basics to get started.

---

## Systems

### Menu System

A fully-featured NUI menu system with support for submenus, item types, and dynamic updates.

**Lifecycle**
- `CreateMenu(menuId, title, subtitle, onOpen, onClose, opts)` — Create a new menu. Returns the resolved `menuId`.
- `OpenMenu(menuId)` — Open a menu by id.
- `CloseMenu(menuId)` — Close a specific menu.
- `CloseAll()` — Close all open menus.
- `DeleteMenu(menuId)` — Remove a menu entirely.
- `ClearMenu(menuId)` — Remove all items from a menu.
- `CheckMenu(menuId)` — Returns `true` if the menu exists.
- `IsOpen()` — Returns `true` if any menu is currently open.

**Item Types**
- `AddButton(menuId, itemId, label, description, onSelect, opts)`
- `AddCheckbox(menuId, itemId, label, description, checked, onToggle, opts)`
- `AddSlider(menuId, itemId, label, description, min, max, value, step, onChange, onSelect, opts)`
- `AddList(menuId, itemId, label, description, values, index, onChange, onSelect, opts)`
- `AddSpacer(menuId, itemId, label, description, opts)`
- `AddSubmenuButton(menuId, itemId, submenuId, label, description, onSelect, opts)`

**Mutation**
- `UpdateMenu(menuId, changes)` — Merge top-level menu fields (title, subtitle, banner, position, size, etc).
- `SetMenuTitle(menuId, title)`
- `SetMenuSubtitle(menuId, subtitle)`
- `SetMenuBanner(menuId, banner)`
- `SetMenuLayout(menuId, position, size)`
- `RefreshMenu(menuId)` — Push pending item changes to the UI. Call after batched `Add*` calls.

**`CreateMenu` opts**

| Key | Type | Description |
|---|---|---|
| `position` | `string` | Menu position: `"top-left"`, `"top-center"`, `"bottom-right"`, etc. |
| `size` | `string` | `"sm"` \| `"md"` \| `"lg"` |
| `banner` | `string\|function` | URL displayed above the title. |
| `blockInput` | `boolean` | Block player movement and camera while open. |
| `inheritLayout` | `boolean` | Inherit position/size from parent when opened as a submenu. |
| `theme` | `string` | Id of a registered tLib theme to scope this menu's appearance. |
| `itemHeight` | `number` | Fixed row height in pixels for all items (default: `40`). |

---

### Dialog System

Modal form dialogs supporting multiple field types. Results are delivered via local events.

- `ShowDialog(id, opts)` — Open a dialog. Returns the resolved dialog `id`.
- `CloseDialog(id)` — Programmatically close an open dialog (fires the cancelled event).

**`ShowDialog` opts**

| Key | Type | Description |
|---|---|---|
| `title` | `string` | Dialog heading. |
| `description` | `string` | Optional subheading. |
| `submitLabel` | `string` | Override the submit button label (default `"Submit"`). |
| `cancelLabel` | `string` | Override the cancel button label (default `"Cancel"`). |
| `size` | `string` | `"sm"` \| `"md"` \| `"lg"` (default `"md"`). |
| `theme` | `string` | Id of a registered tLib theme to scope this dialog's appearance. |
| `fields` | `table[]` | Array of field definition tables. |

**Field Types**

| Type | Extra keys |
|---|---|
| `text`, `number`, `password`, `textarea` | `placeholder`, `defaultValue`, `min`/`max` (number only) |
| `select`, `radio` | `options` (`{ value, label }[]`), `placeholder`, `defaultValue` |
| `slider` | `min`, `max`, `step`, `defaultValue` |
| `checkbox` | `defaultValue` (boolean) |

All fields share: `id` (required), `type`, `label`, `description`, `required`, `disabled`.

**Events**
- `tLib:dialog:opened` — `(dialogId)`
- `tLib:dialog:submitted` — `(dialogId, values)` — `values` is a table keyed by field `id`.
- `tLib:dialog:cancelled` — `(dialogId)`

---

### Toast / Notification System

Lightweight, non-interactable toast notifications that stack in the corner of the screen.

- `ShowToast(id, toastType, title, description, duration, theme)` — Show a toast. Returns the resolved `id`.
- `UpdateToast(id, changes)` — Merge changes into a live toast in place (ideal for resolving a `"loading"` toast).
- `DismissToast(id)` — Dismiss a single toast before it expires.
- `DismissAll()` — Dismiss all visible toasts immediately.

**Toast Types:** `"success"` | `"error"` | `"warning"` | `"info"` | `"loading"`

**Default durations**

| Type | Duration |
|---|---|
| `success` | 4 000 ms |
| `error` | 6 000 ms |
| `warning` | 5 000 ms |
| `info` | 4 000 ms |
| `loading` | Persistent until `DismissToast` / `UpdateToast` |

**Events**
- `tLib:toast:shown` — `(id, toastType, title)`
- `tLib:toast:updated` — `(id, patch)`
- `tLib:toast:dismissed` — `(id)`
- `tLib:toast:dismissedAll`

---

### Theme System

Register and apply CSS variable–based themes. Themes can be scoped globally or per-component.

- `AddTheme(id, opts)` — Register a new theme (or replace an existing one). Returns `true` on success.
- `RemoveTheme(id)` — Unregister a theme. Returns `true` if the theme existed.
- `SetTheme(id)` — Apply a theme globally. Pass `""` to clear the global override.
- `GetTheme(id)` — Returns a copy of a single theme definition, or `nil`.
- `GetThemes()` — Returns a copy of all registered theme definitions keyed by id.

**`AddTheme` opts**

| Key | Type | Description |
|---|---|---|
| `name` | `string` | Human-readable display name. |
| `description` | `string` | Optional description. |
| `cssVars` | `table` | Flat map of CSS variable name → value. Keys must not include the leading `--`. |
| `extends` | `string` | Id of another theme to inherit from. The current theme's vars overlay the base. |
| `font` | `string` | Font-family string (sets `--font-sans`). |
| `fontSize` | `string` | Base font-size percentage (sets `html` font-size), e.g. `"87.5%"`. |

**Events**
- `tLib:theme:added` — `(id)`
- `tLib:theme:removed` — `(id)`
- `tLib:theme:set` — `(id)`

---

### Logger

Structured console logger with level filtering. Available on both client and server.

```lua
-- Levels: 1=DEBUG  2=INFO  3=WARN  4=ERROR
```

**Within tLib (same Lua VM)**
```lua
local log = Logger.create('mypkg/module')

log('Something happened')        -- INFO (default)
log('Watch this value', val, 1)  -- DEBUG
log('Something went wrong', 4)   -- ERROR
```

**From another package (cross-VM export)**
```lua
local log = function(msg, level)
    local line = exports['tLib']:Log('mypkg', { msg, level or 2 })
    if line then print(line) end
end
-- Note: colon-bracket notation is required — dot notation drops strings at the Helix cross-VM boundary.
```

**Exports**
- `exports['tLib']:Log(loggerId, args)` — Format and filter a log line. Returns the formatted string or `nil`.
- `exports['tLib']:SetLogLevel(level)` — Set the global minimum log level (`1`–`4`).

---

### HTTP Helper

Non-blocking HTTP/HTTPS client built on LuaSocket (and optionally LuaSec for TLS).

- `Http.fetch(opts, callback)` — Internal API used within tLib.
- `exports['tLib']:Fetch(opts, callback)` — Public export for use from other packages.

**`Fetch` opts**

| Key | Type | Description |
|---|---|---|
| `url` | `string` | Required. Full URL including scheme (`http://` or `https://`). |
| `method` | `string` | HTTP method (default `"GET"`). |
| `headers` | `table` | Request headers as a key/value table. |
| `body` | `string` | Request body. |
| `timeout` | `number` | Timeout in seconds (default `10`). |
| `verify` | `boolean` | Verify TLS peer certificate (default `false`). |

**Callback signature:** `function(err, statusCode, body)`
- On success: `err` is `nil`, `statusCode` is the HTTP status integer, `body` is the response string.
- On failure: `err` is an error string, `statusCode` is `0`, `body` is `nil`.

> HTTPS requires LuaSec to be available. HTTP/2 is not supported.

---

## Import Modules

Lightweight Lua modules that dependent resources declare in their `fxmanifest.lua` and load on demand via `tLib.imports`. Each module is isolated and only loaded if requested.

```lua
-- fxmanifest.lua
tlib_modules { 'coords', 'kvp', 'settings', 'movemode', 'layouts' }
```

### coords

Vehicle coordinate math helpers for transforming positions between local and world space, including bone attachment support.

- `Coords.localToWorld(right, fwd, up, pos, lx, ly, lz)` — Vehicle-local → world
- `Coords.worldToLocal(right, fwd, up, pos, wx, wy, wz)` — World → vehicle-local
- `Coords.buildBoneRotMatrix(rx, ry, rz)` — Build world-space rotation matrix from bone angles (ZXY order)
- `Coords.boneLocalToWorld(...)` / `Coords.worldToBoneLocal(...)` — Bone-relative transforms

### kvp

Typed KVP wrapper with automatic community-prefixing (reads `tlib_community_id` or `sv_projectName`) so each server gets isolated storage.

- `kvp.getString/getFloat/getInt/getBool/getJson(key, default)` — Typed getters with fallback
- `kvp.setString/setFloat/setInt/setBool/setJson(key, value)` — Typed setters
- `kvp.get(key, default)` / `kvp.set(key, value)` — Auto-detect type
- `kvp.has(key)`, `kvp.delete(key)`, `kvp.key(key)` — Utilities

### settings

Typed settings store backed by KVP. Supports default values, user-set tracking, and server-pushed defaults.

- `settings.create(defs)` — Create a store from a definition array `{ key, type, default }[]`
- `store:get(key)` / `store:set(key, value)` — Read/write with KVP persistence
- `store:isUserSet(key)` — `true` if the player explicitly set it (vs. using default)
- `store:applyDefaults(table)` — Apply server defaults only to keys the player hasn't set
- `store:reset(key)` — Reset to default and remove from KVP

### movemode

Drag-to-reposition handler for NUI HUDs. Manages NUI focus, drag tracking, and KVP persistence of position/scale.

- `movemode.create(opts)` — Create an instance with `{ keys, defaults, scaleRange }`
- `instance:load()` — Restore position from KVP
- `instance:getPosition()` — Returns `{ right, bottom, scale }`
- `instance:savePosition(right, bottom, scale)` — Persist to KVP
- `instance:enter()` / `instance:exit()` / `instance:toggle()` — NUI focus control

### layouts

Server-side layout discovery and file loading with template variable substitution.

- `layouts.scan(basePath, matchFile, resourceName?)` — Scan a directory for layout folders
- `layouts.load(basePath, layoutName, fileName, resourceName?)` — Load a layout file's contents
- `layouts.loadTemplate(basePath, layoutName, fileName, vars, resourceName?)` — Load and replace `{{KEY}}` placeholders
- `layouts.clearCache()` — Clear the scan cache

---

## TypeScript / NUI Utilities

tLib ships a set of TypeScript modules (`@tlib/shared`) for use in resource NUI frontends.

### Gizmo (`@tlib/shared/gizmo`)

A Three.js–based 3D editor gizmo for translate, rotate, and scale operations. Used to position objects in world/local space within a web editor.

- `GizmoScene` — Main class. Accepts a `GizmoSceneConfig` with options for `scale`, `picking`, `multiSelect`, and `snap` (LED-to-LED edge snapping).
- `buildVehicleQuat`, `fivemWorldToLocal`, `fivemLocalToWorld` — Vehicle matrix math utilities for syncing the Three.js scene to in-game vehicle state.

### Undo (`@tlib/shared/undo`)

Registry-based undo/redo system decoupled from any specific store or framework.

- `registerUndoable(tag, capture, restore)` — Register a store for snapshot tracking
- `withUndo(label, tags, fn)` — Wrap a mutation in a single undo checkpoint
- `pushUndo(label, tags)` / `commitUndo()` — Manual batch control
- `undo()`, `redo()`, `canUndo()`, `canRedo()`, `clearHistory()`

### Coordinate Utils (`@tlib/shared/coordinate-utils`)

Converts between FiveM's coordinate system (Z-up) and Three.js (Y-up) for web editor scenes.

- `fivemToThreePos(x, y, z)` — FiveM → Three.js position
- `threeToFivemPos(v)` — Three.js → FiveM position
- `applyCameraSync(camera, position, focus)` — Sync a Three.js camera to a FiveM camera state

### Move Mode (`@tlib/shared/move-mode`)

Framework-agnostic drag handler for repositionable NUI elements.

- `createDragHandler(opts)` — Returns `{ onMouseDown, onWheel }` event handlers. Calls `opts.onSave(pos)` when drag ends or scale changes.

---

## Installation

1. Download the latest release and extract `tLib` into your server's resources directory.
2. Add `ensure tLib` to your `server.cfg` **before** any resource that depends on it.

---

## License

MIT — see [LICENSE](LICENSE).
