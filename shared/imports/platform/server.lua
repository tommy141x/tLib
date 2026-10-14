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
--- The server has no `GetVehicleMaxNumberOfPassengers` — that native is
--- client-only (0xA7C4F2C6E744A550), and there is no server-side equivalent that
--- reports a vehicle's seat count. `GetPedInVehicleSeat` answers 0 both for an
--- empty seat and for a seat index the vehicle does not have, so a scan cannot
--- discover its own end and has to be bounded.
---
--- MEASURED, not assumed. Every `vehiclelayouts*.meta` in the Enhanced install
--- was counted: 394 layout entries, and the largest is 16 seat slots — driver
--- plus 15 passengers, so the highest live passenger index in the base game is
--- 14. It is a four-way tie between LAYOUT_BUS (bus, airbus),
--- LAYOUT_PLANE_MILJET, LAYOUT_PLANE_TITAN2 and LAYOUT_HELI_CARGOBOB5, and an
--- independent 921-vehicle dump agrees. This server's own add-on layouts
--- (`[vehicles]/[models]/onx-evp-a-shared/data/vehiclelayouts.meta`) top out at
--- 12 slots, index 10.
---
--- Counting seat BONES gives 17 on the bus and would be wrong: `seat_dside_r7`
--- exists on the model and no layout references it.
---
--- 16 therefore clears the measured maximum by two. It is an empirical bound and
--- not an engine limit — no hard cap was found in code, and a third-party layout
--- with more slots is not ruled out. Raise this one constant if one ever appears;
--- nothing downstream assumes a number of rows.
platform.MAX_SEAT_INDEX = 16

--- The FRONT seat a player occupies, and the vehicle it belongs to.
---
--- Only seats -1 (driver) and 0 (front passenger) are reported; a rear seat
--- reads as nil, exactly as a player on foot does. That is deliberate rather
--- than lossy — this is the CONTROL question, and the control election has only
--- ever had two candidates. `getPlayerSeat` below is the same read without the
--- collapse, for the perception question.
---
---
--- The seat is derived from the host, never taken from the caller, so a client
--- cannot assert its way into a seat it is not in.
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
---
--- The scan tries -1 and 0 first, so a front-seat occupant — the common case and
--- the one on the hot gate path — costs exactly the two reads `getPlayerFrontSeat`
--- costs. Only somebody actually in the back pays for the rest of the sweep.
---
---
--- The seat is derived from the host, never taken from the caller, so a client
--- cannot assert its way into a seat it is not in.
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

-- `resource` is accepted for signature symmetry and ignored: `exports(name, fn)`
-- always registers under the calling resource.
function platform.wrapExport(resource, name, fn)
    exports(name, fn)
end

return platform
