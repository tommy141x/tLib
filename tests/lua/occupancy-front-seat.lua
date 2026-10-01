-- Vehicle occupancy: the one trust rule tELS, tRadar and tRadio share.
--
-- Three resources each grew their own answer to "may this player act on that
-- vehicle" and all three got it differently wrong: tELS accepted any seat (so a
-- rear passenger could steal the relay from the driver), tRadio accepted only
-- the driver, tRadar never asked because it never left the client. This module
-- is the single answer, and this suite is its oracle.
--
-- There are three tiers — driver, front passenger, rear passenger — and two
-- questions. The rear tier PERCEIVES and never CONTROLS, so most of what this
-- file asserts about a rear seat is what it is still refused.
--
-- The module is loaded into each CONSUMER's VM, like every tLib import, so each
-- resource keeps its own cache over the same authoritative natives. Nothing here
-- is shared between resources at runtime — only the rule is.

local seats = {}   -- [src] = { seat = -1|0|1.., netId = n } or nil
local reads = 0

IsDuplicityVersion = function() return true end
GetCurrentResourceName = function() return 'tELS' end
AddEventHandler = function() end
local netEvents = {}
RegisterNetEvent = function(name, fn) netEvents[name] = fn end
local clock = 0
GetGameTimer = function() return clock end

tlib = {
    platform = {
        -- The ANY-seat read. The adapter also has a two-seat `getPlayerFrontSeat`,
        -- but occupancy no longer calls it: collapsing a rear seat to nil is now
        -- occupancy's decision to make per question, not the adapter's to make
        -- once for everybody.
        getPlayerSeat = function(src)
            reads = reads + 1
            local s = seats[src]
            if not s then return nil end
            return s.seat, s.netId
        end,
    },
}

local occupancy = dofile('shared/imports/occupancy/server.lua')

local DRIVER, PASSENGER = occupancy.SEAT_DRIVER, occupancy.SEAT_PASSENGER
assert(DRIVER == -1 and PASSENGER == 0, 'seat constants match the GTA seat indices')

-- ── Seat index → tier, with no row assumption anywhere ──────────────────
-- The classifier is pure and is the ONLY place an index becomes a tier, so a
-- bus's fourteenth seat is ordinary rather than a special case somebody forgot.

local T = occupancy
assert(T.seatTier(-1) == T.TIER_DRIVER, 'seat -1 is the driver')
assert(T.seatTier(0) == T.TIER_PASSENGER, 'seat 0 is the front passenger')
assert(T.seatTier(1) == T.TIER_REAR, 'seat 1 is a rear passenger')
assert(T.seatTier(2) == T.TIER_REAR)
assert(T.seatTier(3) == T.TIER_REAR, 'a third row is rear, not unknown')
assert(T.seatTier(14) == T.TIER_REAR, "a bus's fourteenth seat is rear like any other")
assert(T.TIER_DRIVER ~= T.TIER_PASSENGER and T.TIER_PASSENGER ~= T.TIER_REAR,
    'the three tiers are three distinct values')
assert(T.seatTier(nil) == nil, 'no seat is no tier')
assert(T.seatTier('0') == nil, 'a seat index that is not a number is not a seat')
assert(T.seatTier(-2) == nil, 'nothing below the driver seat is a seat we model')

-- ── An empty world answers "no", never "maybe" ──────────────────────────

assert(occupancy.seatOf(1) == nil, 'a player in no vehicle has no seat')
assert(occupancy.controllerOf(10) == nil, 'a vehicle nobody is in has no controller')
assert(occupancy.isFrontSeat(1, 10) == false, 'the gate is closed by default')

-- ── The driver is the controller ────────────────────────────────────────

seats[1] = { seat = DRIVER, netId = 10 }
occupancy.refresh(1)

local seat, netId = occupancy.seatOf(1)
assert(seat == DRIVER and netId == 10, 'a seated driver is recorded with their vehicle')
assert(occupancy.frontSeats(10).driver == 1, 'the vehicle knows its driver')
assert(occupancy.controllerOf(10) == 1, 'the driver controls the vehicle')
assert(occupancy.isFrontSeat(1, 10) == true, 'the driver passes the gate')
assert(occupancy.isFrontSeat(1, 11) == false, 'and only for the vehicle they are actually in')

