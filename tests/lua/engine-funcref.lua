-- Standalone from resource root:
--   bunx --bun --package fengari-node-cli fengari tests/lua/engine-funcref.lua
--
-- Oracle for the one thing a consumer hands the engine that is not data: a
-- callback.
--
-- A FUNCTION DOES NOT ARRIVE AS A FUNCTION. When a resource registers a handler,
-- hook, presenter, provider or effect through one of this library's exports, the
-- host serializes it: citizen/scripting/lua/scheduler.lua:537-624 packs a function
-- as msgpack ext type 10 (`EXT_FUNCREF`) and unpacks it as a TABLE holding
-- `__cfx_functionReference`, callable only through `funcref_mt.__call`. `type()`
-- answers 'table'. Indexing it raises 'Cannot index a funcref'.
--
-- So `type(x) == 'function'` is the wrong test on the receiving side of every
-- export, and it is wrong in a way no in-process suite can see: a test host that
-- calls the export as a plain Lua function never packs anything. That is exactly
-- how a full green suite run coexisted with a boot that refused every consumer
-- callback it was handed. This suite exists so that class of gate can never
-- silently come back: it feeds a funcref-shaped value into each engine-side gate
-- and requires acceptance, while still requiring refusal of a table that is not
-- callable at all -- a plain data table is a mistake, not a funcref.
--
-- client/cl_menu.lua and server/sv_menu.lua have the same gates and are not
-- driven here, because they need a host rather than a dependency table; their
-- boundary is asserted by the consumer-side harnesses, which marshal arguments
-- through a simulated export call.


-- A funcref, shaped as the host builds one
--
-- The target is held outside the table so its shape matches the real one exactly:
-- one opaque string key, and a metatable that refuses to be read through.
local targets = setmetatable({}, { __mode = 'k' })
local funcref_mt
funcref_mt = {
    __index = function() error('Cannot index a funcref', 2) end,
    __newindex = function() error('Cannot set indexes on a funcref', 2) end,
    __call = function(self, ...) return targets[self](...) end,
}
local serial = 0
local function funcref(fn)
    serial = serial + 1
    local ref = setmetatable({ __cfx_functionReference = ('test:%d'):format(serial) }, funcref_mt)
    targets[ref] = fn
    return ref
end

-- context.lua and actions.lua are client-side files and return immediately on any
-- other side. The registry is shared, so declaring the client side here drives all
-- four in one state.
_TLIB_SIDE = 'client'

local clock = 0
Platform = {
    now = function() return clock end,
    -- The effect scheduler is an endless loop that sleeps between passes, so it
    -- has to run as a coroutine that parks on its first wait. Running it inline
    -- against a wait that returns would hang this suite forever, and time never
    -- advances here anyway: engine-actions.lua owns the scheduling oracle, and
    -- what this one needs from an effect is only its first tick.
    createThread = function(fn)
        local co = coroutine.create(fn)
        local ok, err = coroutine.resume(co)
        if not ok then error(err, 0) end
    end,
    wait = function(ms) return coroutine.yield(ms) end,
}

assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('server/lib/menu/registry.lua', 't', _G))()
assert(loadfile('client/lib/menu/context.lua', 't', _G))()
assert(loadfile('client/lib/menu/actions.lua', 't', _G))()

local S = MenuSchema
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

-- The simulation is itself worth pinning
--
-- If this drifted into being an ordinary function, every assertion below would
-- keep passing while testing nothing.

local probe = funcref(function(a, b) return (a or 0) + (b or 0), 'ok' end)
equal(type(probe), 'table', 'a funcref is a table, not a function')
check(not pcall(function() return probe.field end), 'reading a field off a funcref raises')
check(not pcall(function() probe.field = 1 end), 'writing a field onto a funcref raises')
local sum, word = probe(2, 3)
equal(sum, 5, 'a funcref is callable through its metatable')
equal(word, 'ok', 'a funcref returns every value its target returned')

-- S.callable, the single answer every gate asks

check(S.callable(function() end), 'a plain function is callable')
check(S.callable(probe), 'a funcref is callable')
check(not S.callable({}), 'an empty table is not callable')
check(not S.callable({ __cfx_functionReference = 'test:0' }), 'the reference field alone is not callable')
check(not S.callable(nil), 'nil is not callable')
check(not S.callable('tick'), 'a string is not callable')
check(not S.callable(7), 'a number is not callable')
check(S.callable(setmetatable({}, { __call = function() end })), 'any __call metamethod is callable')
check(not S.callable(setmetatable({}, { __index = function() end })), '__index alone is not callable')
-- A protected metatable must not be mistaken for a callable one, and must not
-- make the check itself throw.
check(not S.callable(setmetatable({}, { __metatable = 'locked' })),
    'a protected metatable reads as not callable rather than raising')

