-- tLib/lua/dialog/client.lua
-- Dialog subsystem coordinator. Loads sub-modules in dependency order on Helix
-- (where require() is the file-load mechanism). On FiveM all sub-files are
-- already executed by the runtime before this file runs (fxmanifest.lua lists
-- them in order in client_scripts), so the require() calls are skipped to
-- avoid "module not found" errors from FiveM's Lua runtime.

if _TLIB_IS_HELIX then
    require('lua/dialog/state')
    require('lua/dialog/exports')
end

Dialog = {}

function Dialog.init(ui)
    DialogState.setUI(ui)
    DialogExports.register()
end
