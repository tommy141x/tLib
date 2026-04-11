-- server: cached coord index rebuilt every N ms. client: direct GetActivePlayers.

local spatial = {}

local isServer = IsDuplicityVersion()

local index = {}
local lastUpdate = 0
local REFRESH_MS = 100
local ready = false

local function rebuildIndex()
    if not ready then return end

    local now = GetGameTimer()
    if (now - lastUpdate) < REFRESH_MS then return end
    lastUpdate = now

    index = {}
    local players = GetPlayers()
    for _, pid in ipairs(players) do
        local ok, ped = pcall(GetPlayerPed, pid)
        if ok and ped and DoesEntityExist(ped) then
            local ok2, coords = pcall(GetEntityCoords, ped)
            if ok2 and coords then
                index[tonumber(pid)] = coords
            end
        end
    end
end

local function nearbyServer(coords, radius)
    rebuildIndex()

    local result = {}
    local rSq = radius * radius

    for pid, pc in pairs(index) do
        local dx = coords.x - pc.x
        local dy = coords.y - pc.y
        local dz = coords.z - pc.z
        if dx * dx + dy * dy + dz * dz <= rSq then
            result[#result + 1] = pid
        end
    end

    return result
end

local function nearbyClient(coords, radius)
    local result = {}
    local players = GetActivePlayers()
    local rSq = radius * radius

    for _, pid in ipairs(players) do
        local ped = GetPlayerPed(pid)
        if DoesEntityExist(ped) then
            local pc = GetEntityCoords(ped)
            local dx = coords.x - pc.x
            local dy = coords.y - pc.y
            local dz = coords.z - pc.z
            if dx * dx + dy * dy + dz * dz <= rSq then
                result[#result + 1] = GetPlayerServerId(pid)
            end
        end
    end

    return result
end

-- returns array of server IDs
function spatial.getNearbyPlayers(coords, radius)
    if isServer then
        return nearbyServer(coords, radius)
    else
        return nearbyClient(coords, radius)
    end
end

-- call after first tick so server natives are available
function spatial.setReady()
    ready = true
end

function spatial.setRefreshRate(ms)
    REFRESH_MS = ms
end

function spatial.clear()
    index = {}
end

return spatial
