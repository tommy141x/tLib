-- A config file that is not JSON must cost only itself: the scan carries on, and
-- nothing is ever written over the unreadable file.
local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

-- host
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

-- Local events are the oracle for the net-handler refusals: `afterSave` firing is
-- how an owner learns a save happened, so a refused save must not fire it.
env.events = {}
env.TriggerEvent = function(name, ...)
    env.events[#env.events + 1] = { name = name, args = { ... } }
end

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

-- `files[resource][path] = contents`. `writable[resource]` mirrors the measured
-- native: a resource tLib may write into accepts the write, an unknown resource
-- raises, everything else returns false.
local files = { tLib = {}, consumer = {}, vehicle = {}, broken = {} }
local writable = { tLib = true }
local existing = { tLib = true, consumer = true, vehicle = true, broken = true }

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

env.meta = {
    vehicle = { demo_config = 'demo.json' },
    broken = { demo_config = 'demo.json' },
}
env.GetResourceMetadata = function(resource, key)
    return (env.meta[resource] or {})[key]
end
env.resourceList = { 'consumer', 'vehicle' }
env.GetNumResources = function() return #env.resourceList end
env.GetResourceByFindIndex = function(i) return env.resourceList[i + 1] end
env.GetResourceState = function() return 'started' end
env.GetHashKey = function(s) return #tostring(s) end
env.GetInvokingResource = function() return 'consumer' end
env.GetCurrentResourceName = function() return 'tLib' end

-- Which resources ship a server bundle and so register their own
-- `WriteResourceFile`. `vehicle` and `broken` are plain asset packs.
local hasBridge = { tLib = true }

env.manifestWrites = {}
env.exports = setmetatable({}, {
    __index = function(_, resourceName)
        return setmetatable({}, {
            __index = function(_, method)
                if method == 'WriteResourceFile' then
                    if not hasBridge[resourceName] then
                        error("No such export WriteResourceFile in resource " .. tostring(resourceName))
                    end
                    return function(_self, target, relPath, contents)
                        if target ~= resourceName then
                            return "EPERM: '" .. tostring(resourceName)
                                .. "' cannot write into resource '" .. tostring(target) .. "'"
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

-- A JSON stand-in that round-trips real tables, and RAISES on anything else the
-- way FiveM's json.decode does. The raise is the whole subject of this suite:
-- without it, a bad file reads as an empty one and every assertion below passes
-- against code that has no protection at all.
local CORRUPT = '{ "car": { "siren": 1, } '
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
        local text = tostring(raw)
        if text == 'null' then return nil end
        local i = tonumber(text:match('^#blob(%d+)$'))
        if i then return deepcopy(blobs[i]) end
        error('Expected value but found invalid token at character 1')
    end,
}
local encode = env.json.encode
local function fileTable(resource, path)
    local raw = (files[resource] or {})[path]
    if not raw then return nil end
    return env.json.decode(raw)
end

env.Platform = { _stub = function(name) return function() error(name .. ' is stubbed') end end }
env.source = 1

local function run(path) return assert(loadfile(path, 't', env))() end
dofile('tests/fixtures/real-module.lua')(env, 'shared/imports/ratelimit/server.lua')
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

local function findLog(needle)
    for _, line in ipairs(env.logs) do
        if line:find(needle, 1, true) then return line end
    end
    return nil
end
local function findLogBoth(a, b)
    for _, line in ipairs(env.logs) do
        if line:find(a, 1, true) and line:find(b, 1, true) then return line end
    end
    return nil
end

local function keySet(t)
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    return table.concat(keys, ',')
end

local function eventNamed(name)
    local found = 0
    local first = nil
    for _, e in ipairs(env.events) do
        if e.name == name then
            found = found + 1
            if not first then first = e end
        end
    end
    return found, first
end

local function replyNamed(name)
    for _, r in ipairs(env.replies) do
        if r.event == name then return r end
    end
    return nil
end

-- 1. one pack's malformed file does not end the scan
--
-- The raise used to unwind scanExternal, so every resource after the bad one in
-- the find index went unread with nothing in the log to say so.
env.resourceList = { 'consumer', 'broken', 'vehicle' }
files.consumer = {}
files.broken = { ['demo.json'] = CORRUPT }
files.vehicle = { ['demo.json'] = encode({ van = { siren = { maxHz = 600 } } }) }
writable = { tLib = true }
env.logs = {}
local disc = create()
check(disc:getConfigs().van ~= nil, 'the pack indexed AFTER the malformed one still loaded')
check(findLogBoth('broken/demo.json', 'not valid JSON'),
    'and the console names the file that could not be read')
check(files.broken['demo.json'] == CORRUPT, 'the malformed file is left exactly as it was')
print('PASS discovery-corrupt-json: one pack\'s malformed file costs that pack, not the scan ('
    .. checks .. ' checks)')

-- 2. the owner's own malformed file is never written over
files.consumer = { ['data.json'] = CORRUPT }
files.vehicle = { ['demo.json'] = encode({ van = { siren = { maxHz = 600 } } }) }
writable = { tLib = true, consumer = true }
env.logs = {}
disc = create()
check(disc:getConfigs().van ~= nil, 'external packs still load when the local file is unreadable')
check(findLogBoth('consumer/data.json', 'not valid JSON'), 'and the console names the local file')

local ok, err, kind = disc:saveModelConfig('truck', { siren = {} })
check(ok == false, 'saving refuses rather than replacing the file it could not read')
check(kind == 'corrupt', 'and says why (got ' .. tostring(kind) .. ')')
check(type(err) == 'string', 'with a message for the caller')
check(files.consumer['data.json'] == CORRUPT, 'the file on disk is byte-identical')
check(disc:getConfigs().truck ~= nil, 'the change is still in effect in memory')

-- Repairing the file on disk does not make this instance safe: it never held the
-- file's contents, so its next write would still replace the lot with one model.
files.consumer['data.json'] = encode({ vehicles = { car = { siren = { maxHz = 745 } } } })
local ok2, _, kind2 = disc:saveLocal()
check(ok2 == false, 'an instance that loaded a broken file still refuses to write')
check(kind2 == 'corrupt', 'for the same reason (got ' .. tostring(kind2) .. ')')
local repaired = fileTable('consumer', 'data.json')
check(repaired.vehicles.car ~= nil, 'the repaired contents survive')
check(repaired.vehicles.truck == nil, 'and the in-memory model was NOT written over them')

local disc2 = create()
check(disc2:getConfigs().car ~= nil, 'a fresh instance reads the repaired file')
check(disc2:saveModelConfig('truck', { siren = {} }) == true, 'and saves normally')
local bothNow = fileTable('consumer', 'data.json')
check(bothNow.vehicles.car ~= nil and bothNow.vehicles.truck ~= nil,
    'with the repaired entry and the new one side by side')

-- The same refusal without a localSection, where configs ARE the whole file.
files.consumer['data.json'] = CORRUPT
local noSection = env.Discovery.create({
    metadataKey = 'demo_config',
    defaultFileName = 'demo.json',
    localFile = 'data.json',
    resourceName = 'consumer',
    eventPrefix = 'demo',
    permissionCheck = function() return true end,
})
local nsOk, _, nsKind = noSection:saveLocal()
check(nsOk == false, 'a sectionless owner refuses the write too')
check(nsKind == 'corrupt', 'with the same kind (got ' .. tostring(nsKind) .. ')')
check(files.consumer['data.json'] == CORRUPT, 'and its file is unchanged')
print('PASS discovery-corrupt-json: the owner\'s malformed file is never overwritten, not even after a hand repair ('
    .. checks .. ' checks)')

-- 3. a malformed EXTERNAL file is not rewritten, and nothing is staged
--
-- A staged copy holding only this one model would read as the finished file, and
-- copying it into place is the overwrite being refused.
files.tLib = {}
files.consumer = { ['data.json'] = encode({ vehicles = { car = { siren = { maxHz = 745 } } } }) }
files.vehicle = { ['demo.json'] = encode({ van = { siren = { maxHz = 600 } } }) }
writable = { tLib = true, consumer = true, vehicle = true }
disc = create()
local vanSource = disc:getExternalSource('van')
check(vanSource and vanSource.resource == 'vehicle', 'the pack owns van to begin with')

files.vehicle['demo.json'] = CORRUPT
env.logs = {}
ok, err, kind = disc:saveModelConfig('van', { siren = { maxHz = 1 } })
check(ok == false, 'saving into a malformed external file fails')
check(kind == 'corrupt', 'and is identified as corruption, not a sandbox refusal (got '
    .. tostring(kind) .. ')')
check(files.vehicle['demo.json'] == CORRUPT, 'the external file is untouched')
check(files.tLib['export-staging/vehicle/demo.json'] == nil, 'and nothing was staged')
print('PASS discovery-corrupt-json: a malformed external file is neither rewritten nor staged ('
    .. checks .. ' checks)')

-- 4. exporting into a malformed target commits nothing
files.tLib = {}
files.consumer = { ['data.json'] = encode({ vehicles = { car = { siren = { maxHz = 745 } } } }) }
files.vehicle = { ['demo.json'] = CORRUPT }
writable = { tLib = true, consumer = true, vehicle = true }
env.logs = {}
disc = create()
local info
ok, _, info = disc:exportConfig('car', 'vehicle')
check(ok == false, 'the export fails')
check(info.status == 'failed', 'and reports failure rather than a staged file (got '
    .. tostring(info.status) .. ')')
check(info.errorKind == 'corrupt', 'naming corruption as the cause (got '
    .. tostring(info.errorKind) .. ')')
check(files.vehicle['demo.json'] == CORRUPT, 'the target file is untouched')
check(disc:getExternalSource('car') == nil, 'the model is not attributed to a resource that never got it')
check(files.tLib['export-staging/vehicle/demo.json'] == nil, 'nothing was staged')
check(fileTable('consumer', 'data.json').vehicles.car ~= nil, 'and the local copy is still on disk')
print('PASS discovery-corrupt-json: an export into a malformed target commits nothing ('
    .. checks .. ' checks)')

-- 5. removing a model whose external file is malformed
files.consumer = { ['data.json'] = encode({ vehicles = {} }) }
files.vehicle = { ['demo.json'] = encode({ van = { siren = { maxHz = 600 } } }) }
writable = { tLib = true, consumer = true, vehicle = true }
disc = create()
check(disc:getConfigs().van ~= nil, 'the pack config loaded')
files.vehicle['demo.json'] = CORRUPT
env.logs = {}
local removed, warning = disc:removeModelConfig('van')
check(removed == true, 'the removal succeeds here')
check(type(warning) == 'string', 'and hands back a warning')
check(warning:find('vehicle/demo.json', 1, true), 'that names the file still holding the entry')
check(files.vehicle['demo.json'] == CORRUPT, 'which was left exactly as it was')
check(disc:getConfigs().van == nil, 'the model is gone from memory')
print('PASS discovery-corrupt-json: a removal says the external file was left alone ('
    .. checks .. ' checks)')

-- 6. net handlers refuse a key that cannot be a model
--
-- A non-string, non-number key becomes a table key json.encode cannot write, so
-- from then on every save of every model fails. The refusal has to land before
-- afterSave and the broadcast, which an owner treats as "it was saved".
files.consumer = { ['data.json'] = encode({ vehicles = { car = { siren = { maxHz = 745 } } } }) }
files.vehicle = {}
writable = { tLib = true, consumer = true }
disc = create()
check(disc:getConfigs().car ~= nil, 'the local config loaded')

local baseline = keySet(disc:getConfigs())
local badModels = { {}, true, '' }
for i = 1, 4 do
    local label = i <= #badModels and type(badModels[i]) or 'nil'
    env.events, env.replies = {}, {}
    emit('demo:config_save', badModels[i], { a = 1 })
    check(keySet(disc:getConfigs()) == baseline,
        'config_save with a ' .. label .. ' model adds nothing to the config map')
    check(eventNamed('demo_config:afterSave') == 0,
        'and does not fire afterSave for a ' .. label .. ' model')
    check(replyNamed('demo:config_receive') == nil,
        'and does not broadcast for a ' .. label .. ' model')
end

env.events, env.replies = {}, {}
emit('demo:config_save', 'car2', 'not a table')
check(disc:getConfigs().car2 == nil, 'config_save with a non-table config stores nothing')
check(eventNamed('demo_config:afterSave') == 0, 'and does not fire afterSave')
check(replyNamed('demo:config_receive') == nil, 'and does not broadcast')

env.events, env.replies = {}, {}
emit('demo:config_save', 'car2', { x = 1 })
check(disc:getConfigs().car2 ~= nil, 'a well-formed save still works')
local saveCount, saveEvent = eventNamed('demo_config:afterSave')
check(saveCount == 1, 'firing afterSave exactly once (got ' .. saveCount .. ')')
check(saveEvent.args[1] == 'car2', 'with the model it saved')
local broadcastReply = replyNamed('demo:config_receive')
check(broadcastReply ~= nil and broadcastReply.target == -1, 'and broadcasting to every client')

local badTargets = { 'a/b', 'a\\b', '', {} }
for i = 1, #badTargets do
    env.events, env.replies = {}, {}
    emit('demo:exportConfig', 'car', badTargets[i])
    check(#env.replies == 0, 'exportConfig with target #' .. i .. ' answers nothing')
    check(eventNamed('demo_config:afterExport') == 0,
        'and does not fire afterExport for target #' .. i)
end

env.events, env.replies = {}, {}
emit('demo:config_remove', {})
check(disc:getConfigs().car ~= nil, 'config_remove with a table key removes nothing')
check(eventNamed('demo_config:afterRemove') == 0, 'and does not fire afterRemove')
print('PASS discovery-corrupt-json: the net handlers refuse a key that cannot be a model ('
    .. checks .. ' checks)')
