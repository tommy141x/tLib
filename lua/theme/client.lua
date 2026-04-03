-- tLib/lua/theme/client.lua
-- Theme subsystem coordinator. Loads sub-modules in dependency order on Helix
-- (where require() is the file-load mechanism). On FiveM all sub-files are
-- already executed by the runtime before this file runs (fxmanifest.lua lists
-- them in order in client_scripts), so the require() call is skipped to
-- avoid "module not found" errors from FiveM's Lua runtime.

if _TLIB_IS_HELIX then
    require('lua/theme/exports')
end

Theme = {}

function Theme.init(ui)
    ThemeExports.register(ui)
end
