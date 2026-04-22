Discovery.registerExports()
Permission.registerExports()
ServerSettings.registerExports()
Platform.wrapExport('tLib', 'HasLoaded', function() return true end)

-- `ensure [folder]` can start dependents before tLib is ready.
-- track which ones died during boot, restart them once we're up.
local _failedDependents = {}
local _booting = true

local _bootHandler = AddEventHandler('onResourceStop', function(res)
    if not _booting then return end
    if res ~= GetCurrentResourceName() then
        local n = GetNumResourceMetadata(res, 'dependency')
        for d = 0, n - 1 do
            if GetResourceMetadata(res, 'dependency', d) == 'tLib' then
                _failedDependents[res] = true
                break
            end
        end
    end
end)

CreateThread(function()
    Wait(1000)
    for res in pairs(_failedDependents) do
        if GetResourceState(res) == 'stopped' then
            StartResource(res)
        end
    end
    _failedDependents = {}
    _booting = false
    RemoveEventHandler(_bootHandler)
end)

local vc = load(LoadResourceFile(GetCurrentResourceName(), 'imports/versioncheck/server.lua'), '@@tLib/imports/versioncheck/server.lua')()

vc({
    name    = 'tLib',
    current = GetResourceMetadata(GetCurrentResourceName(), 'version', 0),
    author  = 'TIMMYG Studios',
    fetch   = vc.github('tommy141x/tLib'),
})
