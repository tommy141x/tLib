-- Platform adapter for consumer resource VMs. tLib's own VM has an equivalent
-- surface in shared/lib/adapter/; the two are separate copies because a consumer's
-- natives must be invoked from the consumer's VM, not through a tLib export.

if type(GetCurrentResourceName) ~= "function" or type(IsDuplicityVersion) ~= "function" then
    error("[tLib] Unsupported runtime: only the FiveM platform adapter is available", 0)
end

local platform = { _engine = "fivem" }

function platform.isServer()
    return IsDuplicityVersion()
end

function platform.now()
    return GetGameTimer()
end

function platform.getPlayers()
    return GetPlayers()
end

function platform.getPlayerName(source)
    if not source or source <= 0 then return nil end
    local name = GetPlayerName(source)
    if not name or name == "" then return nil end
    return name
end

-- pcall-guarded: GetPlayerPed on a disconnected source throws.
function platform.getPlayerPed(source)
    if not source or source <= 0 then return nil end
    local ok, ped = pcall(GetPlayerPed, source)
    if not ok or not ped or ped == 0 then return nil end
    return ped
end

function platform.getPlayerCoords(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    local ok, c = pcall(GetEntityCoords, ped)
    if not ok or not c then return nil end
    return c
end

--- Returns the network ID of the vehicle the player's ped is currently in,
--- or nil. Server-side vehicle access requires OneSync.
function platform.getPlayerVehicleNetId(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    local ok, veh = pcall(GetVehiclePedIsIn, ped)
    if not ok or not veh or veh == 0 then return nil end
    local okNet, netId = pcall(NetworkGetNetworkIdFromEntity, veh)
    if not okNet or not netId or netId == 0 then return nil end
    return netId
end

--- Highest passenger seat index the seat scan will look at.
---
--- `GetVehicleMaxNumberOfPassengers` is client-only, and there's no
--- server-side equivalent, so a scan can't learn a vehicle's seat count.
--- `GetPedInVehicleSeat` returns 0 both for an empty seat and a seat index
--- the vehicle doesn't have, so the scan can't detect its own end either —
--- it has to be bounded.
---
--- Measured across every `vehiclelayouts*.meta` in the Enhanced install (394
--- entries): the largest is 16 slots (driver + 15 passengers, index 14), a
--- four-way tie led by LAYOUT_BUS; this server's own add-on layouts top out
--- at index 10. Counting seat bones instead gives 17 on the bus and would be
--- wrong — `seat_dside_r7` exists on the model but no layout references it.
---
--- 16 is an empirical bound, not an engine limit — raise it if a layout with
--- more slots ever appears; nothing downstream assumes a row count.
platform.MAX_SEAT_INDEX = 16

--- The FRONT seat a player occupies, and the vehicle it belongs to.
---
--- Deliberately collapses to -1/0 only — a rear seat reads as nil, same as
--- being on foot — because this answers the CONTROL question, which has only
--- ever had two candidates. `getPlayerSeat` below does the same read without
--- the collapse, for the perception question. Seat comes from the host,
--- never the caller, so a client can't assert its way into a seat it isn't in.
--- @return seat, netId — or nil.
function platform.getPlayerFrontSeat(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    local ok, veh = pcall(GetVehiclePedIsIn, ped)
    if not ok or not veh or veh == 0 then return nil end

    local seat = nil
    for _, index in ipairs({ -1, 0 }) do
        local okSeat, occupant = pcall(GetPedInVehicleSeat, veh, index)
        if okSeat and occupant == ped then
            seat = index
            break
        end
    end
    if seat == nil then return nil end

    local okNet, netId = pcall(NetworkGetNetworkIdFromEntity, veh)
    if not okNet or not netId or netId == 0 then return nil end
    return seat, netId
end

--- ANY seat a player occupies, rear rows included, and the vehicle it belongs to.
---
--- Tries -1 and 0 first, so a front-seat occupant — the common case, on the
--- hot gate path — costs exactly what `getPlayerFrontSeat` costs; only
--- someone actually in the back pays for the rest of the sweep. Seat comes
--- from the host, never the caller, so a client can't assert its way into a
--- seat it isn't in.
--- @return seat, netId — or nil.
function platform.getPlayerSeat(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    local ok, veh = pcall(GetVehiclePedIsIn, ped)
    if not ok or not veh or veh == 0 then return nil end

    local seat = nil
    for index = -1, platform.MAX_SEAT_INDEX do
        local okSeat, occupant = pcall(GetPedInVehicleSeat, veh, index)
        if okSeat and occupant == ped then
            seat = index
            break
        end
    end
    if seat == nil then return nil end

    local okNet, netId = pcall(NetworkGetNetworkIdFromEntity, veh)
    if not okNet or not netId or netId == 0 then return nil end
    return seat, netId
end

function platform.resolveNetworkId(netId)
    if not netId or netId == 0 then return nil end
    local ok, ent = pcall(NetworkGetEntityFromNetworkId, netId)
    if not ok or not ent or ent == 0 then return nil end
    return ent
end

function platform.isNetworkIdValid(netId)
    if not netId or netId == 0 then return false end
    local ok, ent = pcall(NetworkGetEntityFromNetworkId, netId)
    return ok and ent ~= nil and ent ~= 0
end

function platform.getEntityCoords(entity)
    if not entity or entity == 0 then return nil end
    if not DoesEntityExist(entity) then return nil end
    local ok, c = pcall(GetEntityCoords, entity)
    if not ok or not c then return nil end
    return c
end

--- Whether a BOOL native said yes. Measured on FiveM Enhanced: every BOOL native
--- reached from Lua here returns the NUMBER 1, not `true`, so `native(...) ==
--- true` is always false. `not not v` is NOT the fix either -- 0 is truthy in
--- Lua -- so both shapes are spelled out.
local function nativeTruth(v)
    if v == true then return true end
    return type(v) == "number" and v ~= 0
end

function platform.doesEntityExist(entity)
    if not entity or entity == 0 then return false end
    return nativeTruth(DoesEntityExist(entity))
end

--- Server-side nearby-player lookup. Uses squared distance to skip sqrt.
function platform.getNearbyPlayers(coords, radius)
    if not coords or not radius then return {} end
    local radiusSq = radius * radius
    local out = {}
    local players = GetPlayers()
    for i = 1, #players do
        local pid = players[i]
        local ped = platform.getPlayerPed(pid)
        if ped then
            local c = platform.getEntityCoords(ped)
            if c then
                local dx = coords.x - c.x
                local dy = coords.y - c.y
                local dz = coords.z - c.z
                if (dx * dx + dy * dy + dz * dz) <= radiusSq then
                    out[#out + 1] = tonumber(pid)
                end
            end
        end
    end
    return out
end

function platform.triggerClientEvent(event, target, ...)
    TriggerClientEvent(event, target, ...)
end

function platform.triggerEvent(event, ...)
    TriggerEvent(event, ...)
end

-- The client twin carries the full account of why this is the engine's own
-- mechanism and why `provide 'x'` is not a substitute for it. In short:
-- `provide` fixes GetResourceState and dependency checks, this fixes exports,
-- and a rename needs both.
local _legacyNames = {}
local _published   = {}

local function answerAs(legacyResource, name, fn)
    AddEventHandler(('__cfx_export_%s_%s'):format(legacyResource, name), function(setCb)
        setCb(fn)
    end)
end

--- Also answer exports sent to a resource name this resource used to have.
--- Order-independent with respect to `wrapExport`; see the client twin.
function platform.publishExportsAs(legacyResource)
    if type(legacyResource) ~= "string" or legacyResource == "" then return end
    if _legacyNames[legacyResource] then return end
    _legacyNames[legacyResource] = true
    for name, fn in pairs(_published) do answerAs(legacyResource, name, fn) end
end

-- Now actually wraps — it didn't before, despite the name: a throw inside an
-- export body doesn't cross the FiveM boundary, so ~40 call sites that
-- adopted this as a guard never had one. `resource` is unused for
-- registration, only for the error line. `table.pack`/`unpack` because
-- `ok, reason` is the house shape.
function platform.wrapExport(resource, name, fn)
    local wrapped = function(...)
        local result = table.pack(pcall(fn, ...))
        if result[1] then return table.unpack(result, 2, result.n) end
        -- Printed, not re-raised: re-raising would be invisible to the
        -- caller again. The caller still gets nil as before; now the reason
        -- exists somewhere.
        print(("^1[%s] export '%s' threw: %s^7"):format(resource or "?", name, tostring(result[2])))
        return nil
    end

    exports(name, wrapped)

    -- One function object behind every name, so an alias cannot drift.
    _published[name] = wrapped
    for legacyResource in pairs(_legacyNames) do answerAs(legacyResource, name, wrapped) end
end

return platform
