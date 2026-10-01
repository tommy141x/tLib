--[[
    tLib/shared/imports/permission — admin and permission checks for consumer resources.

    Usage in a consumer (server scripts):
        if not tlib.permission.isAdmin(src) then return end
        if tlib.permission.has(src, Config.acePermission) then ... end

    Why this exists
    ---------------
    Four resources hand-rolled these, three different ways, and the copies had
    drifted from tLib's own rule in two places:

      * the fallback checked only `tlib.admin`, so a player holding only
        `tlib.superadmin` was an admin to tLib and not to the resource;
      * it tested `IsPlayerAceAllowed(...) == true`, which reads a numeric 1 as a
        denial. server/lib/adapter/permission.lua documents why the native can
        arrive as either, and accepts both.

    Two checks, deliberately different
    ----------------------------------
    isAdmin / level are answered HERE, in the consumer's VM. tLib's own admin rule
    (server/sv_permission.lua) is pure ACE with no resolver, so the same answer
    needs no round trip -- and so there is no "tLib is not ready yet" window to
    fall back through, which is what the consumers' retry chains existed for.
    If sv_permission.lua ever grows resolver support, this must change with it.

    has(src, key) goes THROUGH tLib, because arbitrary keys may be answered by a
    framework resolver registered with tLib (Platform.registerPermissionResolver),
    which lives in tLib's VM and is invisible from here. When tLib cannot answer,
    it returns false: a resolver takes priority over ACE, so falling back to ACE
    could grant what the resolver denies.
]]

local Permission = {}

local ADMIN      = 'tlib.admin'
local SUPERADMIN = 'tlib.superadmin'

-- Same comparison as server/lib/adapter/permission.lua: BOOL may marshal as 1.
local function aceAllowed(src, key)
    local ok, result = pcall(IsPlayerAceAllowed, tostring(src), key)
    return ok and (result == true or result == 1)
end

--- 0 = none, 1 = admin, 2 = superadmin. The rule in server/sv_permission.lua.
--- @param src number|string
--- @return integer
function Permission.level(src)
    if src == nil then return 0 end
    -- Demo mode has to be answered here as well as in tLib's VM, precisely
    -- because of the round trip this function avoids: the header above explains
    -- that `level` is computed locally from ACE and never asks tLib. That makes
    -- it the one admin check tLib's own override cannot reach, so it carries its
    -- own. `has()` below needs no such line -- it does ask tLib.
    if tlib.demo.active() then return 2 end
    if aceAllowed(src, SUPERADMIN) then return 2 end
    if aceAllowed(src, ADMIN) then return 1 end
    return 0
end

--- True for admins and superadmins -- the same answer as exports.tLib:IsPlayerAdmin.
--- @param src number|string
--- @return boolean
function Permission.isAdmin(src)
    return Permission.level(src) >= 1
end

--- Any permission key, resolved by tLib (ACE, or a registered framework resolver).
--- Fails closed when tLib cannot answer.
--- @param src number|string
--- @param key string
--- @return boolean
function Permission.has(src, key)
    if src == nil or type(key) ~= 'string' or key == '' then return false end
    local tLibName = (type(tlib) == 'table' and tlib.name) or 'tLib'
    local ok, allowed = pcall(function()
        return exports[tLibName]:HasPermission(src, key)
    end)
    return ok and allowed == true
end

--- Batch sibling of has(): one export round trip for a whole key list.
---
--- A SIBLING OF has(), not of level(). It goes THROUGH tLib for exactly the
--- reason the header gives: arbitrary keys may be answered by a framework
--- resolver that lives in tLib's VM and is invisible from here. Do not
--- "optimise" this into a local IsPlayerAceAllowed loop -- that is faster and
--- wrong, because it would grant every key the resolver denies. The only thing
--- this saves over looping has() is the number of round trips.
---
--- Same key -> boolean map in every path, so callers never branch on which path
--- ran. Guards mirror has(): a nil src or a non-table `keys` is an empty map, a
--- non-string or empty entry gets no entry at all, and a duplicated key is asked
--- once. Every missing entry reads back as nil, i.e. falsy, i.e. denied.
---
--- @param src number|string
--- @param keys string[]
--- @return table<string, boolean>
function Permission.hasBatch(src, keys)
    if src == nil or type(keys) ~= 'table' then return {} end
    local tLibName = (type(tlib) == 'table' and tlib.name) or 'tLib'

    local ok, result = pcall(function()
        return exports[tLibName]:HasPermissionBatch(src, keys)
    end)
    if ok and type(result) == 'table' then
        local out = {}
        for i = 1, #keys do
            local key = keys[i]
            if type(key) == 'string' and key ~= '' then
                -- `== true` not truthiness: anything else crossing the resource
                -- boundary is not a grant. Same rule as has() above.
                out[key] = result[key] == true
            end
        end
        return out
    end

    -- DELIBERATE FALLBACK, not an accident of the pcall above.
    --
    -- A consumer resource can be NEWER than the tLib installed next to it, and
    -- this file is loaded out of the INSTALLED tLib at runtime -- but the export
    -- it calls lives in tLib's own VM, which may predate HasPermissionBatch. A
    -- missing export RAISES ("No such export HasPermissionBatch in resource
    -- tLib"), which is what the pcall catches. So does a tLib that answers with
    -- something other than a table.
    --
    -- Looping has() is the same answer by the same route (still through tLib,
    -- still resolver-aware) at the old cost of one export call per key. Only the
    -- speed is lost, never the correctness -- which is why this is a fallback and
    -- not a hard error.
    local out = {}
    for i = 1, #keys do
        local key = keys[i]
        if type(key) == 'string' and key ~= '' and out[key] == nil then
            out[key] = Permission.has(src, key)
        end
    end
    return out
end

return Permission
