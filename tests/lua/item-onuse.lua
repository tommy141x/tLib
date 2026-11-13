-- tlib.item.onUse against fake inventories.
--
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/item-onuse.lua
--
-- What is asserted is the outcome a resource cares about: using the item on
-- THIS server's inventory runs the handler, once, for the right player. Each
-- inventory is a fake that only exposes the registration surface the real one
-- does, so a strategy that registered against the wrong name would see nothing.

local report = print
local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

local now, states, versions, events, printed, exportsByResource


function GetCurrentResourceName() return 'consumer' end
function GetGameTimer() return now end
function GetResourceState(name) return states[name] or 'missing' end
function GetResourceMetadata(name, key) if key == 'version' then return versions[name] end end
function AddEventHandler(name, fn) events[name] = events[name] or {}; table.insert(events[name], fn) end
function print(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    printed[#printed + 1] = table.concat(parts, ' ')
end

--- exports.resource:method(...) is exports.resource.method(exports.resource, ...).
--- A method the fake does not define raises the host's own message.
exports = setmetatable({}, { __index = function(_, resource)
    local methods = exportsByResource[resource]
    if not methods then error('No such export ' .. resource, 0) end
    local proxy = {}
    return setmetatable(proxy, { __index = function(_, name)
        local fn = methods[name]
        if not fn then
            return function() error(('No such export %s in resource %s'):format(name, resource), 0) end
        end
        return fn
    end })
end })

local function emit(name, ...)
    for _, fn in ipairs(events[name] or {}) do fn(...) end
end

local function fresh()
    now, states, versions, events, printed, exportsByResource = 0, {}, {}, {}, {}, {}
    _G.source = nil
    return assert(loadfile('shared/imports/item/server.lua', 't', _G))()
end

local function printedContains(text)
    for _, line in ipairs(printed) do if line:find(text, 1, true) then return true end end
    return false
end

--- A recorder for what the handler saw.
local function recorder()
    local uses = {}
    return uses, function(src, info) uses[#uses + 1] = { src = src, item = info.item, via = info.via } end
end

-- ox_inventory

do
    local Item = fresh()
    local hooks = {}
    states.ox_inventory, versions.ox_inventory = 'started', '2.44.1'
    exportsByResource.ox_inventory = {
        registerHook = function(_, event, fn, filter) hooks[#hooks + 1] = { event = event, fn = fn, filter = filter } return 1 end,
    }
    local uses, handler = recorder()
    Item.onUse('radio', handler)

    check(#hooks == 1 and hooks[1].event == 'usingItem', 'the usingItem hook is registered')
    check(hooks[1].filter.itemFilter.radio == true, 'and filtered to the item')

    local cancelled = hooks[1].fn({ source = 5 })
    check(#uses == 1 and uses[1].src == 5 and uses[1].item == 'radio', 'using the item runs the handler for that player')
    check(uses[1].via == 'ox_inventory:usingItem', 'and says how it arrived')
    check(cancelled == false, 'the hook cancels ox\'s own use by default')

    local status = Item.status('radio')
    check(status.proven == true, 'a registered hook is proof it will fire')
    check(#status.strategies == 2, 'the hook and the event path are both listed')

    now = 1000
    emit('ox_inventory:usedItem', 6, 'radio')
    check(#uses == 2 and uses[2].src == 6 and uses[2].via == 'ox_inventory:usedItem', 'the usedItem event also runs it')
    emit('ox_inventory:usedItem', 6, 'bread')
    check(#uses == 2, 'an item nobody registered is ignored')

    now = 2000
    Item.onUse('radio', handler, { consume = true })
    check(#hooks == 1, 'registering the same item again does not stack a second hook')
    check(hooks[1].fn({ source = 7 }) == nil, 'consume = true lets ox consume the item')
end
report('PASS ox_inventory: the hook and the usedItem event both run the handler')

do
    local Item = fresh()
    local hooks = 0
    states.ox_inventory, versions.ox_inventory = 'started', '2.42.0'
    exportsByResource.ox_inventory = { registerHook = function() hooks = hooks + 1 return 1 end }
    local uses, handler = recorder()
    Item.onUse('radio', handler)
    check(hooks == 0, 'a version below 2.43 gets no hook: it would be accepted and never fire')
    check(Item.status('radio').proven == false, 'and the event alone is not proof')
    check(#Item.status('radio').strategies == 1, 'but it is listed')
    now = 1
    emit('ox_inventory:usedItem', 3, 'radio')
    check(#uses == 1 and uses[1].src == 3, 'the event path still works on it')
    check(printedContains('predates the usingItem hook'), 'and the operator is told why there is no hook')
end
report('PASS an ox_inventory without the hook falls back to the event, unproven')

do
    local Item = fresh()
    states.ox_inventory, versions.ox_inventory = 'started', '2.44.1'
    exportsByResource.ox_inventory = {}
    Item.onUse('radio', function() end)
    check(Item.status('radio').proven == false, 'a fork with no registerHook export is not proven')
    check(printedContains('did not accept'), 'and it is reported')
    local lines = #printed
    Item.onUse('radio', function() end)
    check(#printed == lines, 'the same failure is reported once')
end
report('PASS a missing export is reported once and does not raise')

-- Frameworks

do
    local Item = fresh()
    local registry = {}
    states['qb-core'] = 'started'
    exportsByResource['qb-core'] = {
        GetCoreObject = function()
            return { Functions = { CreateUseableItem = function(item, cb) registry[item] = cb end } }
        end,
    }
    local uses, handler = recorder()
    Item.onUse('radio', handler)
    check(registry.radio ~= nil and Item.status('radio').proven, 'qb-core registers through GetCoreObject')
    registry.radio(9, { name = 'radio' })
    check(#uses == 1 and uses[1].src == 9 and uses[1].via == 'qb-core', 'a qb-core use runs the handler')
end
report('PASS qb-core')

do
    local Item = fresh()
    local qbx, qb = {}, {}
    states.qbx_core, states['qb-core'] = 'started', 'started'
    exportsByResource.qbx_core = { CreateUseableItem = function(_, item, cb) qbx[item] = cb end }
    exportsByResource['qb-core'] = {
        GetCoreObject = function()
            return { Functions = { CreateUseableItem = function(item, cb) qb[item] = cb end } }
        end,
    }
    local uses, handler = recorder()
    Item.onUse('radio', handler)
    check(qbx.radio ~= nil, 'qbx_core registers')
    check(qb.radio == nil, 'and qb-core is skipped, since qbx presents as it')
    qbx.radio(4)
    check(#uses == 1 and uses[1].via == 'qbx_core', 'a qbx use runs the handler')
end
report('PASS qbx_core, and qb-core is not registered beside it')

do
    local Item = fresh()
    local registry = {}
    states.es_extended = 'started'
    exportsByResource.es_extended = {
        getSharedObject = function() return { RegisterUsableItem = function(item, cb) registry[item] = cb end } end,
    }
    local uses, handler = recorder()
    Item.onUse('radio', handler)
    check(registry.radio ~= nil and Item.status('radio').proven, 'es_extended registers through getSharedObject')
    registry.radio(11, 'radio')
    check(#uses == 1 and uses[1].src == 11 and uses[1].via == 'es_extended', 'an ESX use runs the handler')
end
report('PASS es_extended')

do
    local Item = fresh()
    local hooks, registry = {}, {}
    states.ox_inventory, versions.ox_inventory = 'started', '2.44.1'
    states.es_extended = 'started'
    exportsByResource.ox_inventory = {
        registerHook = function(_, event, fn) hooks[#hooks + 1] = fn return 1 end,
    }
    exportsByResource.es_extended = {
        getSharedObject = function() return { RegisterUsableItem = function(item, cb) registry[item] = cb end } end,
    }
    local uses, handler = recorder()
    Item.onUse('radio', handler)

    now = 100
    hooks[1]({ source = 5 })
    registry.radio(5)
    check(#uses == 1, 'one use announced by the ox hook and the ESX registry runs the handler once: ' .. #uses)

    now = 100 + 300
    registry.radio(5)
    check(#uses == 2, 'a use after the window is a new use')

    now = 100 + 300
    registry.radio(8)
    check(#uses == 3, 'the window is per player')

end
report('PASS one use announced twice runs the handler once')

-- Start order and restarts

do
    local Item = fresh()
    local hooks = 0
    states.ox_inventory = 'stopped'
    exportsByResource.ox_inventory = { registerHook = function() hooks = hooks + 1 return hooks end }
    versions.ox_inventory = '2.44.1'
    Item.onUse('radio', function() end)
    check(hooks == 0 and Item.status('radio').proven == false, 'nothing registers while the inventory is not up')

    states.ox_inventory = 'started'
    emit('onServerResourceStart', 'something_else')
    check(hooks == 0, 'another resource starting registers nothing')
    emit('onServerResourceStart', 'ox_inventory')
    check(hooks == 1 and Item.status('radio').proven == true, 'the inventory starting after us registers the item')

    emit('onServerResourceStart', 'ox_inventory')
    check(hooks == 2, 'a restart registers again: its hook registry was emptied')
end
report('PASS an inventory that starts late or restarts is registered with')

-- The handler

do
    local Item = fresh()
    local hooks = {}
    states.ox_inventory, versions.ox_inventory = 'started', '2.44.1'
    exportsByResource.ox_inventory = { registerHook = function(_, _, fn) hooks[#hooks + 1] = fn return 1 end }
    local calls = 0
    Item.onUse('radio', function(src)
        calls = calls + 1
        if src == 5 then error('boom', 0) end
    end)

    now = 1000
    local ok = pcall(hooks[1], { source = 5 })
    check(ok, 'a throwing handler does not take the inventory\'s own code down with it')
    check(printedContains('handler errored: boom'), 'and the error is reported')
    local lines = #printed
    now = 2000
    hooks[1]({ source = 5 })
    check(#printed == lines, 'the same error is reported once')
    now = 3000
    hooks[1]({ source = 6 })
    check(calls == 3, 'and the next player is unaffected')

    for _, bad in ipairs({ 0, -1, 'nope', false }) do
        now = now + 1000
        local before = calls
        hooks[1]({ source = bad })
        check(calls == before, 'a source that is not a player never reaches the handler: ' .. tostring(bad))
    end
    hooks[1](nil)
    check(calls == 3, 'a hook payload with no source never reaches the handler')

    now = now + 1000
    hooks[1]({ source = '7' })
    check(calls == 4, 'a numeric string is the player')
end
report('PASS a handler cannot hurt the inventory, and only players reach it')

-- Disconnect

do
    local Item = fresh()
    local hooks = {}
    states.ox_inventory, versions.ox_inventory = 'started', '2.44.1'
    exportsByResource.ox_inventory = { registerHook = function(_, _, fn) hooks[#hooks + 1] = fn return 1 end }
    local uses, handler = recorder()
    Item.onUse('radio', handler)
    now = 10
    hooks[1]({ source = 5 })
    _G.source = 5
    emit('playerDropped')
    _G.source = nil
    now = 20
    hooks[1]({ source = 5 })
    check(#uses == 2, 'a reconnecting player id is not held to the previous player\'s window')
end
report('PASS a disconnect frees the per-player window')

-- Arguments

do
    local Item = fresh()
    check(not pcall(Item.onUse, '', function() end), 'an empty name is refused')
    check(not pcall(Item.onUse, 'radio', nil), 'a missing handler is refused')
    local status = Item.status('never-registered')
    check(#status.strategies == 0 and status.proven == false, 'an unknown item has nothing registered')
end
report('PASS bad arguments are a programming error')

report(('PASS item-onuse (%d checks)'):format(checks))
