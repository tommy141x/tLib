![tLib](https://timmygstudios.com/assets/tLib/banner.jpg)

# tLib

A shared utility library for FiveM resources. Provides a UI component suite (menus, dialogs, toasts, themes), 40 reusable Lua import modules (access, permission, config, KVP, settings, platform, and more), and TypeScript/NUI utilities (3D gizmo, undo system, coordinate helpers) that other resources can depend on.

FiveM is the only supported runtime. Everything goes through an internal `Platform`
adapter, so a second runtime could be added without touching the subsystems above it.

---

## Systems

### Menu System

One NUI menu, shared by every resource on the server. tLib owns the screen, the
keyboard and the permission check; a consumer declares pages and handles rows.

The API is **declarative, and split across the two sides deliberately**. Pages are
registered on the **server**, because what a player may see is a server decision: the
server answers every open with that player's own ACE-filtered tree, so there is no
path to a row the player is not entitled to. The **client** side registers what turns
that tree into behaviour — the handlers, the presenters that fill rows in at the
moment they are shown, and the hooks that react to entering or leaving a page.

Menu IDs are namespaced: every page a resource registers must be `owner:name`. Every
export below takes an optional trailing `declaredOwner`, used only where the platform
cannot identify the caller; pass it as its own argument, never as the result of a call
in the last argument slot (`f(json.decode(x))` expands to *two* values and the second
lands in `declaredOwner`).

**Start here:** [Developing modular menu resources](docs/content/menu-consumers.mdx) covers a complete standalone consumer, registration/restart lifecycle, stable host slots, ownership and placement. `tlib.lifecycle` (shared import) and `tlib.menuhost` (server import) both expose API `version = 1`; they run in the caller's VM and contain no consumer-specific policy.

**Server — declaring the tree**
- `DefineMenuNamespace(spec)` — Required first. `{ ace, catalog?, order?, capabilities?, theme? }`. `ace` gates the whole namespace.
- `RegisterMenuDomains(domains)` — Rate/cooldown domains actions may be assigned to.
- `RegisterMenu(menu, definition)` — One page plus its authority: `definition` is `{ ace, actions = { [itemId] = { ace, run?, clientAction?, cooldown?, fixedValue?, domain? } }, theme?, rootVisible? }`. `rootVisible = false` omits the automatic shared-root link without changing direct access or permissions.
- `UnregisterMenu(menuId)`
- `RegisterMenuAuthority(spec)` / `UnregisterMenuAuthority()` — Answer for rows this resource does not own.
- `OnMenuSnapshot(hook)` — Adjust a player's tree as it is built for them.
- `RefreshMenus()` — Re-push every open menu.

**Server — changing what is already registered**
- `PatchMenuItem(menuId, itemId, changes)` / `PatchMenuAction(itemId, changes)` — The second finds the page itself.
- `SetMenuLinks(menuId, links)` — Replace dynamic submenu rows on a page **you own**; `links` is an array of ordinary `kind = 'submenu'` rows, or `{}` to remove them. Base rows/actions are unchanged. Targets remain permission-filtered and disappear when unavailable. A catalogued page with links travels as a full descriptor (100 rows total, the existing descriptor schema limit); removing all links restores compact delivery.
- `SetMenuItemVisible(itemId, visible)`
- `SetPlayerMenuOptions(source, itemId, options)` — One player's own choices for a selector.
- `SetMenuNamespaceTheme(theme)` / `SetMenuTheme(menuId, theme)` — `nil` clears.

**A menu theme** — `{ accent = '#rrggbb', banner = { dictionary, texture } | { url }, theme = '<AddTheme id>', skin = 'default' | 'vmenu' }`. Every field is optional; at least one must be set. The same shape is accepted at all three layers, resolved most-specific-first and flattened field by field: the page's own theme, then the theme of the resource that created it, then the interface default. A resource that sets only an accent therefore keeps the interface's banner.

`skin` selects the presentation rather than a colour, so it is a closed set rather than a free string:

| Skin | |
|---|---|
| `default` | The shared look. The same controls, checkboxes, sliders and face as tLib's dialogs and toasts. |
| `vmenu` | The legacy vMenu-styled presentation, kept switchable for a test or a side-by-side comparison. |

`theme` names a theme registered with `AddTheme`, which is where full CSS-variable control lives — referenced rather than duplicated, so there is one theme registry and not two. To make a menu, its toasts and its dialogs match, register **one** theme id setting the `nui-*` variables (see the Theme System section) and pass that id as the menu's `theme`, as `ShowDialog`'s `theme` option, and as `ShowToast`'s `theme` argument.

**Client — behaviour**
- `RegisterMenuActions(handlers)` — `{ [name] = function(value, context) end }`, registered as one table: all of it installs or none of it does.
- `RegisterMenuCatalogProvider(provider)` — Build this resource's catalog once, off a function that may yield.
- `RegisterMenuHooks(spec)` — `{ snapshot, enter, leave, page, selection, close }`. `enter` may refuse a navigation.
- `RegisterMenuPresenter(spec)` / `UnregisterMenuPresenter()` — Fill rows in as a page is presented.
- `RegisterMenuStrings(dictionaries)` — Translations for this resource's rows.
- `ConfigureMenuInterface(spec)` — The root page. One screen, so the last caller wins.
- `SetMenuEffect(name, enabled, definition)` — A handler that keeps running after the row was activated, re-checked against the player's grants while it does.
- `PublishMenuItem(name, changes)`, `SetMenuItemState(name, value)`, `GetMenuItemState(name)`, `ExecuteMenuAction(name, value, context)`
- `OnMenuActionsCleanup(fn)` / `OnMenuActionsPersist(fn)`

**Client — the screen** (unscoped: it belongs to the player, not to a resource)
- `OpenMenu(menuId?)` — Re-checks the page against a fresh permission-filtered snapshot.
- `CloseMenu()` — The same teardown the close key runs. Does not toggle: closing a menu that is not open answers `false, 'Menu is not open'`, so a caller that meant to close one is never the reason a fresh one appeared. Needed before `OpenMenu`, which refuses while a menu is already up.
- `IsMenuVisible()`, `GetMenuStackIds()`, `NavigateMenu(menuId)`, `InvalidateMenuContext()`
- `BindMenuKey(menuId)` — Claim a key-binding slot for a page; returns the command it runs under.
- `SetMenuLocale(tag)` / `GetMenuLocale()`, `SetMenuAnchor(anchor)`, `SetMenuPalettes(value)`
- `PromptMenuText(title, initial, maximum, context)` — The game's own onscreen keyboard. Only from inside an action handler, whose `context` it needs.

**A page**

```lua
{ id = 'myres:tools', title = 'Tools', subtitle = ..., description = ..., parent = ..., items = { ... } }
```

**A row** — `kind` is one of `action`, `toggle`, `select`, `slider`, `submenu`, `status`.

| Key | Type | Description |
|---|---|---|
| `id` | `string` | `owner:name`, and permanent: it is what the server authorizes and what state is stored under. |
| `label` / `description` | `string` | What the row says, and the line under the panel. |
| `value` | `boolean\|string\|number` | A toggle's state, a slider's position. |
| `options` / `index` | `table` / `number` | A selector's choices and which one is current. |
| `min` / `max` / `step` | `number` | A slider's bounds. |
| `menu` | `string` | A submenu row's destination page. |
| `confirm` | `string` | Ask this before the row runs. |
| `icon` / `rightIcon` / `rightLabel` | `string` | Row decoration. |

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
- `DismissAll()` — Dismiss the calling resource's visible toasts immediately.

IDs are local to the producing resource. Updates/dismissals cannot alter another producer's notifications, and producer stop removes persistent cards. Type changes or `duration = 0` restart the type default; text/theme-only updates keep the deadline. Limits: 32 active per producer, 256 total; `ShowToast` returns `nil, reason` at capacity.

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
- `tLib:toast:shown` — `(id, toastType, title, owner)`
- `tLib:toast:updated` — `(id, patch, owner)`
- `tLib:toast:dismissed` — `(id, owner)` for explicit dismissal
- `tLib:toast:dismissedAll` — `(owner)`

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

**Theming every surface at once**

The menu, dialogs and toasts all render the same controls, so one set of variables themes all three. Set these in `cssVars` (without the leading `--`) and the theme will look the same wherever it is applied:

| Variable | |
|---|---|
| `nui-surface` / `nui-inset` | Panel background, and the recessed background of inputs. |
| `nui-text` / `nui-muted` | Body ink, and secondary ink. |
| `nui-border` / `nui-control-border` | Panel edges, and control edges. |
| `nui-hover` | Hovered/secondary fill. |
| `nui-accent` / `nui-accent-text` | Selection, checked boxes, slider fill — and the ink that sits on them. |
| `nui-danger` | Destructive actions and errors. |
| `nui-radius` | Corner radius. |

These take **full CSS colours** (`#7c5cff`, `oklch(...)`, `color-mix(...)`), not the bare HSL channel triples the shadcn-style `--primary`/`--card` variables expect. Mixing the two conventions is the mistake this set exists to avoid. A theme's variables are applied as inline styles on the surface it is scoped to, so anything set here overrides the defaults for that surface only — other open UI keeps its own theme.

**Events**
- `tLib:theme:added` — `(id)`
- `tLib:theme:removed` — `(id)`
- `tLib:theme:set` — `(id)`

---

### HUD Layout

One HUD editor for the whole server. A resource registers its on-screen element and tLib
gives the player a single place to move, scale and hide every registered element together.

- `RegisterHudComponent(id, options, fn)` — `fn(layout)` runs whenever this component's
  layout changes. `options` is `{ label, width, height, canHide?, canScale?, minScale?,
  maxScale?, defaults = { x, y, scale, visible, anchor } }`.
- `UnregisterHudComponent(id)`, `GetHudLayout(id)`
- `OpenHudEditor(opts)` / `CloseHudEditor()` — `{ demo = true }` adds a sample component.

Layouts are stored per server endpoint. Without one — no `tlib_hud_profile` convar and no
endpoint — they are session-only, and tLib logs that at startup rather than silently losing
them.

---

### Marketplace

The in-game panel for browsing and installing content a resource publishes.

- `RegisterMarketplaceType(kind, opts)` — Server. Declare a content type this resource provides.
- `OpenMarketplace(opts)` / `CloseMarketplace()` — Client. `{ type = 'ui-radio' }` filters the
  panel on open.

The marketplace needs **no credential and no setup** — it works on a fresh install.
The only convar here is optional, and only if you self-host:

```cfg
setr tlib_api_base_url "https://timmygstudios.com"   # only to self-host
```
Unset, browse/preview/install and community-config publish refuse and log the convar
name once rather than falling back to a shared built-in value. `tlib_api_base_url`
is the opposite case: client Lua reads it too, so it needs `setr` or the in-game panel
keeps talking to the default host while the server talks to yours.

It is a **single** switch for the whole TIMMYG Studios API, not just the marketplace:
browse, preview, install downloads, community configs and the startup version check with
its changelog all follow it, so pointing it at a local `wrangler dev` worker moves all of
them together. A trailing slash or a trailing `/api…` path is trimmed, nothing caches the
value, and the GitHub release check is deliberately unaffected. See
`docs/content/convars.mdx`.

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

**From another resource**
```lua
local log = exports['tLib']:CreateLogger('mypkg', print)

log('Something happened')       -- INFO
log('Something went wrong', 4)  -- ERROR
```

**Exports**
- `exports['tLib']:CreateLogger(loggerId, printFn, opts)` — A log function pinned to a source name. `opts.minLevel` overrides the global level for this logger alone.
- `exports['tLib']:Log(loggerId, args)` — Format and filter one line, and leave the printing to the caller. Returns the formatted string, or `nil` when filtered or empty.
- `exports['tLib']:SetLogLevel(level)` — Set the global minimum log level (`1`–`4`).

---

### Public HTTP hub and application mounts

`tLib` owns one public HTTP listener and the hub at `/`. Apps own their routes and
login/authorization; registering an app does **not** add shared authentication.
The listener starts with tLib even when no consumer opts into web publication.
Exposure and hub visibility are separate: zero visible destinations shows an empty
state, exactly one redirects to that destination, and multiple destinations show
sibling cards. GET and HEAD use the same status/headers (HEAD has no body). A
single visible Radio Admin destination therefore redirects `/` to `/dispatch/admin`.

Configure networking once in `server.cfg`, before starting tLib:

```cfg
set tlib_http_port 7777
set tlib_http_host "0.0.0.0"
# Optional: use your reachable address instead of automatic public-IP detection.
set tlib_http_public_url "192.0.2.10"
```

Defaults are port `7777`, bind host `0.0.0.0`, and an empty public-URL override.
Bare IP/localhost shorthand uses HTTP and the listener port; `example.com` uses
`https://example.com`; an explicit URL is honored. A public URL is an advertised
address, not a request to bind that address or provision TLS. For HTTPS, terminate
TLS at your proxy/tunnel and forward to tLib's actual HTTP listener. Use an origin
without an extra path prefix for the built-in `/dispatch` and `/db` integrations.
Only open/forward the listener if browser access is wanted; app-internal loopback
ports are never firewall settings. A configured URL is not proof of external
reachability—verify through the actual public edge separately.

Consumer exposure is a separate startup decision:

- **tRadio:** `Config.exposeWeb = false` by default. `true` additionally publishes
  `/dispatch` (including admin, API, federation and desktop access). Native
  in-game radio/panels do not require it. `useLegacySocketTransport` is a separate,
  deprecated transport choice, not an automatic consequence of publication.
  `Config.showDispatchInHub = true` and `Config.showAdminInHub = false` independently
  control its Dispatch and Radio Admin cards. These are startup settings; neither
  enables exposure, changes authentication, nor removes a direct URL.
- **tDB:** the current `Config.ExposeAdmin = true` publishes the **PocketBase admin
  and API**, not just a login page. `/db` redirects to `/db/_/`. Set it explicitly
  to `false` to keep local PocketBase private; internal database consumers still
  work. A missing setting defaults to false. Remote PocketBase mode is not
  published through tLib. `Config.ShowInHub = true` controls the Database card
  independently; false hides it but does not unpublish `/db` when ExposeAdmin is true.

Restart the relevant resource to apply its exposure setting. Neither app owns a
public port, and disabling its mount does not shut down tLib's hub or other apps.

**Server exports**

| Export | Contract |
|---|---|
| `GetHttpStatus()` | Readiness snapshot described below. |
| `GetHubUrl()` | Public base URL only when ready; otherwise `""`. Never an implicit/provisional localhost URL. Explicit localhost configuration is supported. |
| `RegisterWebApp(options)` | `{ ok = true, url = ... }` only after the listener and public address are ready. Otherwise `{ ok = false, error = ... }`, with `retryable = true` for router/address unavailability. |
| `UnregisterWebApp()` | Removes mounts belonging to the calling resource; returns the number removed. |
| `ListWebApps()` | Registered descriptors; each `url` is unavailable while the router is not ready. `listed` controls hub presentation, not access. |

`RegisterWebApp` requires `mount` and the app's **actual bound loopback `port`**.
Optional fields: `id`, `host` (loopback only), `stripPrefix` (default false),
`websocket` (default false), `index` (entrypoint relative to the mount), and hub
presentation `title`, `icon`, `description`, `accent`, `listed` (default true).
`listed` controls only the primary destination. Optional `hubLinks` adds independent
sibling cards within the same mount, **not** nested proxy registrations:

```lua
-- Options within a single /dispatch RegisterWebApp registration:
listed = false, -- hide Dispatch while retaining direct access
hubLinks = {
    { id = 'admin', path = '/admin', title = 'Radio Admin', listed = true },
},
```

Each child supports `id`, `path`, `title`, `listed` (default true), `icon`,
`description`, and `accent`. IDs are stable within a mount (ASCII letters, digits,
underscore or hyphen, 1–64 characters; `root` is reserved). Paths are literal,
canonical, mount-relative paths such as `/admin`: no schemes, protocol-relative
URLs, percent escapes, traversal, backslashes, query strings or fragments.
Invalid child entries are omitted without taking the app offline; at most 16 are
considered. Duplicate IDs and destination paths do not create extra cards or
change root counting. Primary destinations honor a valid `index` entrypoint.
Hiding the primary destination does not hide an explicitly listed child. **Hidden
is not authenticated or private**—only the app's auth rules control access.

With prefix stripping, tLib also rewrites cookie paths and root-relative
redirects; URLs in response bodies and browser-generated paths remain the app's
responsibility. Overlapping mounts are rejected, not silently replaced.

**Readiness and retry lifecycle**

`GetHttpStatus()` and the server-local **`tLib:http:status`** event use the same
snapshot (nullable fields may arrive as `nil` in Lua):

| Field | Meaning |
|---|---|
| `ready` | Listener is accepting connections and the public URL is resolved. Does not prove WAN reachability or upstream app health. |
| `listenerState` | `starting`, `listening`, `failed`, or `stopped`. |
| `publicUrlState` | `resolving`, `ready`, or `failed`. |
| `publicUrl` | Resolved advertised base, or null. May be known before the listener is ready; do not use it as proof of publication. |
| `localUrl` | Actual HTTP listener endpoint, or null. Wildcard binds are represented by a loopback endpoint. Use this for local route health checks. |
| `error` | Failure description, or null. |

For example, with public `https://example.com` and local listener 7777, probe
`GetHttpStatus().localUrl + "/db/api/health"`, **not** localhost port 443 derived
from `GetHubUrl()`.

1. Start the app's private loopback listener and retain the port it actually got.
2. Subscribe to `tLib:http:status`, **then query** `GetHttpStatus()` so readiness
   cannot be missed if tLib finished before the app started.
3. When ready, register once and advertise only the successful result's `url`.
   A retryable failure reserves no mount; retry when a ready notification arrives.
   A validation/collision failure needs correction, not a tight retry loop.
4. Clear published links when readiness is lost or tLib stops. Keep unrelated
   local/native functionality running. On tLib resource start, re-query and
   re-register once ready; do not reuse a registration from its previous lifetime.
5. Stopping the app removes its mounts automatically. Rebinding while the app
   stays running requires unregistering before registering the new port.

Failed automatic IP discovery does not advertise localhost or create speculative
OAuth callbacks. Set `tlib_http_public_url` to a reachable address (explicit
`localhost` is valid for development), then restart tLib and let consumers
re-register. Listener bind failures are reported separately and require fixing
the local bind configuration before retrying.

### HTTP Helper

Non-blocking server-side HTTP/HTTPS requests through FiveM's native `PerformHttpRequest`. This helper is separate from tLib's public HTTP routing hub.

- `Platform.Fetch(opts, callback)` — Internal adapter API used within tLib.
- `exports['tLib']:Fetch(opts, callback)` — Public export for use from other packages.

**`Fetch` opts**

| Key | Type | Description |
|---|---|---|
| `url` | `string` | Required. Full URL including scheme (`http://` or `https://`). |
| `method` | `string` | HTTP method (default `"GET"`). |
| `headers` | `table` | Request headers as a key/value table. |
| `body` | `string` | Request body. |

**Callback signature:** `function(statusCode, body, headers, errorData)` — FiveM's native response arguments are forwarded unchanged. Inspect the status and error data; an HTTP error is not a successful application response.

Redirect following is enabled. This wrapper does not expose custom timeout or TLS-verification options and does not require LuaSocket/LuaSec.

---

## Import Modules

Lightweight Lua modules a dependent resource reaches through the `tlib` global. Each is isolated and loads on first access, so nothing has to be declared — `@tLib/imports.lua` in `shared_scripts` is the whole setup. `tlib_modules` is still accepted as a parts list; see `docs/content/import-modules.mdx` for what it does and does not buy.

```lua
local coords = tlib.coords
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

### modules

Server-side content discovery. A module is a self-contained folder plus a
`module.json` declaring what it is — `kind` (`layout` | `theme` | `sound`), `id`,
`name`, `version`, and optionally `author`, `license`, `description` and `slug`.

- `modules.scan(basePath, kind, resourceName?)` — The ids of every usable module of `kind`, sorted
- `modules.list(basePath, kind, resourceName?)` — The same, as `{ id, manifest }`
- `modules.read(basePath, id, kind?, resourceName?)` — One validated manifest, or `nil, err`
- `modules.load(basePath, id, fileName, resourceName?)` — Read a file out of a module folder
- `modules.hasFile(basePath, id, fileName, resourceName?)` — Whether a module ships an optional asset
- `modules.validate(raw, id, kind?)` — Validate a decoded manifest directly
- `modules.clearCache()` — Clear the scan cache, for modules added at runtime
- `modules.onRefusal(basePath, id, err)` — Replace with your logger

`sounds` and `themes` are reserved names: they are the category directories
inside `layouts/` and cannot be module ids. A `kind` that disagrees with the
directory it sits in is refused rather than loaded.

⚠️ **This module discovers `layout` and `theme` only.** `kind: "sound"` is valid
in the TypeScript contract — the studio generates it and the marketplace
installer consumes it — but on a FiveM resource a sound is a flat audio file in
`layouts/sounds/`, so that an operator can drag a `.wav` in with no manifest to
author. The installer reads a sound module and writes only its audio.

**Replaces `tlib.layouts`, which never shipped outside this tree** — see
`docs/content/import-modules.mdx` for what a consumer writes instead.

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

---

## Installation

1. Download the latest release and extract `tLib` into your server's resources directory.
2. Add `ensure tLib` to your `server.cfg` **before** any resource that depends on it.
3. That's it — nothing else is required. The marketplace needs no configuration.

Every convar tLib reads — name, unit, default, and whether it needs `set` or `setr` — is
listed in one place: [`docs/content/convars.mdx`](docs/content/convars.mdx).

---

## Building from source

A checkout does not contain the built runtime files; the resource will not start until
you build it. Requires [Bun](https://bun.sh).

```bash
bun run setup     # install root + client/web dependencies
bun run build     # emit client/ui/index.html, client/ui/assets/hud-layout.js, server/dist/bundle.js
```

`bun run prod` packages a release zip from those artifacts.

### Checks

```bash
bun run check:regression   # typecheck + bun tests + Lua suites + the gates
bun run check              # biome lint + format
bun run check:fix          # ...and apply what it can
bun run check:comments     # the comment-style gate
```

The Lua suites run on Fengari through Bun, so no Lua interpreter is needed.

Comments have a written standard — [docs/CODE-STYLE.md](docs/CODE-STYLE.md) —
and `check:comments` enforces the mechanical parts of it. Read it before adding
a comment.

---

## License

MIT — see [LICENSE](LICENSE).
