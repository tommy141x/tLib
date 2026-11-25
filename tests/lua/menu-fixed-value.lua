-- A client-dispatched action's `fixedValue` is what the client is handed, whatever it sent.
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/menu-fixed-value.lua

local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

function GetGameTimer() return 0 end
function AddEventHandler() end
function GetCurrentResourceName() return 'tLib' end

_TLIB_SIDE = 'server'
Logger = { create = function() return function() end end }
Permission = { pushAll = function() return 0 end }

local RateLimit = assert(loadfile('shared/imports/ratelimit/server.lua', 't', _G))()
local handlers, sent = {}, {}
Platform = setmetatable({
    now = function() return 0 end,
    AddNetEventHandler = function(name, fn) handlers[name] = fn end,
    TriggerClientEvent = function(_, src, requestId, payload) sent[#sent + 1] = { src = src, id = requestId, p = payload } end,
    rateTokens = function(name, opts) return RateLimit.tokens(name, opts) end,
    hasPermission = function() return true end,
    getInvokingResource = function() return nil end,
    isStudioResource = function() return false end,
}, { __index = function() return function() end end })

for _, file in ipairs({ 'shared/lib/menu/schema.lua', 'server/lib/menu/registry.lua', 'server/sv_menu.lua' }) do
    assert(loadfile(file, 't', _G))()
end

local registry = MenuEngine.registry
assert(registry:defineNamespace('alpha', { ace = 'alpha.use' }))
assert(registry:register('alpha', {
    id = 'alpha:main',
    title = 'Alpha',
    items = {
        { id = 'alpha:off', label = 'Switch off', kind = 'toggle', value = true },
        { id = 'alpha:preset', label = 'Preset', kind = 'toggle', value = false },
        { id = 'alpha:free', label = 'Free', kind = 'toggle', value = false },
    },
}, {
    ace = 'alpha.use',
    actions = {
        ['alpha:off'] = { ace = 'alpha.use', clientAction = 'set', fixedValue = false },
        ['alpha:preset'] = { ace = 'alpha.use', clientAction = 'set', fixedValue = 'low' },
        ['alpha:free'] = { ace = 'alpha.use', clientAction = 'set' },
    },
}))

local request = assert(handlers[MenuSchema.events.request], 'sv_menu registered no request handler')
local function dispatch(itemId, value)
    source = 5
    request('req-' .. #sent, { kind = 'action', menuId = 'alpha:main', itemId = itemId, value = value })
    source = nil
    return sent[#sent].p
end

-- `false` is the case `fixedValue or body.value` got wrong: it fell through to what the
-- client sent, so a row meant to always switch something off switched it on.
local off = dispatch('alpha:off', true)
check(off.ok == true and off.clientAction == 'set', 'the row dispatches to its client action')
check(off.value == false, 'a fixed value of false is handed over, not the true the client sent: '
    .. tostring(off.value))

check(dispatch('alpha:preset', true).value == 'low', 'a truthy fixed value still replaces what the client sent')
check(dispatch('alpha:free', true).value == true, 'a row with no fixed value hands over what the client sent')
check(dispatch('alpha:free', false).value == false, 'including a false the client sent')

print(('PASS menu-fixed-value (%d checks)'):format(checks))
