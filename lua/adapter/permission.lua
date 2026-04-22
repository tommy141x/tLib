-- platform permission adapter — arbitrary permission keys, not just tlib.admin.
-- Server-only. Consumers (tRadio zones/NACs, tELS admin gating, etc.) get a
-- single API that resolves to ACE on FiveM and to a registerable resolver on
-- Helix / QBCore / ESX.

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
---   Helix                 — resolver(source, key)  or false if none
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
        return IsPlayerAceAllowed(tostring(source), key) == true
    end
    return false
end

Platform.export('tLib', 'HasPermission', function(source, key)
    return Platform.hasPermission(source, key)
end)

Platform.export('tLib', 'RegisterPermissionResolver', function(fn)
    Platform.registerPermissionResolver(fn)
end)
