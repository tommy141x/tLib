-- Helix server adapter — mirrors fivem_server.lua so consumer code calling
-- tlib.platform:<method> runs unchanged across engines.
--
-- Helix server API surface probed at runtime: identity and coord access go
-- through the same GetPlayerPed / GetEntityCoords natives Helix exposes on
-- the server (see tLib/lua/adapter docs). Anything Helix doesn't ship yet
-- returns nil / empty rather than throwing, so consumer code can feature-test.

local platform = {}

local function safeCall(fn, ...)
    if type(fn) ~= "function" then return nil end
    local args = { ... }
    local ok, result = pcall(function() return fn(table.unpack(args)) end)
    if not ok then return nil end
    return result
end

function platform.isServer()
    return true
end

function platform.now()
    -- Helix Timer API on the server; falls back to os.clock if absent.
    if Timer and type(Timer.GetTime) == "function" then
        return Timer.GetTime()
    end
    return math.floor(os.clock() * 1000)
end

function platform.getPlayers()
    -- Helix GetPlayers returns an array of player controllers; most consumers
    -- want server-IDs, so we normalize.
    if type(GetPlayers) ~= "function" then return {} end
    local list = safeCall(GetPlayers) or {}
    local out = {}
    for i = 1, #list do
        local p = list[i]
        if type(p) == "number" then
            out[i] = tostring(p)
        elseif type(p) == "table" and p.Id then
            out[i] = tostring(p.Id)
        end
    end
    return out
end

function platform.getPlayerName(source)
    if not source or source <= 0 then return nil end
    -- Helix exposes HPlayer.Name on client only; server-side typically needs
    -- a framework-provided getter. Attempt native first, then leave the hole
    -- for a server admin to fill via the consumer's Config.getPlayerName hook.
    if type(GetPlayerName) == "function" then
        local name = safeCall(GetPlayerName, source)
        if name and name ~= "" then return name end
    end
    return nil
end

function platform.getPlayerPed(source)
    if not source or source <= 0 then return nil end
    if type(GetPlayerPed) ~= "function" then return nil end
    local ped = safeCall(GetPlayerPed, source)
    if not ped or ped == 0 then return nil end
    return ped
end

function platform.getPlayerCoords(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    if type(GetEntityCoords) ~= "function" then return nil end
    return safeCall(GetEntityCoords, ped)
end

function platform.getPlayerVehicleNetId(source)
    local ped = platform.getPlayerPed(source)
    if not ped then return nil end
    if type(GetVehiclePedIsIn) ~= "function" then return nil end
    local veh = safeCall(GetVehiclePedIsIn, ped)
    if not veh or veh == 0 then return nil end
    if type(NetworkGetNetworkIdFromEntity) ~= "function" then return nil end
    local netId = safeCall(NetworkGetNetworkIdFromEntity, veh)
    if not netId or netId == 0 then return nil end
    return netId
end

function platform.resolveNetworkId(netId)
    if not netId or netId == 0 then return nil end
    if type(NetworkGetEntityFromNetworkId) ~= "function" then return nil end
    return safeCall(NetworkGetEntityFromNetworkId, netId)
end

function platform.isNetworkIdValid(netId)
    if not netId or netId == 0 then return false end
    if type(NetworkDoesNetworkIdExist) ~= "function" then return false end
    return safeCall(NetworkDoesNetworkIdExist, netId) == true
end

function platform.getEntityCoords(entity)
    if not entity or entity == 0 then return nil end
    if type(GetEntityCoords) ~= "function" then return nil end
    return safeCall(GetEntityCoords, entity)
end

function platform.doesEntityExist(entity)
    if not entity or entity == 0 then return false end
    if type(DoesEntityExist) ~= "function" then return false end
    return safeCall(DoesEntityExist, entity) == true
end

function platform.getNearbyPlayers(coords, radius)
    if not coords or not radius then return {} end
    local radiusSq = radius * radius
    local out = {}
    local players = platform.getPlayers()
    for i = 1, #players do
        local pid = players[i]
        local c = platform.getPlayerCoords(tonumber(pid))
        if c then
            local dx = coords.x - c.x
            local dy = coords.y - c.y
            local dz = coords.z - c.z
            if (dx * dx + dy * dy + dz * dz) <= radiusSq then
                out[#out + 1] = tonumber(pid)
            end
        end
    end
    return out
end

function platform.triggerClientEvent(event, target, ...)
    if TriggerClientEvent then TriggerClientEvent(event, target, ...) end
end

function platform.triggerEvent(event, ...)
    if TriggerEvent then TriggerEvent(event, ...) end
end

-- Helix `exports()` takes (resource, name, fn). The `resource` arg matters
-- here because a Helix package may register exports on behalf of itself and
-- tLib's shim system prefers the explicit form. Callers supply the correct
-- resource name; if omitted, default to the current package.
function platform.wrapExport(resource, name, fn)
    local pkg = resource or _G.__PackageName or safeCall(GetCurrentResourceName)
    if type(exports) == 'function' then
        pcall(exports, pkg, name, fn)
    end
end

return platform
