-- Vehicle occupancy — who is aboard a vehicle, in which tier, and which of them
-- is allowed to act on it.
--
-- Exists because three resources each answered that question separately and all
-- three answered it differently: tELS accepted any seat (so a rear passenger
-- silently stole the state-bag relay from the driver), tRadio accepted the
-- driver only, tRadar never asked because it never left the client. Consumers
-- now share one rule:
--
--     The CONTROLLER of a vehicle is its driver if a driver is seated, and
--     otherwise its front passenger.
--
-- That falls out of how the feature is meant to behave — a driver sitting down
-- takes over — and it makes the lone-passenger case ordinary rather than
-- special. THAT RULE HAS NOT CHANGED AND MUST NOT: the bug this module was
-- written to fix was a rear passenger driving the whole car's lighting from the
-- back seat, and every gate below is still shut against exactly that.
--
-- ── Three tiers, two questions ────────────────────────────────────────────
--
-- The module originally modelled two tiers and collapsed everything else into
-- "not an occupant", so a rear passenger was indistinguishable from a player on
-- foot. That was the right shape for CONTROL and the wrong shape for everything
-- a rear passenger is meant to see and hear. There are now three tiers:
--
--     driver     (seat -1)      perceives, controls
--     passenger  (seat  0)      perceives, controls (when the driver seat is empty)
--     rear       (seat 1..n)    perceives, NEVER controls
--
-- and they answer two separate questions, which is the whole point of naming
-- them:
--
--     may they CONTROL?    occupancy.isControllerOf  (driver-else-front-passenger)
--     may they PERCEIVE?   occupancy.isAboard        (any seat at all)
--
-- `isFrontSeat` sits between the two and is unchanged: it is the "may they act
-- on this vehicle" gate, and a rear passenger still fails it. A rear passenger
-- gains addressability and nothing else.
--
-- ── Seats, not rows ───────────────────────────────────────────────────────
--
-- Rear seats are indices 1 upwards, in the vehicle's own layout order, and
-- nothing here caps them at one row. A van's seat 4 and a bus's seat 14 are
-- both `rear`; they are stored under their own indices so a consumer that cares
-- which seat somebody is in can still tell, and no code below counts rows.
--
-- ── Staleness ─────────────────────────────────────────────────────────────
--
-- Every GATE (`isFrontSeat`, `isControllerOf`, `isAboard`) re-reads the host, so
-- no gate can ever be stale. The CACHE (`occupantsOf`, `tierOf`,
-- `occupantSeatOf`) is repaired by the client's move ping, which is rate-limited
-- to 100 ms per player — so for up to that long after a seat change the cache
-- can name a tier the player has already left. Two consequences worth stating:
-- a player who moves rear->front twice inside 100 ms is cached at the FIRST of
-- those seats until the next ping or sweep, and a fresh rear occupant can be
-- missing from `occupantsOf` for that window. Neither can grant control,
-- because control is never read from the cache.
--
-- Loaded into each CONSUMER's VM like every tLib import, so every resource keeps
-- its own cache over the same authoritative natives. Nothing is shared between
-- resources at runtime; only the rule is.

local occupancy = {}

occupancy.SEAT_DRIVER = -1
occupancy.SEAT_PASSENGER = 0

-- The tier names, as constants rather than bare strings, so a consumer compares
-- against something that fails loudly when it is misspelt.
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

-- Resolved lazily rather than at load: a shared script can be loaded before
-- tlib's import system has finished initialising on the other side.
local function platform()
    return tlib.platform
end

--- The two front seats, as they have always been reported. Deliberately still
--- front-only: `frontSeats` is published API and a consumer reading `.driver`
--- and `.passenger` must not start finding a third key it does not handle.
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
--- They are separate lists on purpose. `onChange` has always meant "the front
--- seats of this vehicle changed" and consumers act on its edges; waking them
--- because somebody shuffled between two rear seats would be a behaviour change
--- dressed up as a notification. `onCabinChange` is the superset.
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
    -- Spelled out rather than `key and v[key] or v.rear[seat]`: that idiom reads
    -- the rear table whenever a front seat is merely EMPTY, which is the same
    -- nil-can't-be-a-truthy-branch trap `otherOccupant` is spelled out to avoid.
    local displaced
    if key then displaced = v[key] else displaced = v.rear[seat] end
    if displaced and displaced ~= src then byPlayer[displaced] = nil end
    if key then v[key] = src else v.rear[seat] = src end
    byPlayer[src] = { seat = seat, netId = netId, tier = occupancy.seatTier(seat) }
end

