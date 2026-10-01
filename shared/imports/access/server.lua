--[[
    tLib/shared/imports/access — who is allowed to use this resource.

    Usage in a consumer (server scripts):

        local radio = tlib.access.gate(Config.access, { key = 'radio', label = 'the radio' })

        RegisterNetEvent('tRadio:transmit', function(...)
            if not radio:allowed(source) then return end
            ...
        end)

    Why this exists
    ---------------
    Every one of these resources eventually gets the same request: "I don't want
    everyone to have this." And every server answers it differently -- one owner
    gates on an ACE, one on a QBox job, one on an item in an ox_inventory, one on
    a bespoke function in their own framework. Hand-rolling that per resource
    produced two bugs already, both the same bug: the CHECK ran on the client, so
    the gate was a greyed-out button and the underlying net event was open to
    anyone who typed it.

    So the rule this module exists to enforce is not "support frameworks". It is:
    **the decision is made here, on the server, every time.** The client mirror in
    client.lua exists only to grey out a button, and says so.

    Two axes, independently detected
    --------------------------------
    A framework answers "what job is this player, at what grade". An inventory
    answers "how many of this item do they have". They are SEPARATE resources and
    separate questions, and conflating them is a real bug, not a tidiness point:

      * qb-core's own `HasItem` is a pass-through to qb-inventory and answers nil
        on a server running qb-core with ox_inventory -- which is a very common
        pairing, and reads as "the player has nothing".
      * ox_core and ND_Core ship no inventory at all; in practice both are run
        with ox_inventory.
      * nat2k15 is a duty/department framework with no inventory concept. It is
        a perfectly good answer to `job`, alongside any inventory at all.

    So `mode = 'item'` needs an INVENTORY, not a framework, and a server with no
    framework whatsoever can still gate on an item.
]]

local access = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

-- How long an answer is reused for one player. This is not really a cache for
-- speed -- the underlying calls are local exports. It is a rate limit: a gate
-- answers a net event the client can fire, and `HasItem` on a large inventory is
-- not free. Short enough that going on duty is reflected within a moment.
local ANSWER_TTL_MS = 250

local VALID_MODES = { everyone = true, ace = true, job = true, item = true, custom = true }

-- ── Adapter registry ────────────────────────────────────────────────────────

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

-- Rebuilding the adapter LIST is not enough on its own: the detection result is
-- cached separately, so an adapter registered after the first check would sit in
-- the list and never win. That is the normal case, not an edge case -- a
-- consumer's server script registering a fork's adapter runs after something has
-- already asked a gate a question. A pinned choice is left alone; it was set
-- deliberately and outranks a later registration.
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

-- ── Detection ───────────────────────────────────────────────────────────────

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

-- Resource start order is not ours to control. A consumer declares
-- `dependencies { 'tLib' }`, which says nothing about qbx_core or ox_inventory,
-- so a gate built at startup can easily run before the framework exists. Caching
-- "nothing detected" at that moment would deny every player for the life of the
-- server, and look exactly like a broken resource.
--
-- So detection is redone whenever ANY resource starts. It is two GetResourceState
-- calls behind a flag, and it turns a permanent wrong answer into a transient one.
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

-- ── Validating an owner's access block ──────────────────────────────────────

--- Checks one `access = { ... }` block. Returns a list of problem strings.
---
--- Deliberately NOT silent-and-deny. A gate whose framework is missing denies
--- every player forever, which an owner experiences as "the resource is broken",
--- and the console is the only place that can tell them otherwise.
---
--- `environment` splits the two kinds of problem, and the split matters:
---
---   * STRUCTURAL (environment = false) is a mistake in the file -- a misspelled
---     mode, a job list of the wrong shape. It is true the moment the file is
---     read, it can only be fixed by editing the file, and it disables the gate.
---   * ENVIRONMENTAL (environment = true) is "mode is job and I see no framework".
---     That may simply mean the framework has not started yet, so asserting it at
---     startup would print a scary, wrong error on a perfectly good server. It is
---     checked once things have settled, and it never disables the gate -- the
---     gate will start passing on its own the moment the framework appears.
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

