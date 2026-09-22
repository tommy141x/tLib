-- Client-side action dispatch and the effect scheduler.
--
-- The server approves a row by answering with an owner and a handler name.
-- Handlers live in a table per owner, so a resource can only ever reach a handler
-- it registered itself — which is what makes dispatch safe to offer to every
-- resource rather than to one privileged plugin.
--
-- An effect is a handler that keeps running after the row is activated (infinite
-- ammo, god mode, a speed limiter). Because they outlive the menu they have to be
-- re-checked against permissions, stopped when a grant is revoked, and cleaned up
-- when the owning resource stops.

MenuActions = {}
local M = MenuActions
local S = MenuSchema

local dispatchers = {}

-- One thread serves every owner's effects, keyed by owner and name — a scheduler
-- per resource would be N threads waking on the same tick to do the same work.
-- The generation counter is how a faster effect replaces a sleeping scheduler: the
-- old generation notices it is stale on wake and exits rather than dying mid-tick.
local effects = {}
local running, schedulerGeneration, wakeAt = false, 0, 0

local function anyEffects()
    return next(effects) ~= nil
end

local function effectKey(owner, name)
    return owner .. '\0' .. name
end

local function startScheduler()
    schedulerGeneration = schedulerGeneration + 1
    local generation = schedulerGeneration
    running = true
    Platform.createThread(function()
        local last = Platform.now()
        while anyEffects() and generation == schedulerGeneration do
            local now, delay = Platform.now(), 1000
            -- A failing effect stops only itself: clearing the key `pairs` is
            -- currently visiting is the one mutation Lua permits mid-traversal.
            for key, effect in pairs(effects) do
                -- `now < last` is a timer wrap — everything is due.
                if now < last or now >= effect.due then
                    effect.due = now + effect.interval
                    local ok, err = pcall(effect.tick)
                    if not ok then
                        M.log(('effect %s stopped: %s'):format(key, tostring(err)))
                        local dispatcher = dispatchers[effect.owner]
                        if dispatcher then dispatcher:setEffect(effect.name, false) end
                    end
                end
                if effects[key] then delay = math.min(delay, math.max(0, effect.due - now)) end
            end
            last = now
            if anyEffects() and generation == schedulerGeneration then
                wakeAt = now + math.max(1, delay)
                Platform.wait(delay)
            end
        end
        if generation == schedulerGeneration then running, wakeAt = false, 0 end
    end)
end

function M.log(message)
    print('[tLib/menu] ' .. tostring(message))
end

-- An effect may be owned by an action or a list rather than a checkbox, and
-- publishing a boolean onto a list would overwrite the selected option.
local resolveItem = function() return nil end
function M.setItemResolver(fn)
    if type(fn) == 'function' then resolveItem = fn end
end

local D = {}
D.__index = D

--- Get (or create) the dispatcher for one resource. Handlers, stored state and
--- registered effects are all scoped to it.
function M.forOwner(owner)
    assert(type(owner) == 'string' and owner ~= '', 'an action dispatcher needs an owner')
    local existing = dispatchers[owner]
    if existing then return existing end
    local dispatcher = setmetatable({
        owner = owner,
        prefix = owner .. ':',
        handlers = {},
        states = {},
        cleanups = {},
        persisters = {},
        publisher = nil,
        effectsChanged = nil,
    }, D)
    dispatchers[owner] = dispatcher
    return dispatcher
end

function M.get(owner)
    return dispatchers[owner]
end

--- Every registered dispatcher, keyed by owner. The presentation pipeline walks
--- these to replay locally-held state onto a fresh snapshot.
function M.dispatchers()
    return dispatchers
end

--- Dispatch an approved action. The owner is supplied by the server's reply, so a
--- resource cannot reach another resource's handlers by naming them.
function M.execute(owner, name, value, context)
    local dispatcher = dispatchers[owner]
    if not dispatcher then return false, 'Unknown action owner' end
    return dispatcher:execute(name, value, context)
end

function D:register(name, handler)
    assert(type(name) == 'string' and S.callable(handler) and not self.handlers[name],
        'Duplicate or invalid action: ' .. tostring(name))
    self.handlers[name] = handler
end

function D:has(name)
    return self.handlers[name] ~= nil
end

