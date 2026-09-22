-- Standalone from resource root:
--   bunx --bun fengari tests/lua/engine-actions.lua
--
-- Oracle for tLib's client-side action dispatcher and effect scheduler.
--
-- The claim this suite exists to hold the engine to is the one that made client
-- dispatch safe to open up to every resource: a resource can reach the handlers it
-- registered and nothing else. The pre-split engine got that property for free by
-- having exactly one consumer, allowed to use the feature at all. Now it comes from
-- the owner scoping, so it has to be proven rather than assumed.
--
-- The other half is the effect scheduler, which is the part with real state: an
-- effect outlives the row that started it, so it has to keep ticking, stop on its
-- own when it throws, stop when the permission behind it is revoked, and stop when
-- the resource that registered it goes away. Each of those is a separate way for a
-- god-mode toggle to stay on after the server said no.
--
-- Runs the REAL client/lib/menu/actions.lua against a stub Platform with a hand-pumped
-- scheduler, so every tick boundary is deterministic rather than timing-dependent.


local clock, threads = 0, {}

Platform = {
    now = function() return clock end,
    -- Threads are coroutines the test pumps by hand. The scheduler's whole
    -- behaviour is "sleep exactly as long as the soonest effect needs", and a
    -- stub that ran it inline or on a real timer could not observe that at all.
    createThread = function(fn)
        local co = coroutine.create(fn)
        threads[#threads + 1] = { co = co, wake = clock }
        local ok, err = coroutine.resume(co)
        if not ok then error(err, 0) end
    end,
    wait = function(ms)
        coroutine.yield(ms)
    end,
}

assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('client/lib/menu/actions.lua', 't', _G))()