-- ── Migrating from the pre-access config shape ──────────────────────────────

--- Builds an `access` block from the older loose keys, so an owner's config
--- keeps working across the upgrade.
---
--- This lives in tLib rather than in each resource on purpose. Every one of
--- these resources grew the same three-ish keys independently -- `accessMode`,
--- `acePermission`, and some form of job or item name -- so every one of them
--- would otherwise write its own shim, and get the same two details subtly
--- wrong: that a flat job LIST has no grades and must become `{ name = 0 }`
--- rather than being passed through as-is, and that an owner who has already
--- written the new block must not have it silently overwritten by stale old keys
--- still sitting further up the file.
---
---     Config.access = tlib.access.migrate(Config.access, {
---         mode = Config.accessMode,
---         ace  = Config.acePermission,
---         job  = Config.jobs,            -- flat list or { name = grade }
---         item = Config.qbItemName,
---     }, { file = 'shared/config.lua', removeIn = '2.0.0' })
---
--- @param block table|nil   the owner's `access` block, if they have written one
--- @param legacy table      values read from the old keys; nils are ignored
--- @param opts table|nil    { file, removeIn, names = { mode = 'accessMode', ... } }
--- @return table|nil        the block to hand to `gate()`
function access.migrate(block, legacy, opts)
    opts = opts or {}
    legacy = legacy or {}

    local file = opts.file or 'config.lua'
    local removeIn = opts.removeIn or 'a future major version'
    local names = opts.names or {}
    local function oldName(field) return names[field] or field end

    local used = {}
    for _, field in ipairs({ 'mode', 'ace', 'job', 'item', 'count' }) do
        if legacy[field] ~= nil then used[#used + 1] = oldName(field) end
    end

    local function warn(message)
        print(('^3[%s] %s: %s^7'):format(RESOURCE, file, message))
    end

    if type(block) == 'table' then
        -- The new block wins. Saying so matters: an owner who migrated and left
        -- the old keys behind would otherwise be debugging a setting that is
        -- being ignored, with no indication that it is.
        if #used > 0 then
            warn(('Config.access is set, so %s %s ignored.\n  Fix: delete %s from %s.')
                :format(table.concat(used, ', '), #used == 1 and 'is' or 'are',
                    table.concat(used, ', '), file))
        end
        return block
    end

    if #used == 0 then return nil end

    warn(('%s %s been replaced by a single Config.access block.\n  Your settings are still being used. Fix: move them into Config.access in %s -- see the documentation. The old names stop working in v%s.')
        :format(table.concat(used, ', '), #used == 1 and 'has' or 'have', file, removeIn))

    local job = legacy.job
    if type(job) == 'table' then
        local converted, isFlatList = {}, false
        for key, value in pairs(job) do
            if type(key) == 'number' and type(value) == 'string' then
                -- A flat list of job names, with no grades anywhere. Grade 0 is
                -- the only faithful translation: the old shape could not express
                -- a minimum, so every grade qualified.
                converted[value], isFlatList = 0, true
            elseif type(key) == 'string' then
                converted[key] = tonumber(value) or 0
            end
        end
        job = (next(converted) ~= nil) and converted or nil
        if isFlatList then
            warn(('%s was a list of job names with no grades, so every grade qualifies.\n  Fix: in Config.access, write job = { police = 0 } and raise the 0 to set a minimum grade.')
                :format(oldName('job')))
        end
    else
        job = nil
    end

    return {
        mode   = legacy.mode,
        ace    = legacy.ace,
        job    = job,
        item   = legacy.item,
        count  = legacy.count,
    }
end

-- ── The gate ────────────────────────────────────────────────────────────────

local Gate = {}
Gate.__index = Gate

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

    local value = self:evaluate(src)
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
        -- Reported separately from `modes` so a diagnostic can tell "this gate
        -- is open because demo mode is on" from "this gate is configured open".
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
