-- Vehicle occupancy — who is aboard a vehicle, in which tier, and which of them
-- is allowed to act on it. One rule, shared, because three resources answered
-- the question three different ways and tELS let a rear passenger steal the
-- state-bag relay from the driver:
--
--     The CONTROLLER of a vehicle is its driver if a driver is seated, and
--     otherwise its front passenger.
--
--     driver     (seat -1)      perceives, controls
--     passenger  (seat  0)      perceives, controls (when the driver seat is empty)
--     rear       (seat 1..n)    perceives, NEVER controls
--
--     may they CONTROL?    occupancy.isControllerOf  (driver-else-front-passenger)
--     may they PERCEIVE?   occupancy.isAboard        (any seat at all)
--
-- Every GATE re-reads the host, so no gate can ever be stale. The CACHE
-- (`occupantsOf`, `tierOf`, `occupantSeatOf`) is repaired by the client's move
-- ping, rate-limited to 100 ms, so it can briefly name a seat the player has
-- left. That can never grant control, because control is never read from it.
--
-- Loaded into each CONSUMER's VM, so every resource keeps its own cache over the
-- same authoritative natives. Only the rule is shared.

local occupancy = {}

occupancy.SEAT_DRIVER = -1
occupancy.SEAT_PASSENGER = 0

occupancy.TIER_DRIVER    = "driver"
occupancy.TIER_PASSENGER = "passenger"
occupancy.TIER_REAR      = "rear"

-- Seat index → the field it occupies. Doubles as the membership test for
-- "is this a front seat", so a rear seat falls out here rather than at a call site.
local FRONT_KEY = { [-1] = "driver", [0] = "passenger" }

--- Seat index → tier name. The one place an index becomes a tier; a consumer
--- should call this rather than comparing indices itself.
--- @return "driver" | "passenger" | "rear", or nil when the index is not a seat
--- this module models (nil, a non-number, or anything below -1).
function occupancy.seatTier(seat)
    if type(seat) ~= "number" then return nil end
    if seat == occupancy.SEAT_DRIVER then return occupancy.TIER_DRIVER end
    if seat == occupancy.SEAT_PASSENGER then return occupancy.TIER_PASSENGER end
    if seat >= 1 then return occupancy.TIER_REAR end
    return nil
end

-- [netId] = { driver = src, passenger = src, rear = { [seatIndex] = src } }
-- `rear` is always a table, so nothing below has to nil-check it.
local byVehicle = {}
local byPlayer  = {} -- [src] = { seat = n, netId = n, tier = "driver"|"passenger"|"rear" }
local listeners = {}
local cabinListeners = {}

local function platform()
    return tlib.platform
end

local function snapshot(netId)
    local v = byVehicle[netId]
    if not v then return {} end
    return { driver = v.driver, passenger = v.passenger }
end

--- Everyone aboard, in tiers. `rear` is a copy keyed by seat index, so a
--- consumer that mutates what it reads cannot rewrite the live table.
local function cabinSnapshot(netId)
    local v = byVehicle[netId]
    if not v then return { rear = {} } end
    local rear = {}
    for seat, src in pairs(v.rear) do rear[seat] = src end
    return { driver = v.driver, passenger = v.passenger, rear = rear }
end

local function cabinDiffers(a, b)
    if a.driver ~= b.driver or a.passenger ~= b.passenger then return true end
    local ar, br = a.rear or {}, b.rear or {}
    for seat, src in pairs(ar) do if br[seat] ~= src then return true end end
    for seat, src in pairs(br) do if ar[seat] ~= src then return true end end
    return false
end

--- Fire both listener lists for one vehicle.
---
local function announce(netId, prev, prevCabin)
    local nowCabin = cabinSnapshot(netId)
    if cabinDiffers(nowCabin, prevCabin) then
        for i = 1, #cabinListeners do
            cabinListeners[i](netId, cabinSnapshot(netId), prevCabin)
        end
    end
    local now = snapshot(netId)
    if now.driver == prev.driver and now.passenger == prev.passenger then return end
    for i = 1, #listeners do
        listeners[i](netId, snapshot(netId), prev)
    end
end

local function detach(src)
    local cur = byPlayer[src]
    if not cur then return end
    byPlayer[src] = nil
    local v = byVehicle[cur.netId]
    if not v then return end
    local key = FRONT_KEY[cur.seat]
    if key then
        if v[key] == src then v[key] = nil end
    elseif v.rear[cur.seat] == src then
        v.rear[cur.seat] = nil
    end
    if v.driver == nil and v.passenger == nil and next(v.rear) == nil then
        byVehicle[cur.netId] = nil
    end
end

