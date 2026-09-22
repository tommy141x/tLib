-- client entry point

Permission_registerClientExports()

local ui = Platform.createUI('tLib', 'tLib/client/ui/index.html')

-- Functions cannot cross a resource boundary as themselves; storeCallback hands
-- back a key the caller can invoke.
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

-- Default neutral dark theme with restrained blue accents is baked into the UI CSS.
-- Consumers can override with AddTheme + SetTheme.

Toast.init(ui)

Dialog.init(ui)
HudLayout.init(ui)

-- The menu engine. It takes no focus and draws nothing on its own: until a resource
-- registers a namespace and a catalog, this installs the NUI callbacks, the open
-- command and the key slots and then sits idle.
MenuClient.init(ui)

Platform.onShutdown(function()
    if _TLIB_IS_FIVEM then
        -- setKeepInputActive is a separate latch; releasing focus does not clear it.
        SetNuiFocusKeepInput(false)
        SetNuiFocus(false, false)
    end
    Platform.destroyUI(ui)
    ui = nil
end)

-- Defer readiness signals until the NUI page has loaded its JS bundle and
-- registered its window message listeners. The callback runs once the browser
-- posts '__tlib_nui_ready' back to Lua, at which point the adapter flushes any
-- SendNUIMessage calls buffered during load.
local _hasLoaded = false

Platform.onNUIReady(function()
    _hasLoaded = true
    -- The menu engine is deliberately NOT started from here. It gates on its own
    -- readiness signal -- the browser's `menu_ready` callback, which carries the
    -- first snapshot request -- because the page being loaded is not the same as the
    -- menu component inside it being mounted and able to accept a catalog.
end)

Platform.wrapExport('tLib', 'HasLoaded', function() return _hasLoaded end)
