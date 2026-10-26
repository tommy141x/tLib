-- Platform permission adapter for arbitrary keys, not just tlib.admin. Server-only.
-- Resolves to ACE or a registered framework resolver.

if _TLIB_SIDE ~= 'server' then return end

local log = Logger.create('tLib/adapter/permission')

-- Server-admin override: fn(source:int, key:string) -> bool. Takes priority over
-- ACE even on FiveM, so servers mixing ACE and framework jobs can layer logic.
local _resolver = nil

function Platform.registerPermissionResolver(fn)
    if type(fn) ~= 'function' then
        error('Platform.registerPermissionResolver expects a function', 2)
    end
    _resolver = fn
end

-- Single source of the per-key decision; hasPermission and hasPermissionBatch both
-- call this instead of each carrying their own copy of the rule.
--
-- demoActive/resolver are passed in so a batch samples them ONCE for the whole
-- list, not per key -- otherwise a demo toggle or resolver registration mid-list
-- could answer half the keys under one rule and half under another.
local function decidePermission(source, key, demoActive, resolver)
    -- Demo grants every key ahead of the resolver and ACE, so a framework denial
    -- can't hide the job-gated features demo mode exists to show. `Demo` is set by
    -- sv_demo.lua, which loads after this file -- fine, since it's read at call time.
    if demoActive then return true end
    if resolver then
        local ok, allowed = pcall(resolver, source, key)
        if not ok then
            -- WARN: a throwing resolver denies the key with no other sign why; fix is in the framework bridge.
            log(('resolver errored for key %q: %s'):format(key, tostring(allowed)), 3)
            return false
        end
        return allowed == true
    end
    if _TLIB_IS_FIVEM then
        -- IsPlayerAceAllowed is declared BOOL but a numeric 1 is a legal marshalling;
        -- `== true` alone would miss a 1-grant, plain truthiness would admit a 0-denial.
        local result = IsPlayerAceAllowed(tostring(source), key)
        return result == true or result == 1
    end
    return false
end

--- Check whether a player has a given permission key.
---   FiveM (no resolver)   — IsPlayerAceAllowed(source, key)
---   FiveM (with resolver) — resolver(source, key)  (ACE bypassed)
function Platform.hasPermission(source, key)
    if not source or not key then return false end
    return decidePermission(source, key, Demo and Demo.active(), _resolver)
end

--- Batch form of Platform.hasPermission: resolves a whole key list in one call,
--- since the caller's cost is the cross-resource export round trip, not the
--- decision -- tRadio's resolveAcePermissions asks 40+ keys per cache miss per
--- player, ~5ms as separate reference calls.
---
--- Same per-key logic as hasPermission (demo short-circuit, resolver priority,
--- BOOL 1/true normalisation). Fails closed: no source or non-table `keys` ->
--- empty map (every lookup nil/falsy); duplicate keys decided once; a non-string
--- or empty key gets no map entry (nil on read); a resolver error denies only
--- that key, the rest of the list is still answered.
---
--- @param source number|string
--- @param keys string[]
--- @return table<string, boolean>
function Platform.hasPermissionBatch(source, keys)
    local out = {}
    if not source or type(keys) ~= 'table' then return out end
    local demoActive = Demo and Demo.active()
    local resolver = _resolver
    for i = 1, #keys do
        local key = keys[i]
        if type(key) == 'string' and key ~= '' and out[key] == nil then
            out[key] = decidePermission(source, key, demoActive, resolver)
        end
    end
    return out
end

Platform.export('tLib', 'HasPermission', function(source, key)
    return Platform.hasPermission(source, key)
end)

-- Additive: HasPermission is unchanged, so a consumer unaware of the batch export
-- is unaffected. This export and shared/imports/permission/server.lua's `hasBatch`
-- ship in the same tLib release, so they can't disagree about existing; hasBatch
-- fails closed if this export doesn't answer.
Platform.export('tLib', 'HasPermissionBatch', function(source, keys)
    return Platform.hasPermissionBatch(source, keys)
end)

Platform.export('tLib', 'RegisterPermissionResolver', function(fn)
    Platform.registerPermissionResolver(fn)
end)