local M = MenuActions
local logged = {}
M.log = function(message) logged[#logged + 1] = tostring(message) end

--- Advance the clock and resume every scheduler coroutine whose sleep has expired.
local function advance(ms)
    clock = clock + ms
    local live = {}
    for _, thread in ipairs(threads) do
        if coroutine.status(thread.co) == 'suspended' and clock >= thread.wake then
            local ok, delay = coroutine.resume(thread.co)
            if not ok then error(delay, 0) end
            if coroutine.status(thread.co) == 'suspended' then
                thread.wake = clock + (tonumber(delay) or 0)
                live[#live + 1] = thread
            end
        elseif coroutine.status(thread.co) == 'suspended' then
            live[#live + 1] = thread
        end
    end
    threads = live
end

local checks = 0
local function fail(message) error('FAIL: ' .. message, 0) end
local function check(condition, message)
    checks = checks + 1
    if not condition then fail(message) end
end
local function equal(actual, expected, message)
    checks = checks + 1
    if actual ~= expected then
        fail(('%s: expected %s, got %s'):format(message, tostring(expected), tostring(actual)))
    end
end

-- ── Owner isolation ─────────────────────────────────────────────────────────

-- The two owner names are the SAME LENGTH on purpose. Owner scoping is done by
-- stripping an `owner:` prefix, so with names of different lengths a dispatcher
-- that ignored the prefix entirely would strip the wrong number of characters off
-- the other owner's row and miss by accident -- and the test would pass while
-- proving nothing. Verified by mutation: with 'alpha'/'beta' the unscoped variants
-- of decorate and syncPermissions both survive; with 'alpha'/'bravo' both fail.
local calls = {}
local alpha = M.forOwner('alpha')
local bravo = M.forOwner('bravo')

equal(M.forOwner('alpha'), alpha, 'a second request for the same owner returns the same dispatcher')
check(alpha ~= bravo, 'and two owners get two dispatchers')

alpha:register('go', function(value) calls[#calls + 1] = { 'alpha', 'go', value } end)
alpha:register('secret', function() calls[#calls + 1] = { 'alpha', 'secret' } end)
bravo:register('go', function(value) calls[#calls + 1] = { 'bravo', 'go', value } end)

check(M.execute('alpha', 'go', 7), 'alpha dispatches its own handler')
equal(calls[1][1], 'alpha', 'and it was alpha\'s')
equal(calls[1][3], 7, 'with the value the server approved')

check(M.execute('bravo', 'go', 8), 'bravo has a handler of the same name and it is a different one')
equal(calls[2][1], 'bravo', 'and bravo got bravo\'s')

-- The property the whole owner-scoping design exists for: naming another
-- resource's handler does not reach it, even though the name is valid somewhere.
calls = {}
local stolen, stolenErr = M.execute('bravo', 'secret')
equal(stolen, false, 'one resource cannot reach another resource\'s handler by name')
equal(stolenErr, 'Unknown approved action', 'and is refused')
equal(#calls, 0, 'and the handler never ran')

local ghost, ghostErr = M.execute('never_registered', 'go')
equal(ghost, false, 'an unknown owner is refused')
equal(ghostErr, 'Unknown action owner', 'and says so')

-- A handler that throws is reported, not propagated: one broken row must not take
-- down the dispatch path for every other row.
alpha:register('explodes', function() error('boom', 0) end)
local threw, threwErr = M.execute('alpha', 'explodes')
equal(threw, false, 'a throwing handler reports failure')
equal(threwErr, 'boom', 'and the message reaches the caller')

-- ── Autosave ────────────────────────────────────────────────────────────────

local persisted = {}
alpha:onPersist(function(name) persisted[#persisted + 1] = name end)
alpha:onPersist(function() error('storage is full', 0) end)
logged = {}
check(M.execute('alpha', 'go', 1), 'an action with persisters still succeeds')
equal(#persisted, 1, 'and the persister ran once, with the action name')
equal(persisted[1], 'go', 'and was told which action changed')
equal(#logged, 1, 'a failing persister is logged')
check(logged[1]:find('autosave failed for go', 1, true) ~= nil, 'and names the action it could not save')

-- A rejected change must not be written. Persisting on failure would hand the
-- player a stored preference the server never accepted.
persisted = {}
M.execute('alpha', 'explodes')
equal(#persisted, 0, 'a failed action is never persisted')

-- ── Local state and the snapshot ────────────────────────────────────────────

local published = {}
alpha:bindPublisher(function(name, patch) published[#published + 1] = { name = name, patch = patch } end)

alpha:state('go', 42)
equal(alpha:state('go'), 42, 'stored state reads back')
alpha:publish('go', { value = 99, rightLabel = 'Ninety-nine' })
equal(alpha:state('go'), 99, 'publishing updates the stored value')
equal(#published, 1, 'and reaches the bound publisher exactly once')
equal(published[1].patch.rightLabel, 'Ninety-nine', 'with the whole patch')

local snapshot = { menus = {
    { id = 'alpha:page', items = {
        { id = 'alpha:go', kind = 'slider', min = 0, max = 100, step = 1, value = 0 },
        { id = 'alpha:other', kind = 'toggle', value = false },
    } },
    { id = 'bravo:page', items = {
        { id = 'bravo:go', kind = 'slider', min = 0, max = 100, step = 1, value = 0 },
    } },
} }
alpha:decorate(snapshot)
equal(snapshot.menus[1].items[1].value, 99, 'decorate replays alpha\'s stored value onto alpha\'s row')
equal(snapshot.menus[1].items[1].rightLabel, 'Ninety-nine', 'including non-value fields')
equal(snapshot.menus[2].items[1].value, 0, 'and leaves an identically-named row of another owner alone')

-- A stored value the row can no longer accept is dropped rather than forced: the
-- row's bounds may have changed since the player last set it.
alpha:publish('other', { value = 1000 })
alpha:decorate(snapshot)
equal(snapshot.menus[1].items[2].value, false, 'a stored value the row rejects is not applied')

-- ── The effect scheduler ────────────────────────────────────────────────────

local ticks = { alphaGod = 0, bravoGod = 0 }
published = {}
alpha:setEffect('god', true, { interval = 100, tick = function() ticks.alphaGod = ticks.alphaGod + 1 end })
equal(ticks.alphaGod, 1, 'enabling an effect ticks it immediately')
equal(#published, 1, 'and publishes the row state')
equal(published[1].patch.value, true, 'as on')
check(alpha:hasEffects(), 'and the dispatcher reports an effect running')
check(M.anyEffects(), 'as does the scheduler')

advance(50)
equal(ticks.alphaGod, 1, 'the effect does not tick before its interval elapses')
advance(60)
equal(ticks.alphaGod, 2, 'and ticks once the interval elapses')
advance(100)
equal(ticks.alphaGod, 3, 'and again on the next interval')

-- Two owners may register the same effect name; they are separate effects.
bravo:setEffect('god', true, { interval = 100, tick = function() ticks.bravoGod = ticks.bravoGod + 1 end })
equal(ticks.bravoGod, 1, 'a second owner registers an effect of the same name')
advance(100)
equal(ticks.alphaGod, 4, 'and both tick')
equal(ticks.bravoGod, 2, 'independently')

-- Faster effects must not be starved by a scheduler already asleep for a slower
-- one. This is what the generation counter is for.
local fast = 0
alpha:setEffect('fast', true, { interval = 10, tick = function() fast = fast + 1 end })
equal(fast, 1, 'a fast effect ticks on registration')
advance(12)
equal(fast, 2, 'and is not made to wait for the slower effect already scheduled')

alpha:setEffect('fast', false)
advance(20)
equal(fast, 2, 'a disabled effect stops ticking')

-- ── Effects stop themselves when they break ─────────────────────────────────

local stopped = {}
alpha:setEffect('cleanly', true, {
    interval = 100,
    tick = function() end,
    stop = function() stopped[#stopped + 1] = 'cleanly' end,
})
alpha:setEffect('cleanly', false)
equal(#stopped, 1, 'disabling an effect runs its stop hook')

logged = {}
local flaky = 0
alpha:setEffect('flaky', true, { interval = 50, tick = function()
    flaky = flaky + 1
    if flaky > 1 then error('lost the ped', 0) end
end })
equal(flaky, 1, 'a flaky effect starts')
advance(60)
equal(flaky, 2, 'and throws on its second tick')
advance(200)
equal(flaky, 2, 'after which it is no longer scheduled')
check(#logged >= 1 and logged[1]:find('lost the ped', 1, true) ~= nil, 'and the failure was logged')
check(not published[#published].patch.value, 'and the row was published back as off')

-- A first tick that throws leaves nothing behind at all.
local never = 0
local ok = pcall(function()
    alpha:setEffect('doomed', true, { interval = 50, tick = function() never = never + 1; error('no', 0) end })
end)
equal(ok, false, 'an effect whose very first tick throws fails loudly')
equal(never, 1, 'having tried exactly once')
advance(200)
equal(never, 1, 'and is never scheduled')

-- ── Revocation ──────────────────────────────────────────────────────────────

equal(ticks.alphaGod > 0 and alpha:hasEffects(), true, 'alpha still has its effect running')

-- The direct answer from the server: anything not explicitly allowed is stopped.
alpha:applyPermissions({ god = true }, { 'god' })
check(alpha:hasEffects(), 'an effect the server still allows keeps running')
alpha:applyPermissions({}, { 'god' })
check(not alpha:hasEffects(), 'an effect the server no longer allows is stopped')
check(bravo:hasEffects(), 'and another owner\'s effect is untouched')

-- A malformed answer must fail closed rather than be read as a grant.
local bravoTicks = ticks.bravoGod
bravo:applyPermissions(nil, { 'god' })
check(not bravo:hasEffects(), 'a malformed permission answer stops the effect rather than being trusted')
advance(500)
equal(ticks.bravoGod, bravoTicks, 'and it really stopped ticking')

-- The indirect answer: the row vanished from the snapshot entirely.
alpha:setEffect('god', true, { interval = 100, tick = function() ticks.alphaGod = ticks.alphaGod + 1 end })
alpha:syncPermissions({ menus = { { id = 'alpha:page', items = {
    { id = 'alpha:god', kind = 'toggle', value = true },
} } } })
check(alpha:hasEffects(), 'an effect whose row is still in the snapshot keeps running')
alpha:syncPermissions({ menus = { { id = 'alpha:page', items = {
    { id = 'alpha:god', kind = 'toggle', value = true, disabled = true },
} } } })
check(not alpha:hasEffects(), 'an effect whose row came back disabled is stopped')

-- A row belonging to another owner cannot keep an effect alive, and cannot kill
-- one either -- the prefix match is what makes syncPermissions owner-scoped.
bravo:setEffect('god', true, { interval = 100, tick = function() end })
bravo:syncPermissions({ menus = { { id = 'alpha:page', items = {
    { id = 'alpha:god', kind = 'toggle', value = true },
} } } })
check(not bravo:hasEffects(), 'another owner\'s row does not keep bravo\'s effect alive')

-- ── Resource teardown ───────────────────────────────────────────────────────

local order = {}
alpha:onCleanup(function() order[#order + 1] = 'first' end)
alpha:onCleanup(function() order[#order + 1] = 'second' end)
alpha:onCleanup(function() error('cleanup exploded', 0) end)
local teardownTicks = 0
alpha:setEffect('lingering', true, { interval = 50, tick = function() teardownTicks = teardownTicks + 1 end })

logged = {}
check(M.dropOwner('alpha'), 'dropping an owner reports that it existed')
equal(M.get('alpha'), nil, 'and the dispatcher is gone')
advance(500)
equal(teardownTicks, 1, 'its effect stopped ticking with it')
-- Reverse order, because a cleanup registered later may depend on state a
-- cleanup registered earlier is about to tear down.
equal(order[1], 'second', 'cleanups run in reverse registration order')
equal(order[2], 'first', 'innermost last')
check(#logged >= 1 and logged[1]:find('module cleanup failed', 1, true) ~= nil,
    'and a throwing cleanup is logged rather than stopping the rest')
equal(M.dropOwner('alpha'), false, 'dropping it again is a no-op')

-- A dropped owner's name is free to be registered again, and starts empty --
-- otherwise a resource restart would inherit its own stale handlers.
local restarted = M.forOwner('alpha')
check(restarted ~= alpha, 'restarting a resource gets a fresh dispatcher')
local reGhost, reGhostErr = M.execute('alpha', 'go')
equal(reGhost, false, 'and none of the old handlers survived')
equal(reGhostErr, 'Unknown approved action', 'the restarted namespace is empty')

M.cleanupAll()
check(not M.anyEffects(), 'cleanupAll leaves no effect running')
equal(M.get('bravo'), nil, 'and no dispatcher registered')
advance(1000)

-- ── The item resolver ───────────────────────────────────────────────────────
--
-- Publishing a boolean onto a list row would overwrite whichever option the
-- player had selected, so the engine tells the dispatcher what kind of row an
-- effect belongs to.
local gamma = M.forOwner('gamma')
published = {}
gamma:bindPublisher(function(name, patch) published[#published + 1] = { name = name, patch = patch } end)
M.setItemResolver(function(owner, name)
    if owner == 'gamma' and name == 'listy' then return { kind = 'select' } end
    return { kind = 'toggle' }
end)
gamma:setEffect('togglish', true, { interval = 1000, tick = function() end })
equal(#published, 1, 'a toggle-backed effect publishes its state')
gamma:setEffect('listy', true, { interval = 1000, tick = function() end })
equal(#published, 1, 'a list-backed effect does not, so the selected option survives')
M.cleanupAll()

print(('PASS engine actions: %d checks, owner isolation / autosave / snapshot replay / scheduler / revocation / teardown')
    :format(checks))
