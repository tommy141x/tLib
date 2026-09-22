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
env.Logger = { create = function() return function() end end }
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
