-- Admin settings written into a consumer resource must reach the disk or say they did not,
-- must never overwrite a file tLib could not parse, and must not outlive their owner.

local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

local env = setmetatable({}, { __index = _G })
env._G = env
env._TLIB_IS_FIVEM = true
env._TLIB_SIDE = 'server'
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
-- The two-argument form is what Platform.AddNetEventHandler pairs with AddEventHandler;
-- a bare name only declares the event and must register nothing.
env.RegisterNetEvent = function(name, fn)
    if fn then return env.AddEventHandler(name, fn) end
end
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

-- `files[resource][path] = contents`, with the measured native refusal rules: only a
-- resource tLib may write into accepts a write, an unknown one raises, the rest return false.
local files = { tLib = {}, consumer = {} }
local writable = { tLib = true }
local existing = { tLib = true, consumer = true }
local hasBridge = { tLib = true }

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

env.GetResourceMetadata = function() return nil end
env.GetResourceState = function() return 'started' end
env.GetNumResources = function() return 0 end
env.GetResourceByFindIndex = function() return nil end
env.GetHashKey = function(s) return #tostring(s) end
env.GetCurrentResourceName = function() return 'tLib' end
env.invoker = 'consumer'
env.GetInvokingResource = function() return env.invoker end

env.admin = true
env.IsPlayerAceAllowed = function() return env.admin end

-- Each resource's own Node bridge: `exports[X]:WriteResourceFile(X, ...)` writes, because
-- the write then originates inside X and the sandbox has nothing to object to. A resource
-- without a bundle has no such export and the lookup raises.
env.exports = setmetatable({}, {
    __index = function(_, resourceName)
        return setmetatable({}, {
            __index = function(_, method)
                if method == 'WriteResourceFile' then
                    if not hasBridge[resourceName] then
                        error('No such export WriteResourceFile in resource ' .. tostring(resourceName))
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
                return function() return false end
            end,
        })
    end,
})

