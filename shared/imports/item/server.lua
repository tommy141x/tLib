--[[
    tLib/shared/imports/item -- run a function when a player uses an inventory item (server).

        tlib.item.onUse('radio', function(src)
            TriggerClientEvent('tradio:open', src)
        end)

    Every inventory announces a use differently, and a resource that wants the use
    should not have to know which one this server runs. onUse registers with each
    one that is running -- ox_inventory, qbx_core, qb-core, es_extended -- and
    registers again when one starts later or restarts, so server.cfg order does
    not matter.
]]

local Item = {}

local RESOURCE = GetCurrentResourceName()

--- ox_inventory only gained TriggerEventHooks('usingItem') in this release. Below
--- it registerHook accepts the name, returns an id, and the hook never fires.
local OX_HOOK_MIN = { 2, 43, 0 }

--- One use can be announced twice: by two strategies (an ox bridge routes it to
--- the framework registry as well), or twice by one when a resource's start event
--- races a registration made while it was coming up. A second use of an item by
--- the same player inside this window is the same use. A handler that toggles
--- would otherwise cancel itself out.
local DUPLICATE_WINDOW_MS = 250

--- item -> { handler, consume, registered = { [label] = true }, last = { [src] = ms of the last use } }
local registry = {}

local installed = false
local reported = {}

local function reportOnce(key, line)
    if reported[key] then return end
    reported[key] = true
    print(line)
end

--- 'ok' with the result, 'absent' when the resource has no such export, 'error'
--- with the message when it exists and threw. The two failures call for opposite
--- reactions -- try another strategy, or keep this one and say what broke -- and
--- indexing exports.x.y proves nothing, because the proxy resolves lazily.
local function callExport(resource, name, ...)
    local args = table.pack(...)
    local ok, result = pcall(function()
        local fn = exports[resource][name]
        return fn(exports[resource], table.unpack(args, 1, args.n))
    end)
    if ok then return 'ok', result end
    if tostring(result):find('No such export', 1, true) then return 'absent', tostring(result) end
    return 'error', tostring(result)
end

local function parseVersion(raw)
    if type(raw) ~= 'string' then return nil end
    local major, minor, patch = raw:match('(%d+)%.(%d+)%.(%d+)')
    if not major then
        major, minor = raw:match('(%d+)%.(%d+)')
        patch = '0'
    end
    if not major then return nil end
    return tonumber(major), tonumber(minor), tonumber(patch)
end

--- An unparseable version is "no": an unknown ox build must not be handed a hook
--- that silently does nothing on it.
local function versionAtLeast(raw, target)
    local major, minor, patch = parseVersion(raw)
    if not major then return false end
    if major ~= target[1] then return major > target[1] end
    if minor ~= target[2] then return minor > target[2] end
    return patch >= target[3]
end

local function fire(item, src, via)
    local entry = registry[item]
    if not entry then return end
    src = tonumber(src)
    if not src or src <= 0 then return end

    local now = GetGameTimer()
    local last = entry.last[src]
    -- `now >= last`: after the 32-bit game timer wraps the difference is negative, and every
    -- later use of the item would read as a duplicate of the one before the wrap.
    if last and now >= last and (now - last) < DUPLICATE_WINDOW_MS then return end
    entry.last[src] = now

    local ok, err = pcall(entry.handler, src, { item = item, via = via })
    if not ok then
        reportOnce(item .. '\0' .. tostring(err),
            ('^1[%s] tlib.item.onUse "%s" handler errored: %s^7'):format(RESOURCE, item, tostring(err)))
    end
end

--- One entry per way an inventory announces a use. `proven` strategies are the
--- ones with positive evidence they will fire; the ox event is not, because
--- AddEventHandler always succeeds and nothing shows this fork emits it.
local STRATEGIES = {
    {
        label = 'ox_inventory:usingItem',
        resource = 'ox_inventory',
        proven = true,
        register = function(item, entry)
            local version = GetResourceMetadata('ox_inventory', 'version', 0)
            if not versionAtLeast(version, OX_HOOK_MIN) then
                return false, ('ox_inventory %s predates the usingItem hook (needs 2.43.0)'):format(tostring(version))
            end
            local status, err = callExport('ox_inventory', 'registerHook', 'usingItem', function(payload)
                fire(item, payload and payload.source, 'ox_inventory:usingItem')
                -- false cancels ox's own use: no consume, durability or animation.
                if not entry.consume then return false end
            end, { itemFilter = { [item] = true } })
            if status == 'ok' then return true end
            return false, err
        end,
    },
    {
        label = 'ox_inventory:usedItem',
        resource = 'ox_inventory',
        proven = false,
        -- A plain handler (see install), so the event path needs no per-item work.
        register = function() return true end,
    },
    {
        label = 'qbx_core',
        resource = 'qbx_core',
        proven = true,
        register = function(item)
            local status, err = callExport('qbx_core', 'CreateUseableItem', item, function(src)
                fire(item, src, 'qbx_core')
            end)
            if status == 'ok' then return true end
            return false, err
        end,
    },
    {
        label = 'qb-core',
        resource = 'qb-core',
        proven = true,
        -- qbx_core presents itself as qb-core too; registering with both would
        -- announce every use twice.
        skipWhen = 'qbx_core',
        register = function(item)
            local status, core = callExport('qb-core', 'GetCoreObject')
            if status ~= 'ok' or type(core) ~= 'table' then return false, core end
            local ok, err = pcall(function()
                core.Functions.CreateUseableItem(item, function(src)
                    fire(item, src, 'qb-core')
                end)
            end)
            if ok then return true end
            return false, err
        end,
    },
    {
        label = 'es_extended',
        resource = 'es_extended',
        proven = true,
        register = function(item)
            local status, esx = callExport('es_extended', 'getSharedObject')
            if status ~= 'ok' or type(esx) ~= 'table' then return false, esx end
            local ok, err = pcall(function()
                esx.RegisterUsableItem(item, function(src)
                    fire(item, src, 'es_extended')
                end)
            end)
            if ok then return true end
            return false, err
        end,
    },
}

