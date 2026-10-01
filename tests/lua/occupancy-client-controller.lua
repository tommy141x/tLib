-- The client half of front-seat occupancy: what the local player may drive.
--
-- The server half (occupancy-front-seat.lua) is the authority that gates
-- commands. This half is the local, instant answer the UI and the input layer
-- need — "am I in a front seat, who is beside me, and am I the one whose inputs
-- take effect" — computed from natives with no round trip, so pressing a key the
-- frame you sit down does not have to wait for an ack.
--
-- Both halves apply the same election: driver if a driver is seated, otherwise
-- the front passenger.

local myId = 1
local mySeat = nil       -- { seat = -1|0|1.., vehicle = h, netId = n } or nil
local frontIds = {}      -- { driver = serverId, passenger = serverId }

IsDuplicityVersion = function() return false end
GetCurrentResourceName = function() return 'tELS' end
AddEventHandler = function() end

tlib = {
    platform = {
        getMyId = function() return myId end,
        getMySeat = function()
            if not mySeat then return nil end
            return mySeat.seat, mySeat.vehicle, mySeat.netId
        end,
        getFrontSeatServerIds = function(vehicle)
            if not mySeat or mySeat.vehicle ~= vehicle then return nil, nil end
            return frontIds.driver, frontIds.passenger
        end,
    },
}

local occupancy = dofile('shared/imports/occupancy/client.lua')

-- ── On foot ─────────────────────────────────────────────────────────────

occupancy.poll()
assert(occupancy.isFrontSeat() == false, 'a player on foot is in no front seat')
assert(occupancy.isDriver() == false)
assert(occupancy.isController() == false, 'and controls no vehicle')
assert(occupancy.myVehicle() == nil, 'and is in no vehicle')
assert(occupancy.partner() == nil, 'and has nobody beside them')

-- ── Driving alone ───────────────────────────────────────────────────────

mySeat = { seat = -1, vehicle = 500, netId = 10 }
frontIds = { driver = 1 }
occupancy.poll()

assert(occupancy.isFrontSeat() == true, 'the driver is in a front seat')
assert(occupancy.isDriver() == true)
assert(occupancy.isController() == true, 'a lone driver controls the vehicle')
local vehicle, netId = occupancy.myVehicle()
assert(vehicle == 500 and netId == 10, 'the vehicle is reported with its network id')
assert(occupancy.partner() == nil, 'an empty passenger seat is nobody')

-- ── A passenger joins: the driver keeps control ─────────────────────────

frontIds = { driver = 1, passenger = 2 }
occupancy.poll()

assert(occupancy.isController() == true, 'a passenger sitting down does not take control')
assert(occupancy.partner() == 2, 'the driver sees the passenger beside them')

-- ── The same car, seen from the passenger's client ──────────────────────

myId = 2
mySeat = { seat = 0, vehicle = 500, netId = 10 }
occupancy.poll()

assert(occupancy.isFrontSeat() == true, 'the front passenger is in a front seat')
assert(occupancy.isDriver() == false, 'but is not the driver')
assert(occupancy.isController() == false, 'and does not control a vehicle that has a driver')
assert(occupancy.partner() == 1, 'the passenger sees the driver beside them')

-- ── The driver gets out: the passenger inherits ─────────────────────────

frontIds = { passenger = 2 }
occupancy.poll()

assert(occupancy.isController() == true, 'with the driver seat empty the passenger controls it')
assert(occupancy.partner() == nil, 'and has nobody beside them')

-- ── A new driver sits down and takes over at once ───────────────────────

frontIds = { driver = 3, passenger = 2 }
occupancy.poll()

assert(occupancy.isController() == false, 'a driver taking the seat takes control immediately')
assert(occupancy.isFrontSeat() == true, 'the passenger keeps their seat')
assert(occupancy.partner() == 3, 'and sees the new driver')

-- ── Rear seats: the third tier ──────────────────────────────────────────
-- A rear passenger is aboard and is not a front-seat occupant. Every field an
-- existing consumer reads off the snapshot — seat, vehicle, netId, partner,
-- isController — answers for them exactly as it did when a rear seat was
-- indistinguishable from the pavement. The rear tier lives on new fields.

mySeat = { seat = 2, vehicle = 500, netId = 10 }
frontIds = { driver = 3, passenger = 9 }
myId = 4
occupancy.poll()

assert(occupancy.isFrontSeat() == false, 'a rear passenger is not a front-seat occupant')
assert(occupancy.isDriver() == false)
assert(occupancy.isPassenger() == false, 'and is not the front passenger either')
assert(occupancy.isController() == false, 'and controls nothing')
assert(occupancy.myVehicle() == nil, 'and operates no vehicle')
assert(occupancy.partner() == nil, 'and has no front-seat partner')

assert(occupancy.isAboard() == true, 'but they ARE aboard, which is what they gain')
assert(occupancy.isRearPassenger() == true)
assert(occupancy.tier() == occupancy.TIER_REAR)
local cVeh, cNet, cSeat, cTier = occupancy.cabin()
assert(cVeh == 500 and cNet == 10 and cSeat == 2 and cTier == occupancy.TIER_REAR,
    'and the cabin reports the vehicle and their real seat index')

-- The snapshot a consumer receives says the same thing both ways.
local snap = occupancy.state()
assert(snap.seat == nil and snap.vehicle == nil and snap.netId == nil,
    'the front-seat fields stay nil for a rear passenger')