local function attach(src, seat, netId)
    local v = byVehicle[netId]
    if not v then
        v = { rear = {} }
        byVehicle[netId] = v
    end
    local key = FRONT_KEY[seat]
    -- Two players cannot occupy one seat. If our record says otherwise, ours is
    -- the stale half: this one was just read from the host, the other was read
    -- at some earlier tick and nothing has refreshed it since.
    local displaced
    if key then displaced = v[key] else displaced = v.rear[seat] end
    if displaced and displaced ~= src then byPlayer[displaced] = nil end
    if key then v[key] = src else v.rear[seat] = src end
    byPlayer[src] = { seat = seat, netId = netId, tier = occupancy.seatTier(seat) }
end

--- Move a player to a seat (or out of one), announcing every vehicle the move
local function setSeat(src, seat, netId)
    local cur = byPlayer[src]
    local vacating = (seat == nil or netId == nil)
    if cur and not vacating and cur.seat == seat and cur.netId == netId then return end
    if not cur and vacating then return end

    local prev, prevCabin, order = {}, {}, {}
    local function remember(id)
        if id and prev[id] == nil then
            prev[id] = snapshot(id)
            prevCabin[id] = cabinSnapshot(id)
            order[#order + 1] = id
        end
    end
    if cur then remember(cur.netId) end
    if not vacating then remember(netId) end

    detach(src)
    if not vacating then attach(src, seat, netId) end

    for i = 1, #order do announce(order[i], prev[order[i]], prevCabin[order[i]]) end
end

--- Re-read a player's seat from the host and write it to the cache, whatever
--- tier it is. The single point where this module learns anything.
--- @return seat, netId, tier — or nil when they are aboard nothing.
local function readSeat(src)
    local seat, netId = platform().getPlayerSeat(src)
    local tier = occupancy.seatTier(seat)
    if tier ~= nil and netId ~= nil then
        setSeat(src, seat, netId)
    else
        setSeat(src, nil, nil)
    end
    local cur = byPlayer[src]
    if not cur then return nil end
    return cur.seat, cur.netId, cur.tier
end

--- Re-read a player's FRONT seat from the host and update the cache.
---
--- @return seat, netId — or nil when they are not in a front seat.
function occupancy.refresh(src)
    local seat, netId, tier = readSeat(src)
    if tier == nil or tier == occupancy.TIER_REAR then return nil end
    return seat, netId
end

--- Re-read a player's seat from the host, in any tier, and update the cache.
--- The perception-side counterpart to `refresh`.
--- @return seat, netId, tier — or nil when they are aboard nothing.
function occupancy.refreshOccupant(src)
    return readSeat(src)
end

--- Cached FRONT seat for a player. Cheap; may lag the host by one refresh.
---
--- @return seat, netId — or nil.
function occupancy.seatOf(src)
    local cur = byPlayer[src]
    if not cur or cur.tier == occupancy.TIER_REAR then return nil end
    return cur.seat, cur.netId
end

--- Cached seat for a player in ANY tier. Cheap; may lag the host by one refresh
--- or by the move ping's 100 ms rate limit.
--- @return seat, netId, tier — or nil when they are aboard nothing.
function occupancy.occupantSeatOf(src)
    local cur = byPlayer[src]
    if not cur then return nil end
    return cur.seat, cur.netId, cur.tier
end

--- Cached tier for a player: "driver", "passenger", "rear", or nil on foot.
function occupancy.tierOf(src)
    local cur = byPlayer[src]
    if not cur then return nil end
    return cur.tier
end

--- The front-seat occupants of a vehicle, as a copy — a consumer that mutates
--- what it reads must not be able to rewrite this table for every other caller.
function occupancy.frontSeats(netId)
    return snapshot(netId)
end

--- Everyone aboard a vehicle, as a copy: `{ driver, passenger, rear = { [seat] = src } }`.
---
function occupancy.occupantsOf(netId)
    return cabinSnapshot(netId)
end

--- Driver if one is seated, otherwise the front passenger, otherwise nil.
function occupancy.controllerOf(netId)
    local v = byVehicle[netId]
    if not v then return nil end
    return v.driver or v.passenger
end

--- THE GATE. May this player act on this vehicle?
---
function occupancy.isFrontSeat(src, netId)
    local _, actual = occupancy.refresh(src)
    return actual ~= nil and actual == netId
end

--- THE PERCEPTION GATE. Is this player aboard this vehicle at all?
function occupancy.isAboard(src, netId)
    local _, actual = occupancy.refreshOccupant(src)
    return actual ~= nil and actual == netId
end

--- THE OTHER GATE. Is this player the one whose inputs take effect here?
function occupancy.isControllerOf(src, netId)
    local seat, actual = occupancy.refresh(src)
    if actual == nil or actual ~= netId then return false end
    if seat == occupancy.SEAT_DRIVER then return true end

    local v = byVehicle[netId]
    local driver = v and v.driver
    if driver == nil or driver == src then return true end
    occupancy.refresh(driver)
    v = byVehicle[netId]
    return (v == nil or v.driver == nil)
end

local function otherOccupant(netId, seat)
    local v = byVehicle[netId]
    if not v then return nil end
    if seat == occupancy.SEAT_DRIVER then return v.passenger end
    return v.driver
end

--- The OTHER front-seat occupant of this player's vehicle, or nil.
--- @return partnerSrc, netId, seat — netId and seat are nil off a front seat.
function occupancy.partnerOf(src)
    local seat, netId = occupancy.refresh(src)
    if netId == nil then return nil end
    local other = otherOccupant(netId, seat)
    if other == nil then return nil, netId, seat end
    occupancy.refresh(other)
    return otherOccupant(netId, seat), netId, seat
end

--- Everyone ELSE aboard the caller's vehicle, in any tier.
--- @return peers, netId, seat, tier — `peers` is an array of server IDs, empty
--- when they are alone; the rest are nil when the caller is aboard nothing.
function occupancy.peersOf(src)
    local seat, netId, tier = occupancy.refreshOccupant(src)
    if netId == nil then return nil end

    local cabin, candidates = cabinSnapshot(netId), {}
    local function consider(id) if id ~= nil and id ~= src then candidates[#candidates + 1] = id end end
    consider(cabin.driver)
    consider(cabin.passenger)
    for _, id in pairs(cabin.rear) do consider(id) end

    local peers = {}
    for i = 1, #candidates do
        local id = candidates[i]
        local _, actual = occupancy.refreshOccupant(id)
        if actual == netId then peers[#peers + 1] = id end
    end
    return peers, netId, seat, tier
end

--- Forget a player entirely. Called for you on playerDropped; exposed for
--- consumers with their own teardown ordering.
function occupancy.clear(src)
    setSeat(src, nil, nil)
end

local function subscribe(list, fn)
    list[#list + 1] = fn
    return function()
        for i = 1, #list do
            if list[i] == fn then
                table.remove(list, i)
                return
            end
        end
    end
end

--- Called with (netId, seats, previousSeats) whenever a vehicle's FRONT seats
--- change. Rear-seat movement does not wake it — that is `onCabinChange`, and
--- keeping them apart is why an existing subscriber sees exactly the edges it
--- has always seen. Returns an unsubscribe function.
function occupancy.onChange(fn)
    return subscribe(listeners, fn)
end

--- Called with (netId, occupants, previousOccupants) whenever ANY seat of a
--- vehicle changes, rear rows included. Both tables have the shape
--- `occupantsOf` returns. Returns an unsubscribe function.
function occupancy.onCabinChange(fn)
    return subscribe(cabinListeners, fn)
end

--- Opt-in periodic re-read of every tracked player, for consumers that read
--- `frontSeats`/`controllerOf` passively rather than gating on `isFrontSeat`.
--- Deliberately not started by default: a tLib import should not spawn a thread
--- in every resource that happens to load it.
function occupancy.startSweep(intervalMs)
    if occupancy._sweeping then return end
    occupancy._sweeping = true
    local interval = tonumber(intervalMs) or 1000
    CreateThread(function()
        while occupancy._sweeping do
            Wait(interval)
            local tracked = {}
            for src in pairs(byPlayer) do tracked[#tracked + 1] = src end
            -- refreshOccupant, not refresh: both repair the cache identically,
            -- but the sweep exists to keep the cache true and the occupant form
            -- is the one whose name says so.
            for i = 1, #tracked do occupancy.refreshOccupant(tracked[i]) end
        end
    end)
end

function occupancy.stopSweep()
    occupancy._sweeping = false
end

AddEventHandler('playerDropped', function()
    occupancy.clear(source)
end)

-- Discovery
--
-- Everything above learns a player's seat from a question somebody asked about
-- THEM — a gate they were checked against, or a sweep over players already
-- tracked. That is enough to decide whether an action is allowed, and not
-- enough to find a passenger who has not done anything: `partnerOf` would
-- report an empty seat beside a driver until the person in it first pressed
-- something, which is exactly backwards for anything being sent TO them.
--
-- So a client says when it moves. The payload is a hint and nothing more — the
-- seat is re-read from the host here, so a client that lies about where it is
-- sitting gets the truth written into the cache instead.
--
-- One event name for every resource on purpose. Each consumer VM holds its own
-- cache over the same natives, and one ping from a client repairs all of them.
local lastMoved = {} -- [src] = timestamp

RegisterNetEvent('tlib:occupancy:moved', function()
    local src = source
    local now = GetGameTimer()
    if lastMoved[src] and (now - lastMoved[src]) < 100 then return end
    lastMoved[src] = now
    -- refreshOccupant, so a ping from the back seat registers the rear tier
    -- rather than being written down as "on foot". This is the only way a rear
    -- passenger who has done nothing ever enters the cache: no gate asks about
    -- them, because every gate they could reach refuses them.
    occupancy.refreshOccupant(src)
end)

AddEventHandler('playerDropped', function()
    lastMoved[source] = nil
end)

return occupancy
