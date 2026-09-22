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

function platform.doesEntityExist(entity)
    if not entity or entity == 0 then return false end
    return DoesEntityExist(entity) == true
end

--- Server-side nearby-player lookup. Uses squared distance to skip sqrt.
--- Consumers that need high-frequency queries should cache coords themselves;
--- this call iterates GetPlayers() on every invocation.
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
