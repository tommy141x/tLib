--[[
    tLib/shared/imports/lockedmodels — vehicles a server refuses to re-configure.
    For a reference build (e.g. the two Matrix vehicles) where every OTHER
    vehicle should stay editable; narrower than demo mode and composes with it.

        if tlib.lockedmodels.isLocked(model) then -- keep stored, drop incoming

    A convar, not a data file, because it's a property of the SERVER, not the
    build: `set tlib_locked_models "18charger21tr,fpiu21tr"`. Unset locks
    nothing. The set is snapshotted ONCE here, never from a payload, so a
    client cannot lock/unlock by sending a flag — changing it needs editing
    server.cfg and a restart. (tLS's own `"locked": true` flag in
    server/sv_configs.lua predates this and stays as-is.)

    Consumers key models differently — tLS by NAME, tUnit by HASH-as-string —
    so the snapshot holds both forms and `isLocked` accepts either.
    Server-only: a client-side gate is not a gate.
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