function D:onCleanup(handler) self.cleanups[#self.cleanups + 1] = handler end

-- Persisters run after the handler returns successfully, so a rejected value is
-- never written. They hang off execute rather than publish because publish also
-- fires for permission revocation and for effects the engine stops itself — a
-- stored preference must not be overwritten by a row the server took away.
function D:onPersist(handler) self.persisters[#self.persisters + 1] = handler end
function D:bindPublisher(handler) self.publisher = handler end
function D:onEffectsChanged(handler) self.effectsChanged = handler end

function D:state(name, value)
    if value ~= nil then
        self.states[name] = self.states[name] or {}
        self.states[name].value = value
    end
    return self.states[name] and self.states[name].value
end

function D:publish(name, changes)
    local clean, err = S.patch(changes)
    assert(clean, err)
    self.states[name] = self.states[name] or {}
    for key, value in pairs(clean) do self.states[name][key] = value end
    if self.publisher then self.publisher(name, clean) end
end

--- Replay locally-held state onto a freshly received snapshot, for this owner's
--- rows only. A row belonging to another resource is left exactly as it arrived.
function D:decorate(value)
    for _, menu in ipairs(value.menus) do
        for _, item in ipairs(menu.items) do
            if item.id:sub(1, #self.prefix) == self.prefix then
                local saved = self.states[item.id:sub(#self.prefix + 1)]
                for key, current in pairs(saved or {}) do
                    if key ~= 'value' or S.value(item, current) then item[key] = current end
                end
            end
        end
    end
end

function D:effectNames()
    local names = {}
    for _, effect in pairs(effects) do
        if effect.owner == self.owner then names[#names + 1] = effect.name end
    end
    return names
end

function D:hasEffects()
    return #self:effectNames() > 0
end

--- Stop any effect the player is no longer allowed to run. `allowed` is the
--- server's answer; anything not explicitly true is treated as revoked, so a
--- malformed or missing answer fails closed.
function D:applyPermissions(allowed, requested)
    for _, name in ipairs(requested or self:effectNames()) do
        if type(allowed) ~= 'table' or allowed[name] ~= true then self:setEffect(name, false) end
    end
end

--- Stop any effect whose row has vanished from the snapshot — the ACE was
--- revoked, or the owner hid the row.
function D:syncPermissions(value)
    local available = {}
    for _, menu in ipairs(value.menus) do
        for _, item in ipairs(menu.items) do
            if not item.disabled and item.id:sub(1, #self.prefix) == self.prefix then
                available[item.id:sub(#self.prefix + 1)] = true
            end
        end
    end
    for _, name in ipairs(self:effectNames()) do
        if not available[name] then self:setEffect(name, false) end
    end
end

function D:setEffect(name, enabled, definition)
    local key = effectKey(self.owner, name)
    local previous = effects[key]
    if previous then
        effects[key] = nil
        if previous.stop then
            local ok, err = pcall(previous.stop)
            if not ok then M.log('effect cleanup failed: ' .. tostring(err)) end
        end
    end
    if enabled then
        assert(type(definition) == 'table' and S.callable(definition.tick), 'Invalid effect definition')
        local interval = math.max(0, tonumber(definition.interval) or 0)
        local effect = { owner = self.owner, name = name, tick = definition.tick, stop = definition.stop,
            interval = interval, due = Platform.now() + math.max(1, interval) }
        effects[key] = effect
        -- Ticked once now rather than on the next scheduler pass; a first tick
        -- that throws un-registers rather than leaving a broken effect scheduled.
        local ok, err = pcall(effect.tick)
        if not ok then
            self:setEffect(name, false)
            error(err, 0)
        end
    end
    local item = resolveItem(self.owner, name)
    if not item or item.kind == 'toggle' then self:publish(name, { value = effects[key] ~= nil }) end
    if self.effectsChanged then self.effectsChanged(self:hasEffects()) end
    if not effects[key] then return end
    if running and wakeAt <= effects[key].due then return end
    startScheduler()
end

function D:stopEffects()
    for _, name in ipairs(self:effectNames()) do self:setEffect(name, false) end
end

function D:execute(name, value, context)
    local handler = self.handlers[name]
    if not handler then return false, 'Unknown approved action' end
    local ok, err = pcall(handler, value, context)
    if not ok then return false, tostring(err):sub(1, 256) end
    -- Autosave never fails the change the player just made.
    for index = 1, #self.persisters do
        local saved, reason = pcall(self.persisters[index], name)
        if not saved then M.log(('autosave failed for %s: %s'):format(name, tostring(reason))) end
    end
    return true
end

function D:cleanup()
    self:stopEffects()
    for index = #self.cleanups, 1, -1 do
        local ok, err = pcall(self.cleanups[index])
        if not ok then M.log('module cleanup failed: ' .. tostring(err)) end
    end
end

--- Tear down a resource's dispatcher when it stops, so its effects stop ticking
--- against handlers that are gone.
function M.dropOwner(owner)
    local dispatcher = dispatchers[owner]
    if not dispatcher then return false end
    dispatcher:cleanup()
    dispatchers[owner] = nil
    return true
end

function M.cleanupAll()
    for owner in pairs(dispatchers) do M.dropOwner(owner) end
end

function M.anyEffects()
    return anyEffects()
end

return MenuActions
