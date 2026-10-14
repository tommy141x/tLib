--[[
    tLib/shared/imports/access — who is allowed to use this resource.

    Usage in a consumer (server scripts):

        local radio = tlib.access.gate(Config.access, { key = 'radio', label = 'the radio' })

        RegisterNetEvent('tRadio:transmit', function(...)
            if not radio:allowed(source) then return end
            ...
        end)

    The decision is made HERE, on the server, every time; the client mirror
    only greys out a button. Framework and inventory are independent axes.
    Design notes: docs/internal/access-gate.md

]]

local access = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

-- How long an answer is reused for one player. This is not really a cache for
-- speed -- the underlying calls are local exports. It is a rate limit: a gate
-- answers a net event the client can fire, and `HasItem` on a large inventory is
-- not free. Short enough that going on duty is reflected within a moment.
local ANSWER_TTL_MS = 250

local VALID_MODES = { everyone = true, ace = true, job = true, item = true, custom = true }

-- Adapter registry

-- Ordered, not a map. Detection order is load-bearing: qbx_core declares
-- `provide 'qb-core'` AND registers the qb-core export names, so on a QBox server
-- `exports['qb-core']:GetCoreObject()` SUCCEEDS and hands back a deprecated
-- compatibility shim. Checking qb-core first would silently put every QBox server
-- on the legacy path. qbx is therefore checked first, and anything else that
-- shims an older framework must go ahead of the thing it shims.
local frameworks, inventories = nil, nil
local extraFrameworks, extraInventories = {}, {}

-- Declared here, not next to the detection helpers below, because
-- invalidateDetection() needs it and Lua would otherwise resolve it as a global
-- -- which is nil, and errors the moment an adapter is registered.
local detected = {}

