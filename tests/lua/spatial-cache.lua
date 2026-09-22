-- The cached nearby-player index. tRadio's speaker and 3D-audio paths query
-- this at audio rates, so the refresh gate and the readiness gate both matter:
-- rebuilding per call would iterate every player per broadcast, and building
-- before the host has finished loading indexes a half-initialised server.

-- Not 0: lastUpdate starts at 0, so a timer reading of exactly 0 would sit
-- inside the refresh window and suppress the first build. GetGameTimer is well
-- past 0 by the time any resource queries this.
local now = 5000
local coordsById = {}
local rebuilds = 0

IsDuplicityVersion = function() return true end
GetCurrentResourceName = function() return 'tRadio' end
AddEventHandler = function() end
tlib = {
    platform = {
        now = function() return now end,
        getPlayers = function()
            rebuilds = rebuilds + 1
            local ids = {}
            for id in pairs(coordsById) do ids[#ids + 1] = tostring(id) end
            table.sort(ids)
            return ids
        end,
        getPlayerCoords = function(id) return coordsById[tonumber(id)] end,
    },
}

local spatial = dofile('shared/imports/spatial/shared.lua')

local function ids(list)
    local out = {}
    for index, id in ipairs(list) do out[index] = id end
    table.sort(out)
    return table.concat(out, ',')
end

coordsById = {
    [1] = { x = 0, y = 0, z = 0 },
    [2] = { x = 5, y = 0, z = 0 },
    [3] = { x = 100, y = 0, z = 0 },
}

-- Nothing is indexed until the host declares itself ready.
assert(#spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10) == 0,
    'an unready index reports nobody rather than building from a half-loaded host')
assert(rebuilds == 0, 'an unready index does not touch the host at all')

spatial.setReady()

assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10)) == '1,2',
    'players inside the radius are returned as numbers, the far one excluded')
assert(rebuilds == 1)

-- Radius is inclusive and measured in three dimensions.
assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 5)) == '1,2',
    'a player exactly on the radius is inside it')
assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 4 }, 5)) == '1',
    'height counts toward the distance')

-- Within the refresh window the index is reused, however often it is queried.
coordsById[3] = { x = 1, y = 0, z = 0 }
assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10)) == '1,2',
    'a move inside the refresh window is not picked up yet')
assert(rebuilds == 1, 'repeat queries inside the window do not re-enumerate players')

now = now + 100
assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10)) == '1,2,3',
    'the move is picked up once the refresh interval has elapsed')
assert(rebuilds == 2, 'exactly one rebuild per elapsed interval')

-- A player who disconnects between enumeration and lookup is skipped, not fatal.
coordsById[2] = nil
now = now + 100
assert(ids(spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10)) == '1,3',
    'a source with no coords drops out of the index')

spatial.clear()
assert(#spatial.getNearbyPlayers({ x = 0, y = 0, z = 0 }, 10) == 0,
    'clear empties the index without waiting for the next refresh')

print('PASS: spatial cache gates on readiness, honours its refresh window and survives disconnects')
