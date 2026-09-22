-- cached coord index rebuilt every REFRESH_MS on both server and client.
--
-- The cached counterpart to tlib.platform.getNearbyPlayers, which iterates
-- every player on every call and says so. Anything querying at audio rates
-- wants this one.

local spatial = {}

local isServer = IsDuplicityVersion()

local index = {}
local lastUpdate = 0
local REFRESH_MS = 100
local ready = false

-- Resolved lazily rather than at load: a shared script can be loaded before
-- tlib's import system has finished initialising on the other side.
local function platform()
    return tlib.platform
end

local function rebuildIndex()
    if not ready then return end

    local p = platform()
    local now = p.now()
    if (now - lastUpdate) < REFRESH_MS then return end
    lastUpdate = now

    index = {}
    local players = p.getPlayers()
    if type(players) ~= "table" then return end
    for _, pid in ipairs(players) do
        -- getPlayerCoords is already pcall-guarded and nil-safe for a source
        -- that disconnected between enumeration and lookup.
        local coords = p.getPlayerCoords(tonumber(pid) or pid)
        if coords then
            index[tonumber(pid)] = coords
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

local clientIndex = {}
local clientLastUpdate = 0

local function rebuildClientIndex()
    local now = GetGameTimer()
    if (now - clientLastUpdate) < REFRESH_MS then return end
    clientLastUpdate = now

    clientIndex = {}
    local players = GetActivePlayers()
    for _, pid in ipairs(players) do
        local ped = GetPlayerPed(pid)
        if DoesEntityExist(ped) then
            local pc = GetEntityCoords(ped)
            clientIndex[#clientIndex + 1] = { serverId = GetPlayerServerId(pid), coords = pc }
        end
    end
end

local function nearbyClient(coords, radius)
    rebuildClientIndex()

    local result = {}
    local rSq = radius * radius

    for _, entry in ipairs(clientIndex) do
        local pc = entry.coords
        local dx = coords.x - pc.x
        local dy = coords.y - pc.y
        local dz = coords.z - pc.z
        if dx * dx + dy * dy + dz * dz <= rSq then
            result[#result + 1] = entry.serverId
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
    clientIndex = {}
end

AddEventHandler("onResourceStop", function(resourceName)
    if resourceName == GetCurrentResourceName() then spatial.clear() end
end)

return spatial