-- The rule that comes with holding funcrefs: they are held by reference, never
-- copied. A copy is a plain table carrying the reference id and no metatable,
-- which is a silently dead handler -- it would pass no gate and call nothing.
local copied = S.copy({ handler = probe })
equal(type(copied.handler), 'table', 'a copied funcref is still a table')
check(not S.callable(copied.handler), 'a COPIED funcref is dead -- handlers must be held by reference')

-- Client action handlers and effects

MenuActions.setItemResolver(function() return nil end)
local dispatcher = MenuActions.forOwner('consumer')

local ran = {}
dispatcher:register('heal', funcref(function(value) ran[#ran + 1] = { 'heal', value }; return true end))
check(dispatcher:has('heal'), 'a handler arriving as a funcref registers')
equal(select(1, dispatcher:execute('heal', 42)), true, 'a funcref handler dispatches')
equal(ran[1][2], 42, 'the dispatched value reaches the funcref handler')

check(not pcall(function() dispatcher:register('data', { value = 1 }) end),
    'a plain data table is still refused as a handler')
check(not pcall(function() dispatcher:register('missing', nil) end), 'nil is still refused as a handler')

local ticks = 0
dispatcher:setEffect('godmode', true, { tick = funcref(function() ticks = ticks + 1 end), interval = 100 })
equal(ticks, 1, 'an effect whose tick is a funcref runs its first tick')
check(not pcall(function() dispatcher:setEffect('broken', true, { tick = { 1, 2 } }) end),
    'an effect whose tick is a plain table is still refused')
dispatcher:setEffect('godmode', false)

-- Presenters

local ok, reason = MenuContext.register('consumer', {
    identity = funcref(function() return 'consumer:1' end),
    present = funcref(function(value) return value end),
    expand = funcref(function() end),
    contextKey = funcref(function() return nil end),
    invalidate = funcref(function() end),
})
check(ok, 'a presenter whose every field is a funcref registers: ' .. tostring(reason))
local bad, badReason = MenuContext.register('consumer2', { present = { rows = {} } })
check(not bad, 'a presenter field that is a plain table is still refused')
equal(badReason, 'presenter.present must be a function', 'the refusal names the field')
MenuContext.unregister('consumer')

-- Snapshot hooks and server action handlers

local registry = MenuRegistry.new({ hasPermission = function() return true end, now = function() return clock end })
check(registry:defineNamespace('consumer', { ace = 'consumer.open' }), 'the namespace is defined')

check(registry:onSnapshot('consumer', funcref(function() end)), 'a snapshot hook arriving as a funcref registers')
local hookOk, hookReason = registry:onSnapshot('consumer', { rebuild = true })
check(not hookOk, 'a plain table is still refused as a snapshot hook')
equal(hookReason, 'Unknown namespace or invalid hook', 'the hook refusal is unchanged')

local menu = {
    id = 'consumer:main', title = 'Consumer',
    items = { { id = 'consumer:heal', label = 'Heal', kind = 'action' } },
}
local menuOk, menuReason = registry:register('consumer', menu,
    { ace = 'consumer.open', actions = { ['consumer:heal'] = { ace = 'consumer.heal', run = funcref(function() return true end) } } })
check(menuOk, 'a menu whose server handler arrives as a funcref registers: ' .. tostring(menuReason))

local noRun, noRunReason = registry:register('consumer', { id = 'consumer:other', title = 'Other',
    items = { { id = 'consumer:other:act', label = 'Act', kind = 'action' } } },
    { ace = 'consumer.open', actions = { ['consumer:other:act'] = { ace = 'consumer.act', run = { server = true } } } })
check(not noRun, 'an action whose run is a plain table is still refused')
equal(noRunReason, 'Every action requires a server handler or a client action',
    'the refusal is the same sentence the fatal boot error printed')

-- And the handler the registry kept is the funcref itself, not a copy of it: a
-- resolved action is called, so a dead copy here would refuse silently at the
-- moment a player pressed the row rather than at registration.
local resolvedEntry, resolvedItem, resolvedAction = registry:resolveAction(1, 'consumer:main', 'consumer:heal', nil)
check(resolvedEntry and resolvedItem, 'the row resolves for a permitted player')
check(resolvedAction and S.callable(resolvedAction.run), 'the stored run handler is still callable after resolution')
equal(resolvedAction.run(), true, 'the stored run handler calls through')

print(('PASS: %d funcref boundary assertions across schema, actions, context and registry'):format(checks))