--- Move a player to a seat (or out of one), announcing every vehicle the move
--- touched. Both vehicles are snapshotted before anything mutates, so a player
--- stepping from one car straight into another reports two truthful changes
--- rather than one change against an already-modified table.
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
--- The cache learns their real seat either way — a rear passenger who is refused
--- here is still recorded as being in the back — but the ANSWER is front-only,
--- unchanged since this module was written. `isFrontSeat`, `isControllerOf` and
--- `partnerOf` are all built on that answer, and a rear seat reading as nil here
--- is what keeps a rear passenger out of all three.
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
--- Still front-only: a rear passenger reads as nil here exactly as they always
--- have, so a caller that treats a non-nil answer as "may act" keeps being
--- right. `occupantSeatOf` is the same read without the collapse.
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
--- `rear` is keyed by the game's seat index, not packed into a list, because the
--- index is the only thing that distinguishes seat 1 from seat 14 and a consumer
--- that wants to address one row of a bus has no other way to ask. It is always
--- a table, empty when nobody is in the back.
---
--- Cached, like `frontSeats`. Nothing here is a permission — see `isAboard`.
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
--- Reads the host rather than the cache, because a cache is not a permission:
--- a command that arrives after the player stepped out has to be refused even
--- though nothing has swept yet. It costs one seat read, and it is called on
--- discrete actions rather than per frame. The read repairs the cache as a side
--- effect, so a refusal also re-elects the controller.
function occupancy.isFrontSeat(src, netId)
    local _, actual = occupancy.refresh(src)
    return actual ~= nil and actual == netId
end

--- THE PERCEPTION GATE. Is this player aboard this vehicle at all?
---
--- The third question, and the loosest of the three: driver, front passenger and
--- rear passenger all pass it, and only somebody who is genuinely not in the
--- vehicle fails. Use it for what a player may SEE, HEAR or be SENT — never for
--- what they may do. A rear passenger passing this gate is the point of it; a
--- rear passenger passing `isFrontSeat` or `isControllerOf` is the bug this
--- module was written to fix.
---
--- Live, for the same reason the other two gates are live: a cache is not a
--- permission, and state addressed to a seat somebody has already left is state
--- leaving the vehicle it belongs to.
function occupancy.isAboard(src, netId)
    local _, actual = occupancy.refreshOccupant(src)
    return actual ~= nil and actual == netId
end

--- THE OTHER GATE. Is this player the one whose inputs take effect here?
---
--- `isFrontSeat` answers "may they act"; this answers "may they act DIRECTLY".
--- A front passenger with a driver beside them is a front-seat occupant but not
--- the controller — their commands are forwarded to the controller rather than
--- refused.
---
--- Live, for the same reason `isFrontSeat` is live. A passenger's claim is only
--- as good as the driver seat being genuinely empty, so the cached driver — if
--- there is one — is re-read too before it is allowed to veto. Only that one
--- player is re-read: an empty cached driver seat cannot hide an occupant,
--- because whoever sat down there refreshed on the way in.
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

--- The occupant of the seat this player is NOT in. Spelled out rather than
--- `seat == DRIVER and v.passenger or v.driver`, because that idiom cannot
--- yield nil: an empty passenger seat would fall through and report the driver
--- as their own partner.
local function otherOccupant(netId, seat)
    local v = byVehicle[netId]
    if not v then return nil end
    if seat == occupancy.SEAT_DRIVER then return v.passenger end
    return v.driver
end

--- The OTHER front-seat occupant of this player's vehicle, or nil.
---
--- What a consumer needs to route one front seat's state to the other: a
--- partner is the delivery address, where `isFrontSeat` is the permission.
---
--- Live on both halves. The caller's seat is re-read because state sent on
--- behalf of a car they have already left is state leaving the vehicle it
--- belongs to; the partner's is re-read because a cached occupant who stepped
--- out a moment ago would otherwise keep receiving it.
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
---
--- What `partnerOf` is for two front seats, this is for a cabin: the delivery
--- address for something every occupant should receive, where `isAboard` is the
--- permission. It is NOT a control list — a rear passenger appears here and must
--- still be refused anything that acts on the vehicle.
---
--- Live on every half, like `partnerOf`: the caller's seat is re-read because
--- state sent on behalf of a car they have already left is state leaving the
--- vehicle it belongs to, and every cached occupant is re-read because one who
--- stepped out a moment ago would otherwise keep receiving it. That costs one
--- host read per occupant, so it is for discrete events — a per-frame consumer
--- should read `occupantsOf` and accept the cache.
--- @return peers, netId, seat, tier — `peers` is an array of server IDs, empty
--- when they are alone; the rest are nil when the caller is aboard nothing.
function occupancy.peersOf(src)
    local seat, netId, tier = occupancy.refreshOccupant(src)
    if netId == nil then return nil end

    -- Snapshot the candidate list before re-reading anybody: a refresh can drop
    -- an occupant from the live table, and iterating that table while it is
    -- being mutated is undefined in Lua.
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

-- ── Discovery ───────────────────────────────────────────────────────────
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
