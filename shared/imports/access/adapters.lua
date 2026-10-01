--[[
    tLib/shared/imports/access/adapters.lua

    The built-in framework and inventory adapters. Loaded lazily, by server.lua,
    with LoadResourceFile -- never by the import loader, which only understands
    shared/client/server.lua.

    Two ordered lists. Order IS the priority, and it is the whole detection
    strategy: first adapter whose resource is `started` wins.

    Why not do it community_bridge's way
    ------------------------------------
    community_bridge detects by fxmanifest glob order plus a hand-maintained
    matrix of pairwise "bow out if that other one exists" guards, each testing
    `GetResourceState(x) ~= 'missing'`. Two measured consequences of that design,
    both of which this file is shaped to avoid:

      * `~= 'missing'` is TRUE for a resource that is merely stopped. A leftover
        inventory folder the owner stopped months ago still knocks out the live
        one. We test `== 'started'`.
      * The matrix is asymmetric, so it only actually protects ox_inventory.
        With qs-inventory and codem-inventory both installed, the winner is
        whichever sorts later alphabetically. A single ordered list cannot do
        that -- it may pick the wrong one, but it picks the same wrong one every
        time, it is written down, and `tlib.access.use()` overrides it.

    Every function here is called inside a pcall by server.lua, so an adapter may
    assume its resource is present and index freely. It must return the right
    TYPE though: `jobs` a table, `count` a number. A wrong type is read as "no
    jobs" / "none", not as an error.
]]

-- ── Frameworks: "what jobs does this player hold, at what grade" ─────────────
--
-- Every adapter normalises to the same shape: { [jobName] = gradeNumber }.
-- A framework with no notion of grade reports 0, which compares true against any
-- `job = { x = 0 }` and false against any stricter minimum -- so an owner who
-- writes a grade requirement on a gradeless framework gets a gate that denies,
-- not one that silently ignores the number they wrote.

local frameworks = {
    -- FIRST, and this ordering is load-bearing. qbx_core declares
    -- `provide 'qb-core'` and registers the qb-core export names, so on a QBox
    -- server `exports['qb-core']:GetCoreObject()` SUCCEEDS and returns a
    -- deprecated compatibility shim. Checked second, every QBox server in the
    -- world would silently run the legacy path.
    {
        name = 'qbx_core',
        jobs = function(src)
            -- GetGroups returns `{ [name] = gradeLevel }` -- already exactly the
            -- shape we normalise to, and it covers ALL held jobs and gangs, not
            -- just the primary pair on PlayerData. It indexes QBX.Players[src]
            -- with no nil-guard and so throws for an unloaded source; the pcall
            -- in server.lua is what makes that a `{}` rather than a crash.
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

    -- Ahead of es_extended deliberately. ND_Core ships an ESX compatibility
    -- layer that registers the `es_extended`/`getSharedObject` export name via a
    -- raw `__cfx_export_...` handler. Resource-name detection does not fall for
    -- that on its own -- GetResourceState('es_extended') is still 'missing' --
    -- but an owner who has both folders present should get the real ND path.
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
            -- `geteverything()`, NOT `getdept(src)`. getdept takes an id but uses
            -- it only as a presence test and then returns the ENTIRE on_duty
            -- table -- so it answers a different question than its name promises,
            -- and reading its result as one player's department is wrong for
            -- every player on the server.
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

-- ── Inventories: "how many of this item does the player have" ────────────────
--
-- Ordered by how widely deployed each is, ox_inventory first. Each returns a
-- NUMBER, never a boolean -- a boolean cannot answer `count = 2`, and an adapter
-- that quietly answers a different question than the one asked is how
-- community_bridge's origen adapter ended up testing `>` instead of `>=` and
-- denying a player holding exactly the one item required.

local inventories = {
    {
        name = 'ox_inventory',
        count = function(src, item)
            -- GetItemCount, not Search. ox_core itself uses GetItemCount, and
            -- the only `Search(src, 'count', …)` call sites in the reference
            -- corpus are qbx_core shims explicitly tagged ---@deprecated.
            -- Fourth argument is `strict` metadata matching; false is what every
            -- in-corpus caller passes, and is what an owner naming a bare item
            -- means.
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

    -- The three below expose only a boolean `HasItem` in the reference corpus --
    -- no count export exists to call. So `count` here is deliberately lossy: it
    -- reports 1 for "has at least the required amount" and 0 otherwise, by
    -- asking the question the inventory can actually answer.
    --
    -- That makes `count = 1` exact and `count = N` correct-but-coarse, and it is
    -- why `count` is threaded through rather than resolved to a number here. It
    -- is better than the alternative these inventories tempt you into: reading
    -- the framework's PlayerData.items instead, which is a DIFFERENT store and
    -- is simply wrong whenever the inventory does not sync back into it.
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