-- ── A front passenger joins: shares the seat, not the control ───────────

seats[2] = { seat = PASSENGER, netId = 10 }
occupancy.refresh(2)

local front = occupancy.frontSeats(10)
assert(front.driver == 1 and front.passenger == 2, 'both front seats are tracked')
assert(occupancy.controllerOf(10) == 1, 'a passenger does not take control from a seated driver')
assert(occupancy.isFrontSeat(2, 10) == true, 'but the passenger still passes the gate')

-- frontSeats hands out a copy: a consumer mutating what it reads must not be
-- able to rewrite the occupancy table underneath every other consumer.
front.driver = 99
assert(occupancy.frontSeats(10).driver == 1, 'frontSeats returns a copy, not the live table')

-- ── Driver leaves: the passenger inherits control ───────────────────────

seats[1] = nil
occupancy.refresh(1)

assert(occupancy.frontSeats(10).driver == nil, 'the empty driver seat is released')
assert(occupancy.controllerOf(10) == 2, 'with no driver, the front passenger controls the vehicle')
assert(occupancy.isFrontSeat(1, 10) == false, 'the departed driver no longer passes the gate')

-- ── A new driver sits down and takes over immediately ───────────────────

seats[3] = { seat = DRIVER, netId = 10 }
occupancy.refresh(3)

assert(occupancy.controllerOf(10) == 3, 'a driver taking the seat takes control from the passenger')
assert(occupancy.isFrontSeat(2, 10) == true, 'the passenger keeps their seat and their gate')

-- ── Rear seats: present, addressable, and powerless ─────────────────────
-- The third tier. A rear passenger is now a distinct case rather than being
-- indistinguishable from a player on foot — but every existing question about
-- them answers exactly as it did when they were invisible. What they gain is
-- perception; what they gain in control is nothing.

seats[4] = { seat = 2, netId = 10 }
occupancy.refresh(4)

assert(occupancy.tierOf(4) == occupancy.TIER_REAR, 'a rear passenger has the rear tier')
local rseat, rnet, rtier = occupancy.occupantSeatOf(4)
assert(rseat == 2 and rnet == 10 and rtier == occupancy.TIER_REAR,
    'and their real seat index, not a collapsed one')
assert(occupancy.occupantsOf(10).rear[2] == 4, 'the cabin knows who is in seat 2')
assert(occupancy.isAboard(4, 10) == true, 'they are aboard, so they may perceive')
assert(occupancy.isAboard(4, 11) == false, 'but only the vehicle they are actually in')

assert(occupancy.seatOf(4) == nil, 'a rear passenger has no FRONT seat')
assert(occupancy.isFrontSeat(4, 10) == false, 'and never passes the front-seat gate')
assert(occupancy.isControllerOf(4, 10) == false, 'and never controls anything')
assert(occupancy.controllerOf(10) == 3, 'nor do they disturb the election')
assert(occupancy.frontSeats(10).driver == 3 and occupancy.frontSeats(10).passenger == 2,
    'and they are not in frontSeats, which is still the two front seats only')

-- refresh() is the FRONT-seat read and must keep answering nil for them, because
-- isFrontSeat, isControllerOf and partnerOf are all built on its return value.
assert(occupancy.refresh(4) == nil, 'refresh answers nil for a rear seat, as it always has')
-- ...while still having learnt where they actually are.
assert(occupancy.tierOf(4) == occupancy.TIER_REAR, 'the cache learns the seat anyway')

-- occupantsOf hands out a copy, like frontSeats, including the nested rear table.
local cabin = occupancy.occupantsOf(10)
cabin.rear[2] = 99
cabin.driver = 99
assert(occupancy.occupantsOf(10).rear[2] == 4, 'occupantsOf returns a copy of the rear table')
assert(occupancy.occupantsOf(10).driver == 3, 'and of the front seats')

