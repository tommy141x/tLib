-- Vehicle occupancy, client half — the local, instant answer.
--
-- The server half gates commands and is the authority. This one exists because
-- the authority is a round trip away and the input layer cannot wait for it:
-- pressing a key the frame you sit down has to do something. So the client
-- computes the same election from natives and acts optimistically; the server
-- refuses anything the client got wrong.
--
--     The CONTROLLER of a vehicle is its driver if a driver is seated, and
--     otherwise its front passenger.
--
-- The state table grew rather than widened: `seat`, `vehicle`, `netId`,
-- `partner` and `isController` stay FRONT-seat only, because consumers use
-- `state.seat ~= nil` as "am I in a seat that operates this thing" and widening
-- it would have handed rear passengers the controls of every consumer at once.
-- The rear tier rides on `tier`, `cabinSeat`, `cabinVehicle`, `cabinNetId`.

local occupancy = {}

occupancy.SEAT_DRIVER = -1
occupancy.SEAT_PASSENGER = 0

occupancy.TIER_DRIVER    = "driver"
occupancy.TIER_PASSENGER = "passenger"
occupancy.TIER_REAR      = "rear"

--- Seat index → tier name; the mirror of the server's `occupancy.seatTier`.
--- @return "driver" | "passenger" | "rear", or nil for anything that is not a
--- seat this module models.
function occupancy.seatTier(seat)
    if type(seat) ~= "number" then return nil end
    if seat == occupancy.SEAT_DRIVER then return occupancy.TIER_DRIVER end
    if seat == occupancy.SEAT_PASSENGER then return occupancy.TIER_PASSENGER end
    if seat >= 1 then return occupancy.TIER_REAR end
    return nil
end

local FRONT_FIELDS = {
    "seat", "vehicle", "netId", "driver", "passenger", "partner", "isController",
}
local CABIN_FIELDS = { "tier", "cabinSeat", "cabinVehicle", "cabinNetId" }

local state = {
    -- Front seats only. Unchanged meaning; nil for a rear passenger.
    seat      = nil, -- -1 | 0 | nil
    vehicle   = nil, -- local entity handle
    netId     = nil,
    driver    = nil, -- server id, or nil for an empty seat / an NPC
    passenger = nil,
    partner   = nil, -- the OTHER front-seat occupant, from our point of view
    isController = false,
    -- Any seat, rear rows included.
    tier         = nil, -- "driver" | "passenger" | "rear" | nil
    cabinSeat    = nil, -- the game's seat index, whatever it is
    cabinVehicle = nil,
    cabinNetId   = nil,
}

local listeners = {}

local function platform()
    return tlib.platform
end

local function emptyState()
    return { seat = nil, vehicle = nil, netId = nil, driver = nil,
        passenger = nil, partner = nil, isController = false,
        tier = nil, cabinSeat = nil, cabinVehicle = nil, cabinNetId = nil }
end

local function copy(s)
    local out = {}
    for i = 1, #FRONT_FIELDS do out[FRONT_FIELDS[i]] = s[FRONT_FIELDS[i]] end
    for i = 1, #CABIN_FIELDS do out[CABIN_FIELDS[i]] = s[CABIN_FIELDS[i]] end
    return out
end

--- The transitions worth announcing. `cabinSeat` and `cabinNetId` are in here so
local function differs(a, b)
    return a.seat ~= b.seat or a.netId ~= b.netId or a.vehicle ~= b.vehicle
        or a.driver ~= b.driver or a.passenger ~= b.passenger
        or a.cabinSeat ~= b.cabinSeat or a.cabinNetId ~= b.cabinNetId
end

