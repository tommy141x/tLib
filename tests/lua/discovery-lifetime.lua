-- Discovery instances must stop answering when their owner goes away.
--
-- Discovery.create is reached across an export boundary, so every handler it
-- registers lives in tLib's resource state rather than the consumer's. Before
-- disposal existed, a consumer restart added a second set of handlers over a
-- freshly loaded config table while the first set stayed live over the table it
-- had loaded whenever tLib last started -- both answered config_request, the
-- client kept whichever reply arrived last, and an edit that was correct on
-- disk and correctly loaded could still never reach a client. Restarting the
-- consumer again made it worse, not better.
--
-- These are the oracles for the fix: a re-create disposes the previous
-- instance, an owner stop disposes it, and a disposed instance is both
-- unregistered AND silent (RemoveEventHandler is not guaranteed everywhere, so
-- the flag has to hold on its own).
local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

-- ── host ────────────────────────────────────────────────────────────
local env = setmetatable({}, { __index = _G })
env._G = env
env._TLIB_IS_FIVEM = true
env.handlers = {}   -- [event] = { {fn=, live=true}, … }
env.nextCookie = 0

env.AddEventHandler = function(name, fn)
    env.nextCookie = env.nextCookie + 1
    local entry = { fn = fn, live = true, cookie = env.nextCookie, event = name }
    env.handlers[name] = env.handlers[name] or {}
    table.insert(env.handlers[name], entry)
    return entry
end
env.RemoveEventHandler = function(entry)
    if type(entry) ~= 'table' then error('RemoveEventHandler got a non-cookie') end
    entry.live = false
end
env.RegisterNetEvent = function() end

-- The clock behind Platform.now(), which discovery/server.lua's per-player rate
-- limit on config_request reads. It jumps a long way on every call so that no
-- emit in this suite is ever the one that gets throttled: what is under test
-- here is instance lifetime, and a rate limiter silently eating a reply would
-- look exactly like the stale-instance bug the suite exists to catch.
local clock = 0
env.GetGameTimer = function()
    clock = clock + 10000
    return clock
end

--- Fire an event at every handler still registered for it, and count the ones
--- that actually did something. A handler that was removed must never run; a
--- handler that ran but returned early is counted separately, because the two
--- failure modes are different and only one of them is survivable.
local function emit(name, ...)
    local ran = 0
    for _, entry in ipairs(env.handlers[name] or {}) do
        if entry.live then
            ran = ran + 1
            entry.fn(...)
        end
    end
    return ran
end
local function liveCount(name)
    local n = 0
    for _, entry in ipairs(env.handlers[name] or {}) do
        if entry.live then n = n + 1 end
    end
    return n
end

