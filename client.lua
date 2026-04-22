-- client entry point

Permission_registerClientExports()

local ui = Platform.createUI('tLib', 'tLib/ui/index.html')

-- helix can't pass functions across VMs, so storeCallback wraps them as keys.
-- fivem passes functions directly.
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

-- theme first, everything else depends on it
Theme.init(ui)

-- Default dark theme (Blender-inspired, blue accent) is baked into the UI CSS.
-- Consumers can override with AddTheme + SetTheme.

Menu.init(ui)

Toast.init(ui)

Dialog.init(ui)

Platform.onShutdown(function()
    if _TLIB_IS_FIVEM then
        SetNuiFocus(false, false)
    end
    Platform.destroyUI(ui)
    ui = nil
end)

-- Defer readiness signals until the NUI page has loaded its JS bundle and
-- registered all window.addEventListener('message', ...) listeners.  On Helix
-- this fires synchronously (WebUI is same-process); on FiveM the callback
-- runs once the browser posts '__tlib_nui_ready' back to Lua, at which point
-- the adapter flushes any SendNUIMessage calls that were buffered during load.
local _hasLoaded = false

Platform.onNUIReady(function()
    _hasLoaded = true
    MenuState.markReady()
end)

Platform.wrapExport('tLib', 'HasLoaded', function() return _hasLoaded end)
