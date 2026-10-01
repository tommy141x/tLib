-- Exporting a config into another resource must never claim to have worked.
--
-- FiveM sandboxes every resource to its own directory. Measured on this server,
-- from one resource's VM: SaveResourceFile into your OWN resource returns 1,
-- into another STARTED resource returns false, and into a resource that does not
-- exist it RAISES. `_saveFile` used to discard all three. The result was a
-- server that logged the failed write, logged success one line later, and sent
-- the player a green "Exported" chat message, while the file on disk was never
-- touched and a restart reverted everything.
--
-- These are the oracles for the fix:
--   * a refused write is reported as a failure, never as success
--   * a refused write stages the finished file somewhere the operator can reach
--     it, and names the destination, the manifest line and the one-time grant
--   * nothing is committed — not the local file, not the old owner's copy, not
--     the new attribution — until the destination write has actually landed
--   * a raising target is caught rather than unwinding the handler
--   * "move back to local" really deletes the external copy, and says so when it
--     cannot
--   * hasMetadata reflects the manifest, not who happens to be serving a config
local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

-- ── host ────────────────────────────────────────────────────────────
local env = setmetatable({}, { __index = _G })
env._G = env
env._TLIB_IS_FIVEM = true
env.handlers = {}
env.nextCookie = 0

env.AddEventHandler = function(name, fn)
    env.nextCookie = env.nextCookie + 1
    local entry = { fn = fn, live = true, cookie = env.nextCookie, event = name }
    env.handlers[name] = env.handlers[name] or {}
    table.insert(env.handlers[name], entry)
    return entry
end
env.RemoveEventHandler = function(entry) if type(entry) == 'table' then entry.live = false end end
env.RegisterNetEvent = function() end
env.TriggerEvent = function() end

local clock = 0
env.GetGameTimer = function() clock = clock + 10000 return clock end

local function emit(name, ...)
    for _, entry in ipairs(env.handlers[name] or {}) do
        if entry.live then entry.fn(...) end
    end
end

