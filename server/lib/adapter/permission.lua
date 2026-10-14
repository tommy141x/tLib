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

-- The whole per-key decision, in ONE place. Both entry points below call this and
-- neither carries a second copy of the rule: hasPermission and hasPermissionBatch
-- have to agree key-for-key, and a reimplementation in the batch path is exactly
-- how they would quietly stop agreeing.
--
-- `demoActive` and `resolver` are passed in rather than read here so a batch
-- samples them ONCE for the whole list. Reading them per key would let a demo
-- toggle or a resolver registration land mid-list and answer half of one key set
-- under one rule and half under another.
local function decidePermission(source, key, demoActive, resolver)
    -- Demo mode grants every key, ahead of the resolver as well as ACE: a
    -- framework resolver that says no would otherwise keep a demo visitor out of
    -- exactly the job-gated features the demo exists to show. `Demo` is a global
    -- set by server/sv_demo.lua, which loads after this file -- fine, because
    -- the callers read it at call time, not at load time.
    if demoActive then return true end
    if resolver then
        local ok, allowed = pcall(resolver, source, key)
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

--- Check whether a player has a given permission key.
---   FiveM (no resolver)   — IsPlayerAceAllowed(source, key)
---   FiveM (with resolver) — resolver(source, key)  (ACE bypassed)
function Platform.hasPermission(source, key)
    if not source or not key then return false end
    return decidePermission(source, key, Demo and Demo.active(), _resolver)
end

--- Batch form of Platform.hasPermission: resolve a whole key list in one call.
---
--- Exists because the caller's cost is the cross-resource export round trip, not
--- the decision. tRadio's resolveAcePermissions asks 40+ keys per cache miss per
--- player; as 40+ reference calls that was ~5 ms of the frame, and the keys were
--- always known up front.
---
--- Per-key answers are IDENTICAL to Platform.hasPermission -- same helper, same
--- demo short-circuit, same resolver priority, same BOOL 1/true normalisation.
---
--- Contract for the awkward inputs, all failing closed and all mirroring the
--- single-key guard (`not source` / `type(key) ~= 'string' or key == ''`):
---   * no source, or `keys` not a table -> an EMPTY map. Every lookup against it
---     is nil, which is falsy, so a caller that forgot to check gets denials.
---   * a duplicated key is decided ONCE and appears once.
---   * a non-string or empty-string entry is skipped and gets NO map entry -- it
---     has no usable key to file an answer under. Reading it back yields nil,
---     i.e. a denial.
---   * a resolver that errors for one key denies THAT key only; the rest of the
---     list is still answered (see decidePermission's pcall).
---
--- @param source number|string
--- @param keys string[]
--- @return table<string, boolean>
function Platform.hasPermissionBatch(source, keys)
    local out = {}
    if not source or type(keys) ~= 'table' then return out end
    -- Sampled once for the whole list -- see decidePermission.
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

-- Additive. HasPermission above is unchanged and still the only thing tELS,
-- tRadar and the rest call; a consumer that does not know about the batch export
-- is not affected by it. There is NO fallback for a consumer that does: this
-- export and shared/imports/permission/server.lua's `hasBatch` ship in the same
-- tLib, so they cannot disagree about whether it exists. `hasBatch` fails CLOSED
-- if this export does not answer.
Platform.export('tLib', 'HasPermissionBatch', function(source, keys)
    return Platform.hasPermissionBatch(source, keys)
end)

Platform.export('tLib', 'RegisterPermissionResolver', function(fn)
    Platform.registerPermissionResolver(fn)
end)