env.replies = {}
env.TriggerEvent = function() end
env.TriggerClientEvent = function(name, target, payload)
    env.replies[#env.replies + 1] = { event = name, target = target, payload = payload }
end
env.TriggerServerEvent = function() end

-- Files: only the owner's local data file exists, and its contents are swapped
-- between the two creates to stand in for an edit made on disk.
env.localFile = '{"vehicles":{"car":{"siren":{"maxHz":745}}}}'
env.LoadResourceFile = function(resource, path)
    if resource == 'consumer' and path == 'data.json' then return env.localFile end
    return nil
end
env.SaveResourceFile = function() return true end
env.GetResourceMetadata = function() return nil end
env.GetNumResources = function() return 0 end
env.GetResourceByFindIndex = function() return nil end
env.GetResourceState = function() return 'started' end
env.GetHashKey = function(s) return #tostring(s) end
env.GetInvokingResource = function() return 'consumer' end
env.GetCurrentResourceName = function() return 'tLib' end
env.exports = setmetatable({}, { __index = function() return setmetatable({}, {
    __index = function() return function() return false end end,
}) end })
-- Capturing rather than discarding: skipAutoBroadcast's whole point is that it
-- must NOT fail silently, so the log line is part of the contract under test.
env.logs = {}
env.Logger = { create = function()
    return function(message) env.logs[#env.logs + 1] = tostring(message) end
end }
env.Permission = { isPlayerAdmin = function() return true end }
env.json = {
    encode = function() return '{}' end,
    decode = function(raw)
        -- Enough of a decoder for the two fixtures this suite uses: the point
        -- here is instance lifetime, not JSON.
        local maxHz = tonumber(raw:match('"maxHz":(%d+)'))
        if not maxHz then return {} end
        return { vehicles = { car = { siren = { maxHz = maxHz } } } }
    end,
}
env.Platform = { _stub = function(name) return function() error(name .. ' is stubbed') end end }
env.source = 7

local function run(path)
    return assert(loadfile(path, 't', env))()
end
run('shared/lib/adapter/events.lua')
-- discovery/server.lua frees its per-player rate-limit state through
-- Platform.onPlayerDropped, which lives here rather than in events.lua. Loading
-- the real adapter instead of stubbing the one function: every branch in it is
-- already guarded on _TLIB_IS_FIVEM, so off-FiveM it registers the callback into
-- a plain table and touches no host native.
run('shared/lib/adapter/lifecycle.lua')
run('server/sv_discovery.lua')

local function create()
    return env.Discovery.create({
        metadataKey = 'demo_config',
        defaultFileName = 'demo.json',
        localFile = 'data.json',
        localSection = 'vehicles',
        resourceName = 'consumer',
        eventPrefix = 'demo',
        skipAutoSave = true,
    })
end

-- ── a consumer restart must not leave the old instance answering ────
local first = create()
check(liveCount('demo:config_request') == 1, 'the first instance registers one request handler')
env.replies = {}
check(emit('demo:config_request') == 1, 'it answers while it is the only instance')
check(env.replies[1].payload.car.siren.maxHz == 745, 'and answers with what it loaded')

-- The edit on disk that the old instance can never see.
env.localFile = '{"vehicles":{"car":{"siren":{"maxHz":1200}}}}'

local second = create()
check(first:isDisposed(), 'creating a second instance for the same owner disposes the first')
check(not second:isDisposed(), 'the new instance is live')
check(liveCount('demo:config_request') == 1, 'exactly one request handler is left registered')

env.replies = {}
check(emit('demo:config_request') == 1, 'one handler answers')
check(#env.replies == 1, 'a request draws exactly one reply, not one per past create')
check(env.replies[1].payload.car.siren.maxHz == 1200,
    'the reply is the config on disk now, not the one the disposed instance is holding')
print('PASS discovery-lifetime: a consumer restart replaces its Discovery instead of stacking one')

-- ── disposal survives a host with no working RemoveEventHandler ─────
-- The flag has to carry this on its own: an unremovable handler must go quiet.
local third = create()
check(second:isDisposed(), 'the previous instance is disposed again')
for _, entry in ipairs(env.handlers['demo:config_request']) do entry.live = true end -- unremove them all
env.replies = {}
local ran = emit('demo:config_request')
check(ran == 3, 'all three handlers are reachable in this scenario')
check(#env.replies == 1, 'but only the undisposed one replies')
check(env.replies[1].payload.car.siren.maxHz == 1200, 'and it is the live instance that replied')
print('PASS discovery-lifetime: a disposed instance stays silent even if it cannot be unregistered')

-- ── the owner stopping disposes it ──────────────────────────────────
for _, entry in ipairs(env.handlers['demo:config_request']) do entry.live = false end
local fourth = create()
check(third:isDisposed(), 'previous disposed on re-create')
check(not fourth:isDisposed(), 'the new one is live before the stop')
emit('onResourceStop', 'somebody_else')
check(not fourth:isDisposed(), 'another resource stopping is not its business')
emit('onResourceStop', 'consumer')
check(fourth:isDisposed(), 'the owner stopping disposes it')
env.replies = {}
emit('demo:config_request')
check(#env.replies == 0, 'and nothing answers for a consumer that is not running')
print('PASS discovery-lifetime: the owner stopping disposes its Discovery')

-- ── dispose is idempotent ───────────────────────────────────────────
fourth:dispose()
fourth:dispose()
emit('onResourceStop', 'consumer')
check(fourth:isDisposed(), 'still disposed, and disposing twice is not an error')
print('PASS discovery-lifetime: dispose is idempotent (' .. checks .. ' checks)')

-- ── skipAutoBroadcast: the owner takes over delivery ────────────────
-- The delivery counterpart of skipAutoSave, and tested beside it for the same
-- reason: both hand a responsibility to the owning resource, and both fail as
-- silence rather than as an error if the owner does not pick it up.
local function createWith(extra)
    local o = {
        metadataKey = 'demo_config',
        defaultFileName = 'demo.json',
        localFile = 'data.json',
        localSection = 'vehicles',
        resourceName = 'consumer',
        eventPrefix = 'demo',
        skipAutoSave = true,
        permissionCheck = function() return true end,
    }
    for k, v in pairs(extra or {}) do o[k] = v end
    return env.Discovery.create(o)
end

env.source = 1

-- Default off: every existing caller must keep the behaviour it has. This is
-- the assertion that proves the option is additive rather than a silent
-- behaviour change for tRadio, tRadar and anything else on Discovery.
local onByDefault = createWith(nil)
check(not onByDefault:isDisposed(), 'the default-off instance is live')
env.replies = {}
emit('demo:config_request')
check(#env.replies == 1, 'default: config_request is answered')
env.replies = {}
emit('demo:config_save', 'car', { siren = { maxHz = 900 } })
check(#env.replies == 1, 'default: a save still broadcasts')
check(env.replies[1].target == -1, 'default: and it broadcasts to everyone')

-- On: all three paths go quiet.
env.logs = {}
local skipping = createWith({ skipAutoBroadcast = true })
check(onByDefault:isDisposed(), 'creating the skipping instance disposed the default one')
env.replies = {}
emit('demo:config_request')
check(#env.replies == 0, 'skipAutoBroadcast: config_request is not answered by tLib')
env.replies = {}
emit('demo:config_save', 'car', { siren = { maxHz = 950 } })
check(#env.replies == 0, 'skipAutoBroadcast: a save does not broadcast')
env.replies = {}
emit('demo:config_remove', 'car')
check(#env.replies == 0, 'skipAutoBroadcast: a remove does not broadcast')

-- The drop is observable. An owner who sets the option and then forgets to
-- answer config_request would otherwise get clients that receive nothing,
-- forever, with nothing in the console to say why.
local sawRequestNotice = false
for _, line in ipairs(env.logs) do
    if line:find('skipAutoBroadcast', 1, true)
        and line:find('config_request', 1, true)
        and line:find('consumer', 1, true) then
        sawRequestNotice = true
    end
end
check(sawRequestNotice,
    'skipAutoBroadcast: the config_request drop is logged, naming the resource that owes the reply')

-- Once per instance, not once per call: on a full server the request path is
-- one line per player per second, which would bury the line above.
local before = #env.logs
for _ = 1, 5 do emit('demo:config_request') end
local requestNotices = 0
for i = before + 1, #env.logs do
    if env.logs[i]:find('config_request', 1, true) then requestNotices = requestNotices + 1 end
end
check(requestNotices == 0, 'skipAutoBroadcast: the drop is announced once, not once per request')

-- The third guard: the auto-broadcast inside the onResourceStart handler, which
-- fires when ANOTHER resource starts and contributes configs. Reaching it needs
-- `receiveEvent` set AND a provider resource to exist — and the shared stubs
-- above report zero resources, so without this setup the option would look
-- fully covered while one of its three paths never executed once.
skipping:dispose()

local baseLoad = env.LoadResourceFile
env.GetResourceMetadata = function(resource, key)
    if resource == 'provider' and key == 'demo_config' then return 'provided.json' end
    return nil
end
env.LoadResourceFile = function(resource, path)
    if resource == 'provider' and path == 'provided.json' then
        -- A model the consumer does not already hold, so `count > 0` holds.
        return '{"van":{"siren":{"maxHz":600}}}'
    end
    return baseLoad(resource, path)
end

local scanDefault = createWith({ receiveEvent = 'demo:config_receive' })
env.replies = {}
emit('onResourceStart', 'provider')
local sawScan = false
for _, r in ipairs(env.replies) do
    if r.event == 'demo:config_receive' and r.target == -1 then sawScan = true end
end
check(sawScan, 'default: a provider starting broadcasts the configs it contributed')
scanDefault:dispose()

local scanSkipping = createWith({ receiveEvent = 'demo:config_receive', skipAutoBroadcast = true })
env.replies = {}
emit('onResourceStart', 'provider')
local sawSkipped = false
for _, r in ipairs(env.replies) do
    if r.event == 'demo:config_receive' then sawSkipped = true end
end
check(not sawSkipped, 'skipAutoBroadcast: a provider starting does not broadcast')
scanSkipping:dispose()

env.GetResourceMetadata = function() return nil end
env.LoadResourceFile = baseLoad

print('PASS discovery-lifetime: skipAutoBroadcast suppresses delivery and says so (' .. checks .. ' checks)')
