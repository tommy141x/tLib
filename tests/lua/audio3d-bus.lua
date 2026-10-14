-- The server half of positional device audio: who gets told, and how often.
--
-- Every rail in this file is here because the payload originates in a NUI, which
-- is a place a player can reach, and because the emitter is a VEHICLE rather than
-- the person who sent the sound.

local now = 10000
local sent = {}          -- { event, target, payload }
local coordsById = {}    -- server id -> coords
local vehicleCoords = { x = 0, y = 0, z = 0 }
local vehicleExists = true
local occupantVehicle = {} -- server id -> netId (nil = on foot)

IsDuplicityVersion = function() return true end
GetCurrentResourceName = function() return 'tRadar' end
AddEventHandler = function() end
TriggerClientEvent = function(event, target, payload)
    sent[#sent + 1] = { event = event, target = target, payload = payload }
end

tlib = {
    platform = {
        now = function() return now end,
        getPlayers = function()
            local ids = {}
            for id in pairs(coordsById) do ids[#ids + 1] = tostring(id) end
            table.sort(ids)
            return ids
        end,
        getPlayerCoords = function(id) return coordsById[tonumber(id)] end,
        resolveNetworkId = function(netId) return netId * 10 end,
        doesEntityExist = function() return vehicleExists end,
        getEntityCoords = function() return vehicleCoords end,
    },
    occupancy = {
        refreshOccupant = function(src) return 0, occupantVehicle[src] end,
        occupantSeatOf = function(src) return 0, occupantVehicle[src] end,
    },
}
-- The bus readies the shared coordinate index itself; the real module is used so
-- this suite exercises the same query path production does.
tlib.spatial = dofile('shared/imports/spatial/shared.lua')

local audio3d = dofile('shared/imports/audio3d/server.lua')

local function reset()
    sent = {}
    tlib.spatial.clear()
    now = now + 1000
end

local function targets()
    local out = {}
    for i, entry in ipairs(sent) do out[i] = entry.target end
    table.sort(out)
    return table.concat(out, ',')
end

local bus = audio3d.createBus({
    event = 'tradar:worldSound',
    range = 25,
    rateBy = 'kind',
    minIntervalMs = 100,
    fields = {
        kind = { type = 'string', max = 16, required = true },
        sound = { type = 'string', max = 48 },
        hz = { type = 'number', min = 0, max = 20000 },
    },
})

-- The payload whitelist

assert(bus:sanitize({ kind = 'alert', sound = 'lock.wav' }) ~= nil,
    'a well-formed payload survives')
assert(bus:sanitize({ kind = 'alert', evil = 'x' }).evil == nil,
    'an undeclared key is dropped rather than forwarded')
assert(bus:sanitize({ sound = 'lock.wav' }) == nil,
    'a missing required field rejects the whole message')
assert(bus:sanitize({ kind = 12 }) == nil, 'a field of the wrong type rejects the message')
assert(bus:sanitize({ kind = string.rep('x', 17) }) == nil, 'an over-long string is rejected')
assert(bus:sanitize({ kind = 'alert', hz = 99999 }) == nil, 'a number past its bound is rejected')
assert(bus:sanitize({ kind = 'alert', hz = 0 / 0 }) == nil, 'NaN is rejected')
assert(bus:sanitize('not a table') == nil, 'a non-table payload is rejected')
-- A rejected field is a rejected MESSAGE. Half a message is not a message.
assert(bus:sanitize({ kind = 'alert', sound = 42 }) == nil,
    'one bad field rejects the message rather than being silently omitted')

-- The emitter is the vehicle

coordsById = { [1] = { x = 0, y = 0, z = 0 }, [2] = { x = 5, y = 0, z = 0 } }
occupantVehicle = {} -- everybody on foot

reset()
assert(bus:emit(1, { kind = 'alert' }) == 0,
    'a sender who is not aboard a vehicle emits nothing — there is no dashboard')
assert(#sent == 0)
assert(bus:stats().notAboard == 1, 'and it is counted as such rather than as a rejection')

-- Fan-out by distance around the vehicle, sender excluded

occupantVehicle = { [1] = 77 }
coordsById = {
    [1] = { x = 0, y = 0, z = 0 },   -- the sender
    [2] = { x = 5, y = 0, z = 0 },   -- close
    [3] = { x = 24, y = 0, z = 0 },  -- just inside
    [4] = { x = 400, y = 0, z = 0 }, -- far away
}
vehicleCoords = { x = 0, y = 0, z = 0 }

reset()
assert(bus:emit(1, { kind = 'alert' }) == 2, 'two receivers: the far one and the sender excluded')
assert(targets() == '2,3', 'the sender never receives their own device')
assert(sent[1].payload.vehicle == 77, 'the vehicle netId travels with the sound')
assert(sent[1].payload.kind == 'alert')
assert(sent[1].event == 'tradar:worldSound', 'on the bus\'s own event name')

-- A vehicle the server cannot resolve is not a fan-out around the origin.
reset()
vehicleExists = false
assert(bus:emit(1, { kind = 'alert' }) == 0, 'a despawned vehicle reaches nobody')
vehicleExists = true

-- The rate limit is per vehicle, partitioned by class

reset()
assert(bus:emit(1, { kind = 'tone' }) > 0, 'first tone goes out')
assert(bus:emit(1, { kind = 'tone' }) == 0, 'a second tone inside the floor is throttled')
-- The whole point of partitioning: a tone retuning ten times a second must not
-- starve the alert that actually matters.
assert(bus:emit(1, { kind = 'alert' }) > 0,
    'a DIFFERENT class in the same window is not throttled by the tone\'s floor')
assert(bus:emit(1, { kind = 'alert' }) == 0, 'but it holds its own floor')

-- Keyed by vehicle, not by player: two officers in one car share one emitter.
occupantVehicle[5] = 77
coordsById[5] = { x = 1, y = 0, z = 0 }
assert(bus:emit(5, { kind = 'tone' }) == 0,
    'the other occupant of the same car cannot take turns to double the rate')

now = now + 200
assert(bus:emit(5, { kind = 'tone' }) > 0, 'past the floor it goes out again')

-- A different vehicle holds its own floor.
occupantVehicle[6] = 88
coordsById[6] = { x = 2, y = 0, z = 0 }
assert(bus:emit(6, { kind = 'tone' }) > 0, 'another car is another emitter')

-- The per-second ceiling bounds the sum of the partitions

local capBus = audio3d.createBus({
    event = 'tradar:capped',
    range = 25,
    rateBy = 'kind',
    minIntervalMs = 0,
    maxPerSecond = 3,
    fields = { kind = { type = 'string', max = 16 } },
})
reset()
local through = 0
for i = 1, 20 do
    -- A fresh class each time, so the per-partition floor never applies. Only
    -- the ceiling can stop this.
    if capBus:emit(1, { kind = 'k' .. i }) > 0 then through = through + 1 end
end
assert(through == 3, 'the per-second ceiling holds across partitions, got ' .. through)

now = now + 1001
assert(capBus:emit(1, { kind = 'after' }) > 0, 'the window slides')

-- The per-broadcast receiver cap keeps the nearest

local capped = audio3d.createBus({
    event = 'tradar:many',
    range = 100,
    minIntervalMs = 0,
    maxReceivers = 3,
    fields = { kind = { type = 'string', max = 16 } },
})
coordsById = { [1] = { x = 0, y = 0, z = 0 } }
for i = 2, 12 do coordsById[i] = { x = i, y = 0, z = 0 } end
reset()
assert(capped:emit(1, { kind = 'alert' }) == 3, 'never more than the cap')
assert(targets() == '2,3,4', 'and it is the nearest three, not an arbitrary three')
assert(capped:stats().capped == 1)

-- Range is clamped, and required

local wide = audio3d.createBus({ event = 'x', range = 100000, fields = {} })
assert(wide:getRange() == audio3d.MAX_RANGE,
    'a mistyped range cannot make one beep an event for every player on the server')
wide:setRange(40)
assert(wide:getRange() == 40)
wide:setRange(0 / 0)
assert(wide:getRange() == 40, 'a malformed range leaves the previous one standing')

assert(not pcall(audio3d.createBus, { event = 'x' }), 'range is required')
assert(not pcall(audio3d.createBus, { range = 10 }), 'event is required')

print('ok')