assert(snap.isController == false and snap.partner == nil)
assert(snap.tier == occupancy.TIER_REAR and snap.cabinSeat == 2 and snap.cabinNetId == 10,
    'and the cabin fields carry the third tier')

-- No row assumption: a bus's fourteenth seat is the same tier as seat 1.
mySeat = { seat = 14, vehicle = 700, netId = 30 }
occupancy.poll()
assert(occupancy.tier() == occupancy.TIER_REAR, "seat 14 of a bus is a rear passenger")
assert(occupancy.isController() == false, 'and controls nothing from back there')
assert(select(3, occupancy.cabin()) == 14, 'reported under its own index, not flattened')

-- ── On foot is still a fourth answer, distinct from the back seat ───────

mySeat = nil
frontIds = {}
occupancy.poll()
assert(occupancy.isAboard() == false, 'on foot is aboard nothing')
assert(occupancy.tier() == nil, 'and has no tier')
assert(occupancy.cabin() == nil, 'and no cabin')
assert(occupancy.isFrontSeat() == false)
assert(occupancy.isController() == false)

-- ── Tier transitions ────────────────────────────────────────────────────

local function poll(seat, vehicle, netId, ids)
    mySeat = seat and { seat = seat, vehicle = vehicle, netId = netId } or nil
    frontIds = ids or {}
    return occupancy.poll()
end

-- on foot -> rear
poll(3, 500, 10, { driver = 7 })
assert(occupancy.tier() == occupancy.TIER_REAR and occupancy.isController() == false)

-- rear -> front passenger, driver seated: gains the seat, not the control.
myId = 4
poll(0, 500, 10, { driver = 7, passenger = 4 })
assert(occupancy.tier() == occupancy.TIER_PASSENGER)
assert(occupancy.isFrontSeat() == true, 'moving to the front is a front seat at once')
assert(occupancy.isController() == false, 'but the seated driver keeps control')
assert(occupancy.partner() == 7, 'and the driver becomes their partner')

-- front passenger -> driver seat vacated: they inherit.
poll(0, 500, 10, { passenger = 4 })
assert(occupancy.isController() == true, 'an empty driver seat elects the front passenger')

-- front -> rear: control is surrendered on the same poll.
poll(5, 500, 10, { driver = 7 })
assert(occupancy.isController() == false, 'climbing into the back gives up control')
assert(occupancy.isFrontSeat() == false, 'and the front seat with it')
assert(occupancy.partner() == nil, 'and the partner address')
assert(occupancy.isAboard() == true, 'while perception survives the move')

-- rear -> out
poll(nil)
assert(occupancy.isAboard() == false, 'and stepping out ends that too')

-- Reset for the announcement block below.
myId = 1
frontIds = {}

-- ── Changes are announced once per transition ───────────────────────────

local changes = {}
occupancy.onChange(function(state)
    changes[#changes + 1] = state
end)

occupancy.poll()
assert(#changes == 0, 'polling an unchanged state announces nothing')

mySeat = { seat = -1, vehicle = 500, netId = 10 }
frontIds = { driver = 2 }
myId = 2
occupancy.poll()
assert(#changes == 1, 'sitting down is one change')
assert(changes[1].seat == -1 and changes[1].netId == 10 and changes[1].isController == true,
    'and carries the seat, the vehicle and the election result')

occupancy.poll()
assert(#changes == 1, 'and is not re-announced while nothing moves')

-- A passenger arriving beside us changes the state even though our seat did not.
frontIds = { driver = 2, passenger = 9 }
occupancy.poll()
assert(#changes == 2 and changes[2].partner == 9,
    'somebody sitting down beside us is a change to our state too')

-- Moving to another vehicle is a change even at the same seat index.
mySeat = { seat = -1, vehicle = 600, netId = 20 }
frontIds = { driver = 2 }
occupancy.poll()
assert(#changes == 3 and changes[3].netId == 20, 'changing vehicle is announced')

-- Getting into the back is a change too, and it MUST be: the announcement is
-- what sends the server's move ping, and the ping is the only way the server
-- ever learns about a rear passenger. Nothing else about this transition would
-- register — seat, vehicle, netId, driver and passenger all stay nil.
mySeat = { seat = 2, vehicle = 600, netId = 20 }
frontIds = {}
occupancy.poll()
assert(#changes == 4, 'climbing into the back of the same car is a change')
assert(changes[4].seat == nil and changes[4].netId == nil,
    'even though every front-seat field is nil on both sides of it')
assert(changes[4].tier == occupancy.TIER_REAR and changes[4].cabinSeat == 2)

occupancy.poll()
assert(#changes == 4, 'and is not re-announced while nothing moves')

-- Sliding along the back row is a change as well; without cabinSeat in the
-- comparison it would be invisible and the server would keep the old seat.
mySeat = { seat = 3, vehicle = 600, netId = 20 }
occupancy.poll()
assert(#changes == 5 and changes[5].cabinSeat == 3, 'moving between two rear seats is announced')

-- Riding in the back of a different car, at the same seat index.
mySeat = { seat = 3, vehicle = 800, netId = 40 }
occupancy.poll()
assert(#changes == 6 and changes[6].cabinNetId == 40, 'changing vehicle in the back is announced')

mySeat = nil
occupancy.poll()
assert(#changes == 7 and changes[7].tier == nil, 'and getting out is the last of them')

print('PASS: client occupancy elects driver-else-passenger locally, seats rear passengers without arming them, and announces transitions once')
