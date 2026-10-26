--[[
    Two ordered lists, and order IS the priority: the first adapter whose resource
    is `started` wins -- not `~= 'missing'`, so a stopped leftover folder cannot
    knock out the live one. Overridable with `tlib.access.use()`.

    Every function runs inside server.lua's pcall, so an adapter may index freely.
    It must return the right TYPE: `jobs` a table, `count` a number. A wrong type
    reads as "no jobs" / "none", not an error.
]]

-- Frameworks: "what jobs does this player hold, at what grade"
--
-- Every adapter normalises to { [jobName] = gradeNumber }. A gradeless framework
-- reports 0, which compares true against `job = { x = 0 }` and false against any
-- stricter minimum -- so a grade requirement on a gradeless framework denies
-- rather than silently ignoring the number the owner wrote.

local frameworks = {
    {
        name = 'qbx_core',
        jobs = function(src)
            -- GetGroups returns `{ [name] = gradeLevel }` -- every held job and
            -- gang, not just the primary. The GetPlayer probe must stay first:
            -- GetGroups indexes PlayerData unguarded inside qbx_core's own VM,
            -- so an unloaded source throws there before our pcall can catch it.
            if not exports.qbx_core:GetPlayer(src) then return {} end
            return exports.qbx_core:GetGroups(src)
        end,
    },

    {
        name = 'qb-core',
        jobs = function(src)
            -- qb-core auto-exports everything in QBCore.Functions, so GetPlayer
            -- is reachable directly and there is no need to haul back the whole
            -- core object.
            local player = exports['qb-core']:GetPlayer(src)
            if not player then return {} end
            local data, out = player.PlayerData, {}
            -- Single job and single gang: qb-core has no multi-job map, unlike
            -- qbx. Grade is NESTED (`job.grade.level`), unlike ESX's flat number.
            local job = data and data.job
            if job and job.name then out[job.name] = (job.grade and job.grade.level) or 0 end
            local gang = data and data.gang
            if gang and gang.name then out[gang.name] = (gang.grade and gang.grade.level) or 0 end
            return out
        end,
    },

    {
        name = 'ND_Core',
        jobs = function(src)
            local player = exports.ND_Core:getPlayer(src)
            if not player or type(player.groups) ~= 'table' then return {} end
            local out = {}
            -- `player.groups` is the authoritative map; `player.job` is only the
            -- NAME STRING of whichever group is flagged isJob, which is a real
            -- trap for code expecting the table every other framework gives.
            for name, group in pairs(player.groups) do
                out[name] = tonumber(group and group.rank) or 0
            end
            return out
        end,
    },

    {
        name = 'es_extended',
        jobs = function(src)
            local ESX = exports.es_extended:getSharedObject()
            local player = ESX and ESX.GetPlayerFromId(src)
            if not player or not player.job or not player.job.name then return {} end
            -- ESX's grade is a FLAT number on the job, not a nested table like
            -- qb's. That divergence is the single most common source of wrong
            -- grade comparisons in copy-pasted framework code. ESX has one job
            -- and no gang or group concept.
            return { [player.job.name] = tonumber(player.job.grade) or 0 }
        end,
    },

    {
        name = 'ox_core',
        jobs = function(src)
            -- ox_core's GetPlayer hands back a plain data snapshot, not a live
            -- object, so group queries have to go through CallPlayer. There is
            -- no hasGroup; getGroups returning the name->grade record is the
            -- idiom, and it is the one that matches our shape.
            --
            -- A GetPlayer probe like qbx's was tried and declined: CallPlayer
            -- doesn't throw for an unloaded src (it prints ox_core's own
            -- "invalid id"), so a probe would only quiet the console. Gating on
            -- it instead resolved every job-based grant to nothing when
            -- GetPlayer was uncallable -- a fail-closed outage for a log line.
            local groups = exports.ox_core:CallPlayer(src, 'getGroups')
            if type(groups) ~= 'table' then return {} end
            local out = {}
            for name, grade in pairs(groups) do out[name] = tonumber(grade) or 0 end
            return out
        end,
    },

    {
        name = 'nat2k15framework',
        jobs = function(src)
            -- `geteverything()`, NOT `getdept(src)`. getdept takes an id but uses it
            -- only as a presence test and returns the ENTIRE on_duty table, so
            -- reading its result as one player's department is wrong for every
            -- player on the server.
            local onDuty = exports['nat2k15framework']:geteverything()
            local entry = type(onDuty) == 'table' and (onDuty[src] or onDuty[tonumber(src)])
            if not entry or not entry.dept then return {} end

            -- nat2k15 has no rank, grade or seniority field of any kind: a player
            -- is in exactly one department, full stop. Reporting grade 0 means
            -- `job = { LSPD = 0 }` works and `job = { LSPD = 3 }` denies rather
            -- than quietly ignoring the 3 the owner wrote.
            --
            -- The dept is a DISPLAY name ("LSPD"), resolved through
            -- Config.dept_names, so that is the string an owner must write here.
            return { [tostring(entry.dept)] = 0 }
        end,
    },
}

-- Inventories: "how many of this item does the player have"
--
-- Ordered by deployment, ox_inventory first. Each returns a NUMBER, never a
-- boolean: a boolean cannot answer `count = 2`. community_bridge's origen
-- adapter tested `>` instead of `>=`, denying a player holding exactly the one
-- item required.

local inventories = {
    {
        name = 'ox_inventory',
        count = function(src, item)
            -- GetItemCount, not Search: ox_core itself uses it, and the only
            -- `Search(src, 'count', …)` call sites in the corpus are qbx_core shims
            -- tagged ---@deprecated. Fourth arg is `strict` metadata matching, and
            -- false is what every in-corpus caller passes and what a bare item means.
            return exports.ox_inventory:GetItemCount(src, item, nil, false) or 0
        end,
    },

    {
        name = 'qs-inventory',
        count = function(src, item)
            return exports['qs-inventory']:GetItemTotalAmount(src, item) or 0
        end,
    },

    {
        name = 'codem-inventory',
        count = function(src, item)
            return exports['codem-inventory']:GetItemsTotalAmount(src, item) or 0
        end,
    },

    {
        name = 'origen_inventory',
        count = function(src, item)
            return exports.origen_inventory:getItemCount(src, item, nil, false) or 0
        end,
    },

    {
        name = 'core_inventory',
        count = function(src, item)
            return exports.core_inventory:getItemCount(src, item) or 0
        end,
    },

    {
        name = 'tgiann-inventory',
        count = function(src, item)
            -- Returns a slot table or nil; the `or {}` is required, since the
            -- in-corpus caller indexes it unguarded and errors on a name the
            -- player does not hold.
            local slot = exports['tgiann-inventory']:GetItemByName(src, item)
            return (slot and slot.amount) or 0
        end,
    },

    {
        name = 'qb-inventory',
        count = function(src, item, required)
            return exports['qb-inventory']:HasItem(src, item, required or 1) and (required or 1) or 0
        end,
    },
    {
        name = 'ps-inventory',
        count = function(src, item, required)
            return exports['ps-inventory']:HasItem(src, item, required or 1) and (required or 1) or 0
        end,
    },
    {
        name = 'jpr-inventory',
        count = function(src, item, required)
            return exports['jpr-inventory']:HasItem(src, item, required or 1) and (required or 1) or 0
        end,
    },
}

return { frameworks = frameworks, inventories = inventories }