env.replies = {}
env.TriggerClientEvent = function(name, target, a, b)
    env.replies[#env.replies + 1] = { event = name, target = target, a = a, b = b }
end
env.TriggerServerEvent = function() end

-- ── a fake filesystem with FiveM's real refusal rules ────────────────
--
-- `files[resource][path] = contents`. `writable[resource]` mirrors the measured
-- native: only a resource tLib is allowed to write into accepts a write, an
-- unknown resource raises, and everything else returns false.
local files = { tLib = {}, consumer = {}, vehicle = {}, other = {} }
local writable = { tLib = true }
local existing = { tLib = true, consumer = true, vehicle = true, other = true }

env.LoadResourceFile = function(resource, path)
    return (files[resource] or {})[path]
end
env.SaveResourceFile = function(resource, path, content)
    if not existing[resource] then
        error('Script error in Native SaveResourceFile: "Resource ' .. tostring(resource) .. ' not found."')
    end
    if not writable[resource] then return false end
    files[resource] = files[resource] or {}
    files[resource][path] = content
    return 1
end

env.meta = { vehicle = { demo_config = 'demo.json' } }
env.GetResourceMetadata = function(resource, key)
    return (env.meta[resource] or {})[key]
end
env.resourceList = { 'consumer', 'vehicle', 'other' }
env.GetNumResources = function() return #env.resourceList end
env.GetResourceByFindIndex = function(i) return env.resourceList[i + 1] end
env.GetResourceState = function() return 'started' end
env.GetHashKey = function(s) return #tostring(s) end
env.GetInvokingResource = function() return 'consumer' end
env.GetCurrentResourceName = function() return 'tLib' end

-- tLib's own Node exports. WriteResourceFile is the staging write and is only
-- ever asked to write into tLib itself; AppendToManifest is Node `fs` and is
-- refused wherever SaveResourceFile is.
env.manifestWrites = {}
env.exports = setmetatable({}, {
    __index = function(_, resourceName)
        return setmetatable({}, {
            __index = function(_, method)
                if resourceName == 'tLib' and method == 'WriteResourceFile' then
                    return function(_self, target, relPath, contents)
                        if not writable[target] then
                            return "EPERM: '" .. tostring(target) .. "' is not writable"
                        end
                        files[target] = files[target] or {}
                        files[target][relPath] = contents
                        return true
                    end
                end
                if resourceName == 'tLib' and method == 'AppendToManifest' then
                    return function(_self, target, key, filePath)
                        if not writable[target] then return false end
                        env.manifestWrites[#env.manifestWrites + 1] =
                            { resource = target, key = key, path = filePath }
                        return true
                    end
                end
                return function() return false end
            end,
        })
    end,
})

env.logs = {}
env.Logger = { create = function()
    return function(message) env.logs[#env.logs + 1] = tostring(message) end
end }
env.Permission = { isPlayerAdmin = function() return true end }

-- A JSON stand-in that round-trips real tables. The suite asserts on what landed
-- in which file, so encode/decode has to preserve structure; serialising it to
-- text would only add a parser to debug.
local blobs = {}
local function deepcopy(v)
    if type(v) ~= 'table' then return v end
    local out = {}
    for k, val in pairs(v) do out[k] = deepcopy(val) end
    return out
end
env.json = {
    encode = function(t)
        blobs[#blobs + 1] = deepcopy(t)
        return '#blob' .. #blobs
    end,
    decode = function(raw)
        local i = tonumber(tostring(raw):match('^#blob(%d+)$'))
        if i then return deepcopy(blobs[i]) end
        return nil
    end,
}
local function fileTable(resource, path)
    local raw = (files[resource] or {})[path]
    if not raw then return nil end
    return env.json.decode(raw)
end

env.Platform = { _stub = function(name) return function() error(name .. ' is stubbed') end end }
env.source = 1

local function run(path) return assert(loadfile(path, 't', env))() end
run('shared/lib/adapter/events.lua')
run('shared/lib/adapter/lifecycle.lua')
run('server/sv_discovery.lua')

local function create(extra)
    local o = {
        metadataKey = 'demo_config',
        defaultFileName = 'demo.json',
        localFile = 'data.json',
        localSection = 'vehicles',
        resourceName = 'consumer',
        eventPrefix = 'demo',
        permissionCheck = function() return true end,
    }
    for k, v in pairs(extra or {}) do o[k] = v end
    return env.Discovery.create(o)
end

local function seedLocal()
    files.consumer['data.json'] = env.json.encode({ vehicles = { car = { siren = { maxHz = 745 } } } })
end

local function findLog(needle)
    for _, line in ipairs(env.logs) do
        if line:find(needle, 1, true) then return line end
    end
    return nil
end

-- ══ 1. a refused export is a failure, and stages the file ═══════════
seedLocal()
writable = { tLib = true }
local disc = create()
check(disc:getConfigs().car ~= nil, 'the local config loaded')

env.logs = {}
local ok, targetPath, info = disc:exportConfig('car', 'vehicle')
check(ok == false, 'a refused cross-resource write reports failure, not success')
check(info.status == 'staged', 'and reports that the file was staged instead (got ' .. tostring(info.status) .. ')')
check(info.errorKind == 'denied', 'the sandbox refusal is identified as a permission problem')
check(targetPath == 'demo.json', 'the target path comes from the vehicle manifest')

-- The staged copy is the file the vehicle should end up with, contents and all.
local staged = fileTable('tLib', 'export-staging/vehicle/demo.json')
check(staged ~= nil, 'the finished file is written into tLib where a write is always allowed')
check(staged.car.siren.maxHz == 745, 'and it contains the exported config')
check(staged.car._local == nil, 'with the internal _local marker stripped')
check(info.stagedPath == 'export-staging/vehicle/demo.json', 'the staged path is reported back')

-- The three steps, and the one-time line that would remove the need for them.
check(#(info.steps or {}) == 3, 'three concrete steps are handed back')
check(info.steps[1]:find('export-staging/vehicle/demo.json', 1, true), 'step 1 names the source file')
check(info.steps[1]:find('vehicle/demo.json', 1, true), 'step 1 names the destination')
check(info.manifestLine == "demo_config 'demo.json'", 'the literal fxmanifest line is handed back')
check(info.steps[2]:find("demo_config 'demo.json'", 1, true), 'step 2 carries that line verbatim')
check(info.grantLine == 'add_filesystem_permission tLib write *',
    'the one-time blanket grant is named, and names tLib — the VM that issues the write')
check(findLog('add_filesystem_permission tLib write *'), 'the grant line reaches the server console too')

-- NOTHING was committed. This is the ordering guarantee.
check(files.vehicle['demo.json'] == nil, 'nothing was written into the vehicle resource')
check(disc:getExternalSource('car') == nil, 'the model is NOT attributed to a resource that never got it')
check(disc:getConfigs().car ~= nil, 'the config is still here')
local localAfter = fileTable('consumer', 'data.json')
check(localAfter.vehicles.car ~= nil, 'and the local copy on disk still holds it — the source was not dropped')
print('PASS discovery-export: a refused write fails honestly, stages the file and names the fix (' .. checks .. ')')

-- ══ 2. with the write permitted, the export completes ═══════════════
seedLocal()
files.vehicle = {}
writable = { tLib = true, consumer = true, vehicle = true }   -- the blanket grant is on
disc = create()
env.logs = {}
ok, targetPath, info = disc:exportConfig('car', 'vehicle')
check(ok == true, 'a permitted write reports success')
check(info.status == 'exported', 'and reports that it was exported')
local landed = fileTable('vehicle', 'demo.json')
check(landed and landed.car and landed.car.siren.maxHz == 745, 'the config is in the vehicle file')
check(landed.car._local == nil, '_local is not written into another resource')
local src = disc:getExternalSource('car')
check(src and src.resource == 'vehicle' and src.filePath == 'demo.json', 'the new source is attributed')
check(#env.manifestWrites == 1 and env.manifestWrites[1].resource == 'vehicle',
    'the fxmanifest key is added where the write is allowed')
check(info.manifestOk == true, 'and that is reported')
-- Attribution happens BEFORE the local file is rewritten, so the local copy is
-- actually dropped. In the old order it was rewritten first and kept the entry,
-- which then shadowed the export on the next boot.
local localNow = fileTable('consumer', 'data.json')
check(localNow.vehicles.car == nil, 'the local copy is dropped now that the vehicle owns it')
check(#(info.warnings or {}) == 0, 'a clean export reports no warnings')
print('PASS discovery-export: a permitted write completes, commits in the right order (' .. checks .. ')')

-- ══ 3. merging, not clobbering ══════════════════════════════════════
files.vehicle['demo.json'] = env.json.encode({ van = { siren = { maxHz = 600 } } })
seedLocal()
disc = create()
ok = disc:exportConfig('car', 'vehicle')
check(ok == true, 'export into a vehicle that already ships a config succeeds')
landed = fileTable('vehicle', 'demo.json')
check(landed.van ~= nil, "the vehicle's existing model survives the export")
check(landed.car ~= nil, 'and the new one is beside it')
print('PASS discovery-export: an export merges into the target file (' .. checks .. ')')

-- ══ 4. a target that does not exist raises — and is caught ══════════
seedLocal()
disc = create()
env.logs = {}
ok, targetPath, info = disc:exportConfig('car', 'ghost_resource')
check(ok == false, 'exporting to a resource that does not exist fails')
check(info.errorKind == 'missing', 'and is identified as a missing resource, not a permission problem')
check(tostring(info.error):find('not found', 1, true), 'the real native error is carried, not a guess')
check(disc:getConfigs().car ~= nil, 'the config survives the raise')
print('PASS discovery-export: a raising target is caught, not left to unwind (' .. checks .. ')')

-- ══ 5. move back to local really removes the external copy ══════════
seedLocal()
files.vehicle = {}
writable = { tLib = true, consumer = true, vehicle = true }
disc = create()
check(disc:exportConfig('car', 'vehicle') == true, 'exported first')
check(fileTable('vehicle', 'demo.json').car ~= nil, 'the vehicle holds it')

ok, _, info = disc:exportConfig('car', 'consumer')
check(ok == true, 'moving back to local succeeds')
check(info.status == 'local', 'and says so')
check(fileTable('vehicle', 'demo.json').car == nil, 'the external copy is genuinely gone')
check(disc:getExternalSource('car') == nil, 'and the model is no longer attributed to it')
check(disc:getConfigs().car._local == true, 'the local entry is marked local so it outranks a re-scan')
check(fileTable('consumer', 'data.json').vehicles.car ~= nil, 'and it is back in the local file')
check(#(info.warnings or {}) == 0, 'a clean move reports no warnings')
print('PASS discovery-export: move back to local deletes the external copy (' .. checks .. ')')

-- ══ 6. …and says so when it cannot ═════════════════════════════════
seedLocal()
files.vehicle = {}
writable = { tLib = true, consumer = true, vehicle = true }
disc = create()
check(disc:exportConfig('car', 'vehicle') == true, 'exported first')
writable.vehicle = nil   -- the grant goes away before the move back
env.logs = {}
ok, _, info = disc:exportConfig('car', 'consumer')
check(ok == true, 'the move still completes — a local entry outranks the leftover')
check(#(info.warnings or {}) == 1, 'but it is reported, not swallowed')
check(info.warnings[1]:find('could NOT be deleted', 1, true), 'and the warning says what is stale')
check(info.leftovers and info.leftovers.resource == 'vehicle', 'naming the file to clean up by hand')
check(fileTable('vehicle', 'demo.json').car ~= nil, 'the stale copy is indeed still there')
check(disc:getConfigs().car._local == true, 'the local entry is marked local so the stale copy cannot win')
check(findLog('could NOT be deleted'), 'the console hears about it too')
print('PASS discovery-export: an undeletable external copy is reported, not assumed gone (' .. checks .. ')')

-- ══ 7. hasMetadata comes from the manifest ═════════════════════════
seedLocal()
disc = create()
local targets = disc:getExportTargets()
local byName = {}
for _, t in ipairs(targets) do byName[t.name] = t end
check(byName.consumer and byName.consumer.isLocal, 'the owner is offered as the local target')
check(byName.vehicle and byName.vehicle.hasMetadata == true,
    'a resource that DECLARES the key has metadata, even with nothing serving from it yet')
check(byName.vehicle.configPath == 'demo.json', 'and its declared path is offered')
check(byName.other and byName.other.hasMetadata == false, 'a resource that declares nothing does not')
check(targets[2].name == 'vehicle', 'targets that declare the key sort first')
print('PASS discovery-export: hasMetadata reflects GetResourceMetadata (' .. checks .. ')')

-- ══ 8. the net handler never reports a success that did not happen ══
seedLocal()
files.vehicle = {}
writable = { tLib = true }
disc = create()
env.replies = {}
emit('demo:exportConfig', 'car', 'vehicle')

local said = {}
local result = nil
for _, r in ipairs(env.replies) do
    if r.event == 'chat:addMessage' then said[#said + 1] = tostring(r.a.args and r.a.args[2] or '') end
    if r.event == 'demo:exportResult' then result = r.a end
end
check(result ~= nil, 'the structured result reaches the client')
check(result.status == 'staged', 'carrying the real outcome')
local joined = table.concat(said, ' | ')
check(not joined:find('Exported ', 1, true), 'the player is NOT told the export succeeded')
check(joined:find('Could not write into', 1, true), 'the player is told it did not')
check(joined:find("demo_config 'demo.json'", 1, true), 'and is given the exact fxmanifest line')
check(joined:find('add_filesystem_permission tLib write *', 1, true),
    'and the one-time line that would make it one click')
print('PASS discovery-export: the player is told the truth over the wire (' .. checks .. ' checks)')