-- A second and third row, to prove nothing counts rows.
seats[7] = { seat = 5, netId = 10 }
seats[8] = { seat = 12, netId = 10 }
occupancy.refresh(7); occupancy.refresh(8)
local wide = occupancy.occupantsOf(10)
assert(wide.rear[2] == 4 and wide.rear[5] == 7 and wide.rear[12] == 8,
    'seats 2, 5 and 12 coexist under their own indices')
assert(occupancy.controllerOf(10) == 3, 'a full bus still elects its driver and nobody else')
assert(occupancy.isControllerOf(8, 10) == false, 'seat 12 controls nothing')

-- Everybody aboard, as a delivery address. Rear passengers are IN it — that is
-- what makes shared state reach them — and it is not a control list.
local peers, pnet = occupancy.peersOf(3)
table.sort(peers)
assert(pnet == 10 and #peers == 4, 'the driver has four people to send to')
assert(peers[1] == 2 and peers[2] == 4 and peers[3] == 7 and peers[4] == 8,
    'the front passenger and all three rear passengers, and not the caller')
local rearPeers = occupancy.peersOf(4)
table.sort(rearPeers)
assert(#rearPeers == 4 and rearPeers[1] == 2 and rearPeers[4] == 8,
    'and a rear passenger can be sent to from anywhere in the cabin, themselves excluded')

-- A peer who has got out is not a delivery address, even before any sweep.
seats[8] = nil
local live = occupancy.peersOf(3)
assert(#live == 3, 'peersOf re-reads every occupant, so a departed one is dropped')

-- Leaving the back releases the seat and empties the vehicle record with it.
seats[4] = nil; seats[7] = nil
occupancy.refresh(4); occupancy.refresh(7)
assert(occupancy.tierOf(4) == nil, 'a rear passenger who got out holds no tier')
assert(next(occupancy.occupantsOf(10).rear) == nil, 'and no seat')
assert(occupancy.controllerOf(10) == 3, 'the front of the car is undisturbed throughout')

-- ── Seat transitions across the tier boundary ───────────────────────────

-- rear -> front: they gain control candidacy at the moment of the read.
seats[4] = { seat = 2, netId = 10 }
occupancy.refresh(4)
assert(occupancy.isControllerOf(4, 10) == false, 'in the back, no control')
seats[3] = nil                            -- the driver gets out
seats[4] = { seat = PASSENGER, netId = 10 }  -- and 4 climbs into the front
assert(occupancy.isControllerOf(4, 10) == true,
    'moving rear -> front passenger with an empty driver seat elects them, live')
assert(occupancy.occupantsOf(10).rear[2] == nil, 'and vacates the rear seat they left')

-- front -> rear: control is lost on the very next question, with no sweep.
seats[4] = { seat = 3, netId = 10 }
assert(occupancy.isControllerOf(4, 10) == false,
    'climbing into the back gives up control immediately')
assert(occupancy.isFrontSeat(4, 10) == false, 'and the front-seat gate with it')
assert(occupancy.isAboard(4, 10) == true, 'while perception survives the move')
assert(occupancy.tierOf(4) == occupancy.TIER_REAR)
assert(occupancy.occupantsOf(10).passenger == nil, 'the front seat they left is released')

-- rear -> out: nothing at all.
seats[4] = nil
assert(occupancy.isAboard(4, 10) == false, 'stepping out of the back ends perception too')
assert(occupancy.tierOf(4) == nil)
assert(occupancy.occupantsOf(10).rear[3] == nil)

-- Put the car back the way the next block expects it: 4 taking seat 0 above
-- displaced 2 from it, which is the double-booking rule doing its job.
seats[3] = { seat = DRIVER, netId = 10 }
occupancy.refresh(3)
occupancy.refresh(2)
assert(occupancy.controllerOf(10) == 3, 'the driver is seated')
assert(occupancy.frontSeats(10).passenger == 2, 'and the front passenger is back')

-- ── The gate reads live, because a cache is not a permission ────────────
-- A command arriving after the player left the car must be refused even though
-- nothing has swept yet. This is why isFrontSeat costs a native read.

local before = reads
assert(occupancy.isFrontSeat(3, 10) == true)
assert(reads > before, 'the gate verifies against the host rather than its own cache')

seats[3] = nil -- stepped out; no refresh, no sweep
assert(occupancy.isFrontSeat(3, 10) == false, 'a stale cache entry does not authorise anything')
assert(occupancy.controllerOf(10) == 2,
    'and the refusal repairs the cache, so the passenger inherits control')

-- ── Vehicles are independent ────────────────────────────────────────────

seats[5] = { seat = DRIVER, netId = 20 }
occupancy.refresh(5)
assert(occupancy.controllerOf(20) == 5, 'a second vehicle elects its own controller')
assert(occupancy.controllerOf(10) == 2, 'without disturbing the first')

-- Moving between vehicles releases the old seat rather than holding both.
seats[5] = { seat = PASSENGER, netId = 10 }
occupancy.refresh(5)
assert(occupancy.frontSeats(20).driver == nil, 'the vacated vehicle is released')
assert(occupancy.controllerOf(20) == nil, 'and has no controller left')
assert(occupancy.frontSeats(10).passenger == 5, 'the new seat replaces the old one')
-- Two players cannot share a seat. Our record said 2 was in it; this reading came
-- from the host just now and 2's came from some earlier tick, so 2 is the stale
-- half and is dropped rather than left holding a seat somebody else is in.
assert(occupancy.seatOf(2) == nil, 'the displaced occupant is dropped, not left double-booked')

-- ── Changes are announced once, on transitions only ─────────────────────

local events = {}
occupancy.onChange(function(id, now, prev)
    events[#events + 1] = { netId = id, driver = now.driver, was = prev.driver }
end)

occupancy.refresh(5)
assert(#events == 0, 're-reading an unchanged seat announces nothing')

seats[6] = { seat = DRIVER, netId = 10 }
occupancy.refresh(6)
assert(#events == 1 and events[1].netId == 10 and events[1].driver == 6 and events[1].was == nil,
    'a seat change announces the vehicle with both the new and previous occupants')

-- ── Disconnects ─────────────────────────────────────────────────────────

occupancy.clear(6)
assert(occupancy.seatOf(6) == nil, 'a dropped player holds no seat')
-- 5, not 2: taking seat 0 of vehicle 10 above displaced 2 from it. Two players
-- cannot share a seat, and the reading taken from the host is the newer one.
assert(occupancy.controllerOf(10) == 5,
    'and control falls back to the remaining front-seat occupant')
assert(#events == 2 and events[2].driver == nil, 'the drop is announced like any other change')

-- A drop for somebody who never sat anywhere is not an error.
occupancy.clear(77)

-- ── Who acts directly, and who acts through somebody ────────────────────
-- isFrontSeat answers "may they act"; isControllerOf answers "may they act
-- DIRECTLY". A passenger with a driver beside them is inside the first gate and
-- outside the second — their commands get forwarded, not refused.

seats = {}
occupancy.clear(5)
occupancy.clear(6)

seats[1] = { seat = DRIVER, netId = 30 }
occupancy.refresh(1)
assert(occupancy.isControllerOf(1, 30) == true, 'a lone driver acts directly')
assert(occupancy.isControllerOf(1, 31) == false, 'and only on the vehicle they are in')

seats[2] = { seat = PASSENGER, netId = 30 }
occupancy.refresh(2)
assert(occupancy.isFrontSeat(2, 30) == true, 'the passenger is a front-seat occupant')
assert(occupancy.isControllerOf(2, 30) == false, 'but does not act directly past a seated driver')
assert(occupancy.isControllerOf(1, 30) == true, 'the driver still does')

-- The driver gets out. The passenger inherits on the next question asked, with
-- no sweep in between: the gate re-reads the cached driver before letting it veto.
seats[1] = nil
assert(occupancy.isControllerOf(2, 30) == true,
    'a passenger inherits control the moment the driver seat is actually empty')
assert(occupancy.seatOf(1) == nil, 'and the departed driver is dropped from the cache as a side effect')

-- A new driver sits down and takes it straight back.
seats[3] = { seat = DRIVER, netId = 30 }
occupancy.refresh(3)
assert(occupancy.isControllerOf(3, 30) == true, 'the new driver acts directly')
assert(occupancy.isControllerOf(2, 30) == false, 'and the passenger goes back to forwarding')

-- Somebody who left the vehicle entirely is neither.
seats[2] = nil
assert(occupancy.isFrontSeat(2, 30) == false)
assert(occupancy.isControllerOf(2, 30) == false, 'a player on foot controls nothing')

-- A rear passenger is refused by both ACTION gates and admitted by the
-- perception one. This is the whole three-tier model in four lines.
seats[4] = { seat = 2, netId = 30 }
assert(occupancy.isFrontSeat(4, 30) == false)
assert(occupancy.isControllerOf(4, 30) == false, 'a rear seat is not a front seat')
assert(occupancy.isAboard(4, 30) == true, 'but a rear seat IS aboard')
assert(occupancy.controllerOf(30) == 3, 'and the driver is still the controller')

-- ── The cabin listener, and what it deliberately does not wake ──────────

local cabinEvents, frontEvents = {}, {}
local unsubCabin = occupancy.onCabinChange(function(id, now, prev)
    cabinEvents[#cabinEvents + 1] = { netId = id, now = now, prev = prev }
end)
local unsubFront = occupancy.onChange(function(id)
    frontEvents[#frontEvents + 1] = id
end)

seats[9] = { seat = 4, netId = 30 }
occupancy.refresh(9)
assert(#cabinEvents == 1 and cabinEvents[1].now.rear[4] == 9,
    'somebody getting into the back is a cabin change')
assert(cabinEvents[1].prev.rear[4] == nil, 'reported against the previous cabin')
assert(#frontEvents == 0, 'and is NOT a front-seat change — onChange keeps its old meaning')

-- Shuffling between two rear seats: still a cabin change, still not a front one.
seats[9] = { seat = 6, netId = 30 }
occupancy.refresh(9)
assert(#cabinEvents == 2 and cabinEvents[2].now.rear[6] == 9 and cabinEvents[2].now.rear[4] == nil,
    'moving seat in the back is announced once, against both indices')
assert(#frontEvents == 0)

-- A front-seat change wakes both, because a cabin is a superset of the front.
seats[9] = nil
occupancy.refresh(9)
seats[3] = nil
occupancy.refresh(3)
assert(#frontEvents == 1, 'the driver leaving is a front-seat change')
assert(#cabinEvents == 4, 'and a cabin change, as is the rear passenger leaving before it')

unsubCabin(); unsubFront()
seats[3] = { seat = DRIVER, netId = 30 }
occupancy.refresh(3)
assert(#cabinEvents == 4 and #frontEvents == 1, 'both unsubscribes take effect')

print('PASS: occupancy elects driver-else-passenger, gates live, and seats rear passengers without arming them')

-- ── The delivery address ────────────────────────────────────────────────
-- partnerOf is not a permission, it is where the other front seat's copy of
-- something goes. Both halves are read live, so it can never name somebody who
-- has already got out.

seats = {}
occupancy.clear(1); occupancy.clear(2); occupancy.clear(3); occupancy.clear(4)

seats[1] = { seat = DRIVER, netId = 40 }
local partner, netId, seat = occupancy.partnerOf(1)
assert(partner == nil, 'a lone driver has nobody to send to')
assert(netId == 40 and seat == DRIVER, 'but the vehicle and seat are still reported')

-- Somebody sits down beside them. The cache only knows a seat it has been
-- asked about, and nobody asks a question about a passenger who is just
-- sitting there — which is what occupancy.startReporting exists to fix on the
-- client. Here that ping is the refresh.
seats[2] = { seat = PASSENGER, netId = 40 }
assert(occupancy.partnerOf(1) == nil, 'an occupant the server has never heard from is not found')
occupancy.refresh(2)
assert(occupancy.partnerOf(1) == 2, 'the driver sends to the front passenger')
assert(occupancy.partnerOf(2) == 1, 'and the passenger to the driver')

-- The empty-seat trap: with no passenger, asking the DRIVER for their partner
-- must not read the driver field and answer with themselves.
seats[2] = nil
assert(occupancy.partnerOf(1) == nil, 'a driver is never their own partner')

-- A partner who left is not a delivery address, even before any sweep has
-- noticed — the cached entry is re-read before it is handed back.
seats[2] = { seat = PASSENGER, netId = 40 }
occupancy.refresh(2)
seats[2] = nil
assert(occupancy.partnerOf(1) == nil, 'a partner who has got out is dropped, not reported')

-- Rear seats are nobody's partner in either direction.
seats[3] = { seat = 2, netId = 40 }
occupancy.refresh(3)
assert(occupancy.partnerOf(1) == nil, 'a rear passenger is not a front-seat partner')
assert(occupancy.partnerOf(3) == nil, 'and has no partner of their own')

-- On foot there is no vehicle to report either.
seats[1] = nil
local none, noVeh = occupancy.partnerOf(1)
assert(none == nil and noVeh == nil, 'a player on foot has no partner and no vehicle')

print('PASS: partnerOf names the other front seat, live, and never the caller')

-- ── Discovery ───────────────────────────────────────────────────────────
-- The client-side ping that makes the above reachable for a passenger who has
-- not done anything. The payload is a nudge: the seat is re-read here, so a
-- client claiming a seat it is not in gets the truth written instead.

local moved = assert(netEvents['tlib:occupancy:moved'], 'the move ping is registered')

seats = {}
occupancy.clear(1); occupancy.clear(2); occupancy.clear(3)

seats[1] = { seat = DRIVER, netId = 50 }
seats[2] = { seat = PASSENGER, netId = 50 }
assert(occupancy.partnerOf(1) == nil, 'nobody has reported in yet')

clock = clock + 1000
source = 2
moved()
assert(occupancy.partnerOf(1) == 2, 'a ping from the passenger makes them findable')

-- Rate-limited per player, because a client that pings in a loop would cost one
-- host seat read per message.
local before = reads
clock = clock + 10
source = 2
moved()
assert(reads == before, 'a second ping inside the window is dropped')

-- A ping from somebody sitting in the back tells the cache exactly that. This
-- is the ONLY way the server ever hears about a rear passenger: no gate asks
-- about them, because every gate they can reach refuses them.
seats[3] = { seat = 2, netId = 50 }
clock = clock + 1000
source = 3
moved()
assert(occupancy.seatOf(3) == nil, 'a rear seat still reads as no FRONT seat at all')
assert(occupancy.tierOf(3) == occupancy.TIER_REAR, 'but the cache now knows they are in the back')
assert(occupancy.occupantsOf(50).rear[2] == 3, 'and which seat, so they can be sent to')
assert(occupancy.partnerOf(1) == 2, 'without becoming anybody\'s front-seat partner')
assert(occupancy.isControllerOf(3, 50) == false, 'and without becoming a controller')

-- The 100 ms rate limit means a tier read can be stale. A player who moves
-- inside the window is cached where they WERE until the next ping or sweep.
seats[3] = { seat = DRIVER, netId = 60 }
clock = clock + 10
source = 3
moved()
assert(occupancy.tierOf(3) == occupancy.TIER_REAR,
    'a move inside the rate-limit window leaves the cached tier stale')
-- Stale perception, never stale control: every gate re-reads the host, so the
-- window can misaddress a broadcast for a tick and can never mis-authorise one.
assert(occupancy.isControllerOf(3, 60) == true, 'the live gate is right immediately')
assert(occupancy.tierOf(3) == occupancy.TIER_DRIVER, 'and repairs the cache on its way past')

print('PASS: a client move ping refreshes the server cache, rate-limited and re-read')
