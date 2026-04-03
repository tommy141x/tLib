-- tLib — root client entry point
-- Initialises each subsystem through the platform adapter so this file runs
-- on both Helix and FiveM without modification.
--
-- Load order (enforced by package.json / fxmanifest.lua):
--   lua/adapter.lua          ← Platform.* API
--   lua/utils/logger.lua     ← Logger.*
--   lua/theme/exports.lua
--   lua/theme/client.lua
--   lua/menu/state.lua
--   lua/menu/actions.lua
--   lua/menu/navigation.lua
--   lua/menu/exports.lua
--   lua/menu/client.lua
--   lua/toast/exports.lua
--   lua/toast/client.lua
--   lua/dialog/state.lua
--   lua/dialog/exports.lua
--   lua/dialog/client.lua
--   client.lua               ← this file

Permission_registerClientExports()

local ui = Platform.createUI('tLib', 'tLib/ui/build/index.html')

-- ── Platform export ───────────────────────────────────────────────────────────
-- Expose Platform to consumer packages via exports['tLib']:Platform().
-- On Helix, functions cannot cross the VM boundary directly, so every function
-- value is wrapped through Platform.storeCallback which stores the closure here
-- in tLib's VM and returns a __tLibCb_ key string.  The consumer's tLibShim.lua
-- unsanitiseReturn (now recursive) unwraps each key back into a proxy callable.
-- On FiveM, Platform.storeCallback is a no-op pass-through, so the functions
-- are returned as-is.
Platform.export('tLib', 'Platform', function()
    local t = {}
    for k, v in pairs(Platform) do
        if type(v) == 'function' then
            t[k] = Platform.storeCallback(v)
        end
    end
    return t
end)

Logger.init(ui)
Logger.registerExports()

-- Theme must be initialised before any other subsystem so that themes can be
-- registered and applied before menus, dialogs, or toasts are first opened.
Theme.init(ui)

-- Default dark theme (Blender-inspired, blue accent) is baked into the UI CSS.
-- Consumers can override with AddTheme + SetTheme.

Menu.init(ui)

Toast.init(ui)

Dialog.init(ui)

Platform.onShutdown(function()
    Platform.destroyUI(ui)
    ui = nil
end)
