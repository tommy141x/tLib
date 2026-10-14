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

local vc = load(LoadResourceFile(GetCurrentResourceName(), 'shared/imports/versioncheck/server.lua'), '@@tLib/shared/imports/versioncheck/server.lua')()

vc({
    name    = 'tLib',
    current = GetResourceMetadata(GetCurrentResourceName(), 'version', 0),
    author  = 'TIMMYG Studios',
    fetch   = vc.github('tommy141x/tLib'),
    -- tLib printed more loose startup lines than any other resource here --
    -- `listening on`, `hub:`, the spawn catalogue, and a full command line per
    -- spawned process -- while its own banner carried nothing but a version.
    -- These two rows are the facts worth keeping; the rest is gone or shortened
    -- at the source. See server/lib/http/index.ts and server/lib/spawn/index.ts.
    --
    -- Neither is `required`: a server with the HTTP hub disabled, or one where
    -- nothing ever spawns, still gets its banner. A startup summary that
    -- refuses to draw because an optional subsystem is absent is worse than one
    -- with a missing row.
    info = {
        { key = 'Hub',    event = 'tlib:vcInfo:hub' },
        { key = 'Spawns', event = 'tlib:vcInfo:spawns' },
    },
})
