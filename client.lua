-- client entry point

Permission_registerClientExports()

local ui = Platform.createUI('tLib', 'tLib/ui/build/index.html')

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
    Platform.destroyUI(ui)
    ui = nil
end)

exports('HasLoaded', function() return true end)
