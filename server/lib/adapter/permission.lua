-- platform permission adapter — arbitrary permission keys, not just tlib.admin.
-- Server-only. Consumers (tRadio zones/NACs, tELS admin gating, etc.) get a
-- single API that resolves to ACE or a registered framework resolver.

if _TLIB_SIDE ~= 'server' then return end

local log = Logger.create('tLib/adapter/permission')

-- server-admin-supplied override. Signature: fn(source:int, key:string) -> bool.
-- When set, takes priority over the ACE check even on FiveM — servers that
-- mix ACE and framework jobs can layer their own logic on top.
local _resolver = nil

function Platform.registerPermissionResolver(fn)
    if type(fn) ~= 'function' then
        error('Platform.registerPermissionResolver expects a function', 2)
    end
    _resolver = fn
end

--- Check whether a player has a given permission key.
---   FiveM (no resolver)   — IsPlayerAceAllowed(source, key)
---   FiveM (with resolver) — resolver(source, key)  (ACE bypassed)
function Platform.hasPermission(source, key)
    if not source or not key then return false end
    if _resolver then
        local ok, allowed = pcall(_resolver, source, key)
        if not ok then
            log(('resolver errored for key %q: %s'):format(key, tostring(allowed)), 2)
            return false
        end
        return allowed == true
    end
    if _TLIB_IS_FIVEM then
        -- Compared against both BOOL representations on purpose. The native is
        -- declared BOOL and normally arrives as a Lua boolean, but a numeric 1 is
        -- a legal marshalling of it -- and `== true` alone would read that as a
        -- denial while plain truthiness would read a numeric 0 as a grant, since
        -- Lua considers 0 true. Spelling out both is the only form that is wrong
        -- in neither direction.
        local result = IsPlayerAceAllowed(tostring(source), key)
        return result == true or result == 1
    end
    return false
end

Platform.export('tLib', 'HasPermission', function(source, key)
    return Platform.hasPermission(source, key)
end)

Platform.export('tLib', 'RegisterPermissionResolver', function(fn)
    Platform.registerPermissionResolver(fn)
end)