local function strategyApplies(strategy)
    if GetResourceState(strategy.resource) ~= 'started' then return false end
    if strategy.skipWhen and GetResourceState(strategy.skipWhen) == 'started' then return false end
    return true
end

--- Try every strategy whose resource is up. Failure is reported once and retried
--- the next time that resource starts.
local function registerWith(item, entry, only)
    for _, strategy in ipairs(STRATEGIES) do
        local wanted = (only == nil and not entry.registered[strategy.label]) or strategy.resource == only
        if wanted and strategyApplies(strategy) then
            local ok, why = strategy.register(item, entry)
            if ok then
                entry.registered[strategy.label] = true
            else
                entry.registered[strategy.label] = nil
                reportOnce(item .. '\0' .. strategy.label .. '\0' .. tostring(why),
                    ('^3[%s] tlib.item.onUse "%s": %s did not accept the registration (%s)^7')
                        :format(RESOURCE, item, strategy.label, tostring(why)))
            end
        end
    end
end

local function install()
    if installed then return end
    installed = true

    -- Fires for any resource, so an inventory that starts after this one, or
    -- restarts and forgets its registry, gets the item registered again.
    AddEventHandler('onServerResourceStart', function(name)
        for item, entry in pairs(registry) do registerWith(item, entry, name) end
    end)

    -- Local event: no net player can raise it. Registered with AddEventHandler
    -- rather than through ox so ox's own teardown cannot remove it. ox emits it
    -- as TriggerEvent('ox_inventory:usedItem', playerId, name, slot, metadata).
    AddEventHandler('ox_inventory:usedItem', function(playerId, usedName)
        if type(usedName) ~= 'string' or not registry[usedName] then return end
        fire(usedName, playerId or source, 'ox_inventory:usedItem')
    end)

    AddEventHandler('playerDropped', function()
        local src = source
        if not src then return end
        for _, entry in pairs(registry) do entry.last[src] = nil end
    end)
end

--- Run `handler(src, { item, via })` when a player uses `itemName`.
---
--- `opts.consume = true` lets ox_inventory consume the item as it normally
--- would; the default cancels ox's own use, for an item that opens something
--- rather than being spent. Other inventories consume (or not) on their own.
---
--- Safe to call before the inventory resource has started, and again from a
--- restarted resource. Registering a name again replaces its handler.
---
--- @param itemName string
--- @param handler fun(src: number, info: { item: string, via: string })
--- @param opts { consume?: boolean }|nil
function Item.onUse(itemName, handler, opts)
    assert(type(itemName) == 'string' and itemName ~= '', 'tlib.item.onUse: itemName must be a non-empty string')
    assert(type(handler) == 'function', 'tlib.item.onUse: handler must be a function')
    opts = opts or {}

    install()

    local entry = registry[itemName]
    if entry then
        entry.handler = handler
        entry.consume = opts.consume == true
    else
        entry = { handler = handler, consume = opts.consume == true, registered = {}, last = {} }
        registry[itemName] = entry
    end
    registerWith(itemName, entry)
end

--- What is registered for an item right now, for a diagnostics line.
---
--- `strategies` lists every registration that was accepted. `proven` is true when
--- at least one of them has positive evidence it will fire; the ox usedItem
--- event alone does not count. `proven = false` is when to tell the operator to
--- add the event to their inventory's items file.
--- @return { strategies: string[], proven: boolean }
function Item.status(itemName)
    local entry = registry[itemName]
    local strategies, proven = {}, false
    if entry then
        for _, strategy in ipairs(STRATEGIES) do
            if entry.registered[strategy.label] then
                strategies[#strategies + 1] = strategy.label
                if strategy.proven then proven = true end
            end
        end
    end
    return { strategies = strategies, proven = proven }
end

return Item