local function loadAdapters()
    if frameworks then return end

    local chunk = LoadResourceFile('tLib', 'shared/imports/access/adapters.lua')
    local built = { frameworks = {}, inventories = {} }

    if chunk then
        local fn = load(chunk, '@@tLib/shared/imports/access/adapters.lua')
        if fn then
            local ok, result = pcall(fn)
            if ok and type(result) == 'table' then built = result end
        end
    end

    frameworks, inventories = {}, {}
    -- Registered adapters come FIRST, so a server can override a built-in that
    -- has drifted from their fork without waiting on a tLib release.
    for _, a in ipairs(extraFrameworks) do frameworks[#frameworks + 1] = a end
    for _, a in ipairs(built.frameworks or {}) do frameworks[#frameworks + 1] = a end
    for _, a in ipairs(extraInventories) do inventories[#inventories + 1] = a end
    for _, a in ipairs(built.inventories or {}) do inventories[#inventories + 1] = a end
end

-- Rebuilding the adapter list is not enough: the detection RESULT is cached
-- separately, so an adapter registered after the first check would sit in the
-- list and never win. A pinned choice outranks a later registration.
local function invalidateDetection()
    frameworks, inventories = nil, nil
    if not detected.frameworkPinned then detected.frameworkDone = false end
    if not detected.inventoryPinned then detected.inventoryDone = false end
end

--- Teach access about a framework it does not ship an adapter for.
--- Must be called from a server_script in the consuming resource -- adapters
--- register into that resource's own VM.
--- @param adapter table { name, resource?, detect?, jobs = function(src) -> { [job] = grade } }
function access.registerFramework(adapter)
    extraFrameworks[#extraFrameworks + 1] = adapter
    invalidateDetection()
end

--- Teach access about an inventory it does not ship an adapter for.
--- @param adapter table { name, resource?, detect?, count = function(src, item) -> number }
function access.registerInventory(adapter)
    extraInventories[#extraInventories + 1] = adapter
    invalidateDetection()
end

-- Detection

local function resourceRunning(name)
    if type(name) ~= 'string' or name == '' then return false end
    local ok, state = pcall(GetResourceState, name)
    return ok and state == 'started'
end

local function detectOne(list)
    for _, adapter in ipairs(list) do
        local present
        if adapter.detect then
            local ok, result = pcall(adapter.detect)
            present = ok and result == true
        else
            present = resourceRunning(adapter.resource or adapter.name)
        end
        if present then return adapter end
    end
    return nil
end

--
-- Detection is redone whenever ANY resource starts: a consumer's dependency on
-- tLib says nothing about qbx_core or ox_inventory, and caching "nothing
-- detected" would deny every player for the life of the server.
if AddEventHandler then
    AddEventHandler('onResourceStart', function()
        detected.frameworkDone = detected.frameworkPinned or false
        detected.inventoryDone = detected.inventoryPinned or false
    end)
end

local function framework()
    loadAdapters()
    if detected.frameworkDone then return detected.framework end
    detected.framework, detected.frameworkDone = detectOne(frameworks), true
    return detected.framework
end

local function inventory()
    loadAdapters()
    if detected.inventoryDone then return detected.inventory end
    detected.inventory, detected.inventoryDone = detectOne(inventories), true
    return detected.inventory
end

--- Name of the detected framework, or nil. For diagnostics.
function access.framework()
    local a = framework()
    return a and a.name or nil
end

--- Name of the detected inventory, or nil. For diagnostics.
function access.inventory()
    local a = inventory()
    return a and a.name or nil
end

--- Pin detection instead of auto-detecting. For a server running two frameworks,
--- or a fork whose resource is named something else.
---
--- `nil` leaves that axis alone, so `use(nil, 'ox_inventory')` pins only the
--- inventory. `'none'` pins it to nothing -- useful to stop a framework you do
--- not actually use from being picked up. `'auto'` undoes a pin and goes back to
--- detecting.
---
--- @param frameworkName string|nil  an adapter name, or 'none', or 'auto'
--- @param inventoryName string|nil
function access.use(frameworkName, inventoryName)
    loadAdapters()

    local function pin(list, wanted, label)
        if wanted == nil then return nil, false end
        if wanted == 'none' or wanted == false then return nil, true end
        if wanted == 'auto' then return nil, false, true end
        for _, adapter in ipairs(list) do
            if adapter.name == wanted then return adapter, true end
        end
        print(('^1[%s] tlib.access: no %s adapter named "%s". Detection is unchanged.^7')
            :format(RESOURCE, label, tostring(wanted)))
        return nil, false
    end

    local fw, fwSet, fwAuto = pin(frameworks, frameworkName, 'framework')
    if fwSet then
        detected.framework, detected.frameworkDone, detected.frameworkPinned = fw, true, true
    elseif fwAuto then
        detected.framework, detected.frameworkDone, detected.frameworkPinned = nil, false, false
    end

    local inv, invSet, invAuto = pin(inventories, inventoryName, 'inventory')
    if invSet then
        detected.inventory, detected.inventoryDone, detected.inventoryPinned = inv, true, true
    elseif invAuto then
        detected.inventory, detected.inventoryDone, detected.inventoryPinned = nil, false, false
    end
end

--- The player's jobs as `{ [name] = grade }`. `{}` when there is no framework or
--- the player is unknown. Useful on its own, not just for gating.
--- @param src number|string
--- @return table
function access.jobs(src)
    local adapter = framework()
    if not adapter or not adapter.jobs then return {} end
    local ok, result = pcall(adapter.jobs, src)
    if not ok or type(result) ~= 'table' then return {} end
    return result
end

--- How many of `item` the player has. 0 when there is no inventory.
---
--- `required` is passed through to the adapter rather than compared here,
--- because three of the supported inventories expose only a boolean
--- `HasItem(src, item, n)` and no count export at all. Those can answer
--- "at least n?" exactly, but cannot answer "how many?" -- so the threshold has
--- to reach them. Adapters that do have a real count export ignore it.
---
--- @param src number|string
--- @param item string
--- @param required number|nil
--- @return number
function access.count(src, item, required)
    local adapter = inventory()
    if not adapter or not adapter.count or type(item) ~= 'string' or item == '' then return 0 end
    local ok, result = pcall(adapter.count, src, item, required or 1)
    if not ok or type(result) ~= 'number' then return 0 end
    return result
end

-- Validating an owner's access block

--- Checks one `access = { ... }` block. Returns a list of problem strings.
--- Deliberately not silent-and-deny: a gate whose framework is missing denies
--- everyone forever, which an owner experiences as a broken resource.
---
--- `environment` splits the two kinds. STRUCTURAL is a mistake in the file and
--- disables the gate; ENVIRONMENTAL is "mode is job and I see no framework",
--- which may just mean the framework has not started yet, so it warns and never
--- disables. See docs/internal/access-gate.md.
local function problems(block, label, environment)
    local out = {}
    local function bad(message)
        if not environment then out[#out + 1] = message end
    end
    local function badEnv(message)
        if environment then out[#out + 1] = message end
    end

    if type(block) ~= 'table' then
        bad(('access for %s must be a table. Found %s.\n  Fix: add an access = { mode = "everyone" } block.')
            :format(label, type(block)))
        return out
    end

    local modes = block.mode
    if type(modes) == 'string' then modes = { modes } end
    if type(modes) ~= 'table' or #modes == 0 then
        bad(('access.mode for %s must be one of "everyone", "ace", "job", "item", "custom" (or a list of them). Found %s.\n  Fix: set mode = "everyone" to give it to every player.')
            :format(label, type(block.mode) == 'nil' and 'nothing' or tostring(block.mode)))
        return out
    end

    for _, mode in ipairs(modes) do
        if not VALID_MODES[mode] then
            bad(('access.mode for %s has an unknown entry "%s".\n  Fix: use one of "everyone", "ace", "job", "item", "custom".')
                :format(label, tostring(mode)))
        elseif mode == 'ace' then
            if type(block.ace) ~= 'string' or block.ace == '' then
                bad(('access.mode for %s is "ace", but access.ace is not set.\n  Fix: set ace = "%s.use" and grant it with `add_ace group.admin %s.use allow` in server.cfg.')
                    :format(label, RESOURCE:lower(), RESOURCE:lower()))
            end
        elseif mode == 'job' then
            if type(block.job) ~= 'table' or next(block.job) == nil then
                bad(('access.mode for %s is "job", but access.job is empty.\n  Fix: list the jobs and their minimum grade, e.g. job = { police = 0, sheriff = 2 }.')
                    :format(label))
            else
                for name, grade in pairs(block.job) do
                    if type(name) ~= 'string' then
                        bad(('access.job for %s has a non-text job name.\n  Fix: write job = { police = 0 }, not job = { "police" }.'):format(label))
                    elseif type(grade) ~= 'number' then
                        bad(('access.job.%s for %s must be a minimum grade number. Found %s.\n  Fix: use 0 to accept any grade.')
                            :format(tostring(name), label, type(grade)))
                    end
                end
                if environment and not access.framework() then
                    badEnv(('access.mode for %s is "job", but no supported framework was detected, so NO player can pass this gate.\n  Fix: start your framework before %s, or pin it with tlib.access.use("qbx_core"), or switch to mode = "ace".')
                        :format(label, RESOURCE))
                end
            end
        elseif mode == 'item' then
            if type(block.item) ~= 'string' or block.item == '' then
                bad(('access.mode for %s is "item", but access.item is not set.\n  Fix: set item = "the_item_name" exactly as it appears in your inventory\'s item list.')
                    :format(label))
            elseif environment and not access.inventory() then
                badEnv(('access.mode for %s is "item", but no supported inventory was detected, so NO player can pass this gate.\n  Fix: start your inventory before %s, or pin it with tlib.access.use(nil, "ox_inventory"), or switch to mode = "ace".')
                    :format(label, RESOURCE))
            end
        elseif mode == 'custom' then
            if type(block.custom) ~= 'function' then
                bad(('access.mode for %s is "custom", but access.custom is not a function. Found %s.\n  Fix: write custom = function(src) return true end.')
                    :format(label, type(block.custom) == 'nil' and 'nothing' or type(block.custom)))
            end
        end
    end

    if block.count ~= nil and type(block.count) ~= 'number' then
        bad(('access.count for %s must be a number. Found %s.\n  Fix: use count = 1, or remove it.')
            :format(label, type(block.count)))
    end

    return out
end

access.problems = problems

-- The gate

local Gate = {}
Gate.__index = Gate

--
--
--
-- Every gate this resource has built, so a disconnect can drop that player's
-- memoised answer from all of them. WITHOUT THIS A GATE IS A SILENT MEMORY LEAK:
-- the TTL makes an entry stale, it does not remove it, so a gate holds one entry
-- per unique player for the life of the process. Weak KEYS so a dropped gate is
-- collectable; one lazily-installed handler rather than one per gate.
local liveGates = setmetatable({}, { __mode = 'k' })
local gateSweepInstalled = false

local function installGateSweep()
    if gateSweepInstalled then return end
    gateSweepInstalled = true
    AddEventHandler('playerDropped', function()
        local src = source
        if src == nil then return end
        for gate in pairs(liveGates) do gate:invalidate(src) end
    end)
end

--- Recomputes from scratch. Never cached, never trusted from a client.
function Gate:evaluate(src)
    if src == nil then return false end
    -- Demo mode opens every gate, including a broken one. Ahead of `self.broken`
    -- on purpose: a demo server's whole job is to be walked through, and a config
    -- mistake in an access block the visitor cannot see or fix would otherwise
    -- lock the demo out of a feature with no way to tell why from in-game.
    -- Gate:report() surfaces it as `demo = true` so a diagnostic never mistakes
    -- this for a gate that genuinely evaluates open.
    if tlib.demo.active() then return true end
    if self.broken then return false end

    for _, mode in ipairs(self.modes) do
        if mode == 'everyone' then
            return true
        elseif mode == 'ace' then
            if tlib.permission.has(src, self.block.ace) then return true end
        elseif mode == 'job' then
            local held = access.jobs(src)
            for name, minimum in pairs(self.block.job) do
                local grade = held[name]
                if grade ~= nil and grade >= minimum then return true end
            end
        elseif mode == 'item' then
            local required = self.block.count or 1
            if access.count(src, self.block.item, required) >= required then return true end
        elseif mode == 'custom' then
            local ok, result = pcall(self.block.custom, src)
            if not ok then
                -- An owner's function that throws must not become an open gate.
                print(('^1[%s] access.custom for %s errored: %s. Denying.^7')
                    :format(RESOURCE, self.label, tostring(result)))
            elseif result == true then
                return true
            end
        end
    end

    return false
end

--- Is this player allowed? Call this before EVERY privileged action, server-side.
--- @param src number|string
--- @return boolean
function Gate:allowed(src)
    if src == nil then return false end

    local key = tostring(src)
    local now = (GetGameTimer and GetGameTimer()) or 0
    local memo = self.memo[key]
    if memo and (now - memo.at) < ANSWER_TTL_MS then return memo.value end

    --
    --
    -- Instrumented on the MISS path only. `evaluate` calls out to whichever
    -- framework and inventory the customer runs, and that is one of the few
    -- costs in this estate that depends on their server rather than ours -- a
    -- profiler once attributed ~5.2 ms to one permission resolution. 50 ms,
    -- because a privileged action waits on this.
    local value = self:evaluate(src)
    tlib.telemetry.record('access:evaluate', 50, ((GetGameTimer and GetGameTimer()) or 0) - now)
    self.memo[key] = { at = now, value = value }
    return value
end

--- Drop any memoised answer for a player -- call after you change what the gate
--- reads (handing them the item, setting their job) so the next check is fresh.
--- @param src number|string|nil  nil clears everyone
function Gate:invalidate(src)
    if src == nil then
        self.memo = {}
    else
        self.memo[tostring(src)] = nil
    end
end

--- Recompute and push the answer to that player's client mirror.
--- @param src number|string
--- @return boolean  the answer that was sent
function Gate:push(src)
    self:invalidate(src)
    local value = self:allowed(src)
    TriggerClientEvent(self.event, src, value)
    return value
end

--- Structured account of how this gate decides. This is the SHAPE to assert on
--- in a diagnostic test -- `describe()` is prose for a human reading a support
--- dump, and prose is allowed to be reworded.
---
--- @return table { label, modes = {string}, broken = boolean, demo = boolean,
---                 framework, inventory, ace?, job?, item?, count? }
function Gate:report()
    local modes = {}
    for i, mode in ipairs(self.modes) do modes[i] = mode end

    local job
    if self.block.job then
        job = {}
        for name, grade in pairs(self.block.job) do job[name] = grade end
    end

    return {
        label     = self.label,
        modes     = modes,
        broken    = self.broken,
        -- Reported separately from `modes` so a diagnostic can tell "open
        -- because demo mode is on" from "configured open".
        demo      = tlib.demo.active(),
        framework = access.framework(),
        inventory = access.inventory(),
        ace       = self.block.ace,
        job       = job,
        item      = self.block.item,
        count     = self.block.item and (self.block.count or 1) or nil,
    }
end

--- One line describing how this gate decides, for `<resource>_diag`. Prose, for
--- a human. Assert on `report()` instead.
--- @return string
function Gate:describe()
    local parts = {}
    for _, mode in ipairs(self.modes) do
        if mode == 'everyone' then
            parts[#parts + 1] = 'everyone'
        elseif mode == 'ace' then
            parts[#parts + 1] = ('ace "%s"'):format(tostring(self.block.ace))
        elseif mode == 'job' then
            local jobs = {}
            for name, grade in pairs(self.block.job or {}) do
                jobs[#jobs + 1] = ('%s>=%s'):format(name, tostring(grade))
            end
            table.sort(jobs)
            parts[#parts + 1] = ('job (%s) via %s'):format(
                table.concat(jobs, ', '), access.framework() or 'NO FRAMEWORK DETECTED')
        elseif mode == 'item' then
            parts[#parts + 1] = ('item "%s" x%d via %s'):format(
                tostring(self.block.item), self.block.count or 1,
                access.inventory() or 'NO INVENTORY DETECTED')
        elseif mode == 'custom' then
            parts[#parts + 1] = 'custom function'
        end
    end

    local line = ('%s: %s'):format(self.label, table.concat(parts, ' OR '))
    if self.broken then line = line .. '  [DISABLED -- config errors above]' end
    -- Last, and phrased as an override, because it is: the configured rule above
    -- is still what this gate will decide by the moment tlib_demo goes away.
    if tlib.demo.active() then line = line .. '  [OVERRIDDEN -- demo mode grants everyone]' end
    return line
end

--- Builds a gate from an owner's `access = { ... }` block.
---
--- Validation problems are printed once, here, at startup -- and a gate with
--- problems denies everyone rather than guessing. Guessing is how a gate meant to
--- restrict something ends up granting it.
---
--- @param block table  the owner's access table
--- @param opts table   { key = 'radio', label = 'the radio', file = 'config.lua' }
--- @return table gate
function access.gate(block, opts)
    opts = opts or {}
    local key = opts.key or 'access'
    local label = opts.label or key

    local file = opts.file or 'config.lua'
    local function report(colour, message)
        print(('%s[%s] %s: %s^7'):format(colour, RESOURCE, file, message))
    end

    local found = problems(block, label, false)
    for _, message in ipairs(found) do report('^1', message) end

    local modes = type(block) == 'table' and block.mode or nil
    if type(modes) == 'string' then modes = { modes } end

    local self = setmetatable({
        block  = type(block) == 'table' and block or {},
        modes  = type(modes) == 'table' and modes or {},
        label  = label,
        broken = #found > 0,
        memo   = {},
        -- Namespaced by resource: FiveM net event names are global, so two
        -- resources both using key 'access' would otherwise answer each other's
        -- clients.
        event  = ('%s:tlib:access:%s'):format(RESOURCE, key),
    }, Gate)

    -- Self-sweeping on disconnect; see `liveGates`. Registered here rather than
    -- left to the consumer because the leak is invisible from the call site.
    installGateSweep()
    liveGates[self] = true

    -- The client mirror asks through this. It is a REQUEST for a fresh answer,
    -- never an assertion of one -- the payload is ignored on purpose.
    RegisterNetEvent(self.event, function()
        local src = source
        if src == nil then return end
        TriggerClientEvent(self.event, src, self:allowed(src))
    end)

    -- Environmental problems are checked once the server has settled, because at
    -- this instant the framework may simply not have started yet. Printed as a
    -- warning, not an error: the gate is correctly configured, its dependency is
    -- just absent, and if it appears later the gate starts working by itself.
    if not self.broken and SetTimeout then
        SetTimeout(10000, function()
            for _, message in ipairs(problems(block, label, true)) do report('^3', message) end
        end)
    end

    return self
end

return access