env.logs = {}
env.Logger = { create = function()
    return function(message) env.logs[#env.logs + 1] = tostring(message) end
end }

-- A JSON stand-in that round-trips real tables, so assertions are about what landed in
-- which file rather than about a parser. `decode` raises on anything else, which is the
-- behaviour the corrupt-file path exists for.
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
local function encode(t) return env.json.encode(t) end
local function fileTable(resource, path)
    local raw = (files[resource] or {})[path]
    if not raw then return nil end
    return env.json.decode(raw)
end
local function findLog(needle)
    for _, line in ipairs(env.logs) do
        if line:find(needle, 1, true) then return line end
    end
    return nil
end
local function countReplies(eventName, target)
    local n, last = 0, nil
    for _, r in ipairs(env.replies) do
        if r.event == eventName and (target == nil or r.target == target) then
            n = n + 1
            last = r
        end
    end
    return n, last
end

local CORRUPT = '{ "volume": 65, } '

env.Platform = { _stub = function(name) return function() error(name .. ' is stubbed') end end }
env.source = 1

local function run(path) return assert(loadfile(path, 't', env))() end
dofile('tests/fixtures/real-module.lua')(env, 'shared/imports/ratelimit/server.lua')
run('shared/lib/adapter/events.lua')
run('shared/lib/adapter/lifecycle.lua')
env.exported = {}
env.Platform.export = function(_, name, fn) env.exported[name] = fn end
run('server/sv_discovery.lua')
run('server/sv_permission.lua')
run('server/sv_serversettings.lua')
env.Permission.registerExports()

local function create(opts)
    opts._resourceName = 'consumer'
    return env.ServerSettings.create(opts)
end

-- a. the native refuses every cross-resource write; the owner's own bridge is the way in
files.consumer = {}
env.logs = {}
writable = { tLib = true }
hasBridge.consumer = true
local ss = create({ file = 'a.json', defaults = { volume = 65 } })
check(ss:getValue('volume') == 65, 'an absent file leaves the defaults in place')
check(ss:set('volume', 80) == true, 'a save delivered through the bridge reports success')
local landed = fileTable('consumer', 'a.json')
check(landed ~= nil, 'the settings file is written into the owning resource')
check(landed.volume == 80, 'and holds the new value')
print('PASS serversettings-persist: a refused native write lands through the owner\'s bridge ('
    .. checks .. ' checks)')

-- b. no bridge, no write: the one case the old bare SaveResourceFile reported as success
files.consumer = {}
env.logs = {}
hasBridge.consumer = nil
ss = create({ file = 'b.json', defaults = { volume = 65 } })
check(ss:set('volume', 80) == false, 'a save that reached no disk reports failure')
check(files.consumer['b.json'] == nil, 'and nothing was written')
check(findLog('consumer/b.json'), 'the failure names the resource and file that did not get it')
check(ss:getValue('volume') == 80, 'the change is still in effect for this session')
print('PASS serversettings-persist: with no bridge the failure is returned and said, not swallowed ('
    .. checks .. ' checks)')

-- c. a section is one key in a shared file, so siblings must survive the rewrite
files.consumer = { ['c.json'] = encode({ other = { keep = 1 }, settings = { volume = 10 } }) }
env.logs = {}
writable = { tLib = true, consumer = true }
ss = create({ file = 'c.json', section = 'settings', defaults = { volume = 65, extra = true } })
check(ss:getValue('volume') == 10, 'the stored section value beats the default')
check(ss:getValue('extra') == true, 'and the default fills in what the section lacks')
check(ss:set('volume', 20) == true, 'the sectioned save reports success')
local doc = fileTable('consumer', 'c.json')
check(doc.other and doc.other.keep == 1, 'a sibling section survives the rewrite')
check(doc.settings.volume == 20, 'and the edited section holds the new value')
print('PASS serversettings-persist: a section save keeps sibling sections (' .. checks .. ' checks)')

-- d. a file tLib cannot parse is a hand edit to repair, not bytes to replace
files.consumer = { ['d.json'] = CORRUPT }
env.logs = {}
writable = { tLib = true, consumer = true }
ss = create({ file = 'd.json', defaults = { volume = 65 } })
check(ss:getValue('volume') == 65, 'an unparseable file falls back to the defaults')
check(findLog('consumer/d.json'), 'the load failure names the file')
check(findLog('not valid JSON'), 'and says what is wrong with it')
check(ss:set('volume', 1) == false, 'a save over an unparseable file reports failure')
check(files.consumer['d.json'] == CORRUPT, 'and the bytes on disk are untouched')
check(ss:getValue('volume') == 1, 'while the change is in effect for this session')

files.consumer['d2.json'] = CORRUPT
env.logs = {}
ss = create({ file = 'd2.json', section = 'settings', defaults = { volume = 65 } })
check(ss:getValue('volume') == 65, 'a sectioned read of an unparseable file also uses the defaults')
check(ss:set('volume', 2) == false, 'and its save reports failure')
check(files.consumer['d2.json'] == CORRUPT, 'leaving every section on disk as it was')
print('PASS serversettings-persist: a malformed file is read as defaults and never overwritten ('
    .. checks .. ' checks)')

-- e. a section holding a scalar is a wrong file, not a settings table
files.consumer = { ['e.json'] = encode({ settings = 'oops' }) }
env.logs = {}
ss = create({ file = 'e.json', section = 'settings', defaults = { volume = 65 } })
check(ss:getValue('volume') == 65, 'a non-table section is ignored rather than adopted')
print('PASS serversettings-persist: a section holding a non-table is not adopted ('
    .. checks .. ' checks)')

-- f. these handlers live in tLib's VM, so a consumer restart leaves two unless one goes
files.consumer = {}
env.logs = {}
writable = { tLib = true, consumer = true }
local fOpts = {
    file = 'f.json',
    defaults = { volume = 0 },
    requestEvent = 'f:request',
    updateEvent = 'f:update',
    saveEvent = 'f:save',
}
local function fresh(t)
    local o = {}
    for k, v in pairs(t) do o[k] = v end
    return o
end
local instA = create(fresh(fOpts))
env.source = 7
emit('f:save', { volume = 1 })
check(fileTable('consumer', 'f.json').volume == 1, 'the first instance saves what an admin sent')

local instB = create(fresh(fOpts))
env.replies = {}
emit('f:save', { volume = 2 })
local n, reply = countReplies('f:update', -1)
check(n == 1, 'exactly one instance answers the save event (got ' .. n .. ' broadcasts)')
check(reply.a.settings.volume == 2, 'and it broadcasts the new value')
check(instA:get().volume == 1, 'the disposed instance did not process the save')
check(instB:get().volume == 2, 'the live instance did')
check(fileTable('consumer', 'f.json').volume == 2, 'and the file holds the live value')

env.replies = {}
emit('f:request')
local rn, rReply = countReplies('f:update')
check(rn == 1, 'exactly one instance answers the request event (got ' .. rn .. ')')
check(rReply.target == 7, 'and replies to the player who asked')
print('PASS serversettings-persist: a consumer restart leaves one instance answering ('
    .. checks .. ' checks)')

-- g. the owner going away has to take its handlers with it
files.consumer = {}
env.logs = {}
local gInst = create({
    file = 'g.json',
    defaults = { volume = 0 },
    requestEvent = 'g:request',
    updateEvent = 'g:update',
    saveEvent = 'g:save',
})
env.source = 7
emit('g:save', { volume = 3 })
check(fileTable('consumer', 'g.json').volume == 3, 'the instance saves while its owner runs')
check(gInst:get().volume == 3, 'and holds the saved value')

emit('onResourceStop', 'consumer')
env.replies = {}
emit('g:request')
check(countReplies('g:update') == 0, 'a stopped owner leaves nothing answering the request event')
emit('g:save', { volume = 9 })
check(fileTable('consumer', 'g.json').volume == 3,
    'nor the save event (got ' .. tostring(fileTable('consumer', 'g.json').volume) .. ')')

create({
    file = 'h.json',
    defaults = { volume = 0 },
    requestEvent = 'h:request',
    updateEvent = 'h:update',
    saveEvent = 'h:save',
})
emit('onResourceStop', 'somethingelse')
env.replies = {}
emit('h:request')
check(countReplies('h:update') == 1, 'an unrelated resource stopping disposes nothing')
print('PASS serversettings-persist: the owner stopping disposes the instance (' .. checks .. ' checks)')

-- h. the save event is the only admin-gated one, and the gate has to hold
files.consumer = {}
env.logs = {}
create({
    file = 'i.json',
    defaults = { volume = 0 },
    requestEvent = 'i:request',
    updateEvent = 'i:update',
    saveEvent = 'i:save',
})
env.admin = false
env.replies = {}
env.source = 7
emit('i:save', { volume = 5 })
check(files.consumer['i.json'] == nil, 'a non-admin save writes nothing')
check(countReplies('i:update') == 0, 'and broadcasts nothing')
env.admin = true
print('PASS serversettings-persist: a non-admin cannot save (' .. checks .. ' checks)')

-- i. RegisterAdminEvent registers in tLib's VM on another resource's behalf
env.invoker = 'plugin'
local calls = {}
env.exported.RegisterAdminEvent('plugin:act', function(src, value)
    calls[#calls + 1] = { 'A', src, value }
end)
env.source = 3
emit('plugin:act', 'x')
check(#calls == 1, 'the registered handler runs for an admin')
check(calls[1][1] == 'A' and calls[1][2] == 3 and calls[1][3] == 'x',
    'and receives the source and the arguments')

emit('onResourceStop', 'plugin')
env.exported.RegisterAdminEvent('plugin:act', function(src, value)
    calls[#calls + 1] = { 'B', src, value }
end)
emit('plugin:act', 'y')
check(#calls == 2, 'a restart leaves exactly one handler (got ' .. #calls .. ' calls)')
check(calls[2][1] == 'B', 'and it is the new one')

env.admin = false
emit('plugin:act', 'z')
check(#calls == 2, 'a non-admin reaches no admin handler')
env.admin = true
print('PASS serversettings-persist: RegisterAdminEvent handlers leave with their resource ('
    .. checks .. ' checks)')
