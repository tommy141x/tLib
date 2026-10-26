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
    -- These two rows are the facts worth keeping from tLib's startup logging
    -- (`listening on`, `hub:`, spawn catalogue, etc -- see server/lib/http/index.ts
    -- and server/lib/spawn/index.ts); the rest is gone or shortened at the source.
    -- Neither is `required`: a server with the hub disabled or nothing spawning
    -- still gets its banner rather than one with a missing row.
    info = {
        -- Absent on a source checkout; `buildOutput` skips an empty value, so this
        -- row appears only on a released build, to tell two 1.0.0 trees apart.
        { key = 'Build',  value = GetResourceMetadata(GetCurrentResourceName(), 'tlib_build', 0) },
        { key = 'Hub',    event = 'tlib:vcInfo:hub' },
        { key = 'Spawns', event = 'tlib:vcInfo:spawns' },
    },
})
