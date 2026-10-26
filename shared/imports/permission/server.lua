--[[
    tLib/shared/imports/permission — admin and permission checks for consumer resources.

    Usage in a consumer (server scripts):
        if not tlib.permission.isAdmin(src) then return end
        if tlib.permission.has(src, Config.acePermission) then ... end

    Four resources hand-rolled these, three different ways, both drifted from
    tLib's own rule: one fallback checked only `tlib.admin` (so a
    `tlib.superadmin`-only player wasn't admin to the resource), and one
    tested `IsPlayerAceAllowed(...) == true`, which reads a numeric 1 as a
    denial — `server/lib/adapter/permission.lua` accepts both.

    `isAdmin`/`level` are answered HERE, in the consumer's VM, because tLib's
    own admin rule is pure ACE with no resolver — no round trip needed, and no
    "tLib not ready yet" window to retry through. If `sv_permission.lua` ever
    grows resolver support, this must change with it.

    `has(src, key)` goes THROUGH tLib instead, because arbitrary keys may be
    answered by a framework resolver registered with tLib
    (`Platform.registerPermissionResolver`), invisible from here. When tLib
    can't answer, it returns false: a resolver outranks ACE, so falling back
    to ACE could grant what the resolver denies.
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
    -- Demo mode must be answered here too, not just in tLib's VM: level() is
    -- computed locally from ACE and never asks tLib, so it's the one admin
    -- check tLib's own override can't reach. has() needs no such line --
    -- it does ask tLib.
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

--- Batch sibling of has(), not of level(): one export round trip for a whole
--- key list, going THROUGH tLib for the same resolver reason. Do not
--- "optimise" this into a local IsPlayerAceAllowed loop -- that would grant
--- every key a resolver denies. It only saves round trips over looping has().
---
--- Guards mirror has(): a nil src or non-table `keys` is an empty map, a
--- non-string/empty entry gets no entry, a duplicated key is asked once, and
--- any missing entry reads back falsy (denied).
---
--- @param src number|string
--- @param keys string[]
--- @return table<string, boolean>
function Permission.hasBatch(src, keys)
    if src == nil or type(keys) ~= 'table' then return {} end
    local tLibName = (type(tlib) == 'table' and tlib.name) or 'tLib'

    -- Fails closed, no per-key ACE fallback: this module and the
    -- HasPermissionBatch export ship in the same tLib, so they can't
    -- disagree about whether it exists. The pcall stays for the case tLib
    -- doesn't answer at all, which resolves to denial rather than ACE --
    -- a resolver outranks ACE, so falling through could grant what it denies.
    local ok, result = pcall(function()
        return exports[tLibName]:HasPermissionBatch(src, keys)
    end)
    if not ok or type(result) ~= 'table' then return {} end

    local out = {}
    for i = 1, #keys do
        local key = keys[i]
        if type(key) == 'string' and key ~= '' then
            -- `== true` not truthiness: same rule as has() above.
            out[key] = result[key] == true
        end
    end
    return out
end

--- Does this player hold EVERY key in the list? Built on `hasBatch` rather
--- than a loop over `has`, so a four-key gate is still one export round trip.
---
--- An empty list is `true`: nothing was asked, so nothing was refused — a
--- feature whose required-key list is built at registration can legitimately
--- end up empty, and `false` there would deny a gate nobody asked to exist.
---
--- Not a drop-in for raw `IsPlayerAceAllowed` loops: this goes through tLib,
--- where a registered framework resolver OUTRANKS ACE, so a server with a
--- resolver can get a different (and intended) answer here.
---
--- @param src number|string
--- @param keys string[]
--- @return boolean
function Permission.hasAll(src, keys)
    if src == nil or type(keys) ~= 'table' then return false end
    local answers = Permission.hasBatch(src, keys)
    for i = 1, #keys do
        if answers[keys[i]] ~= true then return false end
    end
    return true
end

return Permission