--- Re-read the local player's seat and surroundings. Cheap enough to call from
--- @return the current state table (a copy).
function occupancy.poll()
    local p = platform()
    local next_ = emptyState()

    local seat, vehicle, netId = p.getMySeat()
    local tier = occupancy.seatTier(seat)
    if tier ~= nil and vehicle ~= nil then
        next_.tier         = tier
        next_.cabinSeat    = seat
        next_.cabinVehicle = vehicle
        next_.cabinNetId   = netId
    end

    -- Everything below is the FRONT-seat half, and a rear passenger must fall
    if vehicle ~= nil and (tier == occupancy.TIER_DRIVER or tier == occupancy.TIER_PASSENGER) then
        local driver, passenger = p.getFrontSeatServerIds(vehicle)
        local me = p.getMyId()
        next_.seat      = seat
        next_.vehicle   = vehicle
        next_.netId     = netId
        next_.driver    = driver
        next_.passenger = passenger
        -- Spelled out rather than `cond and passenger or driver`: that idiom
        if seat == occupancy.SEAT_DRIVER then
            next_.partner = passenger
        else
            next_.partner = driver
        end
        -- The election, applied to ourselves. A passenger is the controller only
        local controller = driver or passenger
        next_.isController = (controller ~= nil and controller == me)
    end

    local changed = differs(state, next_)
    state = next_
    if changed then
        local snapshot = copy(state)
        for i = 1, #listeners do listeners[i](snapshot) end
    end
    return copy(state)
end

--- The last polled state, as a copy.
function occupancy.state()
    return copy(state)
end

function occupancy.isFrontSeat()
    return state.seat ~= nil
end

function occupancy.isDriver()
    return state.seat == occupancy.SEAT_DRIVER
end

function occupancy.isPassenger()
    return state.seat == occupancy.SEAT_PASSENGER
end

--- The local player's tier: "driver", "passenger", "rear", or nil on foot.
function occupancy.tier()
    return state.tier
end

--- In ANY seat of any vehicle — the perception question, and the client mirror
function occupancy.isAboard()
    return state.tier ~= nil
end

--- In a rear seat: aboard, and outside the control election by construction.
function occupancy.isRearPassenger()
    return state.tier == occupancy.TIER_REAR
end

--- The vehicle the local player is in, whatever seat it is.
---
--- @return vehicleHandle, netId, seat, tier — or nil when on foot.
function occupancy.cabin()
    if state.cabinVehicle == nil then return nil end
    return state.cabinVehicle, state.cabinNetId, state.cabinSeat, state.tier
end

--- True when the local player's inputs are the ones that take effect for this
--- vehicle. The complement is not "do nothing" — a front passenger who is not
--- the controller still acts, but through the controller rather than directly.
function occupancy.isController()
    return state.isController == true
end

--- The vehicle whose controls this player may be operating.
--- @return vehicleHandle, netId — or nil when not in a front seat. Still nil for
function occupancy.myVehicle()
    if state.vehicle == nil then return nil end
    return state.vehicle, state.netId
end

--- Server ID of the other front-seat occupant, or nil.
function occupancy.partner()
    return state.partner
end

--- Called with the new state whenever seat, vehicle or either front occupant
--- changes. Returns an unsubscribe function.
function occupancy.onChange(fn)
    listeners[#listeners + 1] = fn
    return function()
        for i = 1, #listeners do
            if listeners[i] == fn then
                table.remove(listeners, i)
                return
            end
        end
    end
end

--- Tell the server when this player's seat changes, so its cache knows about
--- them before they have done anything.
---
--- Needed by anything the server sends TO an occupant rather than gates them on:
---
---
function occupancy.startReporting()
    if occupancy._reporting then return end
    occupancy._reporting = true
    occupancy.onChange(function()
        TriggerServerEvent('tlib:occupancy:moved')
    end)
end

--- Opt-in poll thread, for consumers without a main loop of their own.
function occupancy.startSweep(intervalMs)
    if occupancy._sweeping then return end
    occupancy._sweeping = true
    local interval = tonumber(intervalMs) or 250
    CreateThread(function()
        while occupancy._sweeping do
            occupancy.poll()
            Wait(interval)
        end
    end)
end

function occupancy.stopSweep()
    occupancy._sweeping = false
end

return occupancy
