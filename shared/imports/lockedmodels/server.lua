--[[
    tLib/shared/imports/lockedmodels — vehicles a server refuses to re-configure.

    Usage, in a resource's per-model save path:

        if tlib.lockedmodels.isLocked(model) then
            -- keep the stored entry, drop the incoming one
        end

     What this is for

    A reference build on a public or test server. The two Matrix vehicles are
    set up exactly as they should be demonstrated, and a visitor who drags the
    radar off the dashboard or clears the lightbar config has broken the thing
    everyone else came to look at. Every OTHER vehicle stays editable, which is
    the point: this is narrower than demo mode and composes with it.

     Why a convar and not a data file

    Because it is a property of the SERVER, not of the build. The same tree is
    editable on a developer machine and locked on the test box, and a convar is
    the one piece of configuration that cannot travel inside a release -- the
    same reasoning `demo` already states. `tlib_locked_models` unset is the
    normal case and locks nothing, so a customer is never affected by a switch
    they did not set.

        set tlib_locked_models "18charger21tr,fpiu21tr"

     The security property

    The set is snapshotted ONCE, here, from the convar -- never from a payload.
    A client cannot unlock a vehicle by sending `locked = false`, and cannot
    lock someone else's by sending `true`. Changing the set means editing
    server.cfg and restarting, which is the right bar for something only the
    operator should decide. tELS reached the same conclusion independently for
    its own `"locked": true` flag (server/sv_configs.lua), which predates this
    and stays as it is: it is already correct and already shipped.

     Name or hash

    Consumers disagree about what a "model" is, and both are right for their own
    storage. tELS keys configs by NAME (`18charger21tr`); tUnit keys elements by
    the model HASH as a string, because that is what the client has in hand.
    So the snapshot holds both forms and `isLocked` accepts either, rather than
    making every caller remember which it has.

    Server-only: a client's copy of this would be presentation, and a gate that
    runs on the client is not a gate.
]]

local LockedModels = {}

local CONVAR = 'tlib_locked_models'

--- name -> true, plus hash-as-string -> true for the same model.
local locked = {}
local names = {}

--- Build the set once, at load.
---
--- `GetHashKey` is called here rather than per lookup: it is cheap but the
--- lookup sits in a save path, and a table read is cheaper than a native call.
local function snapshot()
    local raw = type(GetConvar) == 'function' and GetConvar(CONVAR, '') or ''
    if raw == nil or raw == '' then return end

    for entry in tostring(raw):gmatch('[^,%s]+') do
        local name = entry:lower()
        locked[name] = true
        names[#names + 1] = name
        if type(GetHashKey) == 'function' then
            -- Both signed and unsigned: FiveM hands a model hash back in either
            -- form depending on the native, and a consumer that stored the other
            -- one would miss the match for no reason it could ever diagnose.
            local hash = GetHashKey(name)
            locked[tostring(hash)] = true
            if hash < 0 then locked[tostring(hash + 0x100000000)] = true end
        end
    end
end

snapshot()

--- Is this vehicle read-only on this server?
---
--- @param model string|number  a model name, or a model hash in either form
--- @return boolean
function LockedModels.isLocked(model)
    if model == nil then return false end
    local key = type(model) == 'string' and model:lower() or tostring(model)
    return locked[key] == true
end

--- The configured names, for a diagnostic line. A copy: a caller that mutated
--- the real table would quietly unlock a vehicle.
--- @return string[]
function LockedModels.list()
    local out = {}
    for i = 1, #names do out[i] = names[i] end
    return out
end

--- Is anything locked at all? Lets a caller skip work, and lets a diagnostic
--- say "nothing is locked" rather than printing an empty list.
--- @return boolean
function LockedModels.any()
    return #names > 0
end

--- Rebuild the set from the convar. For tests only: the whole security property
--- is that the live set is not reachable from a payload, and a resource calling
--- this at runtime would be handing that away.
function LockedModels.__resnapshotForTests()
    locked, names = {}, {}
    snapshot()
end

return LockedModels
