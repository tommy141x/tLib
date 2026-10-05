-- The vehicle frame relay: the controller election, the sequence numbering, the
-- heartbeat, the stale expiry and the withdrawal.
--
-- ── Why this suite exists at all ────────────────────────────────────────────
--
-- A correctness regression in this module only manifests WITH TWO PLAYERS IN ONE
-- VEHICLE, which is why the consolidation it came out of was deferred until there
-- was a harness that could model two clients. No resource suite can reach it: each
-- one loads its own resource's client scripts into a single VM with a single
-- occupancy module and a single relay, so "two writers on one statebag key" is not
-- a state it can be in.
--
-- So this suite runs TWO CLIENTS over ONE statebag world. Each gets its own
-- `shared/imports/occupancy/client.lua` (dofile returns a fresh module per call) and
-- its own relay instance; `asClient` swaps which one `tlib.platform` and
-- `tlib.occupancy` resolve to, the way the game would by running them in two
-- processes.
--
-- Every rule below fails SILENTLY in game when it is got wrong:
--
--   * TWO WRITERS on one key alternate two devices' pictures into everyone else's
--     prop. Nothing raises; the prop just shows the wrong car's readings half the
--     time, and only when two people are in one car.
--   * A STATEBAG IS NOT WITHDRAWN WHEN ITS WRITER DISCONNECTS, and the write only
--     lands while the writer OWNS the entity. Without `seq` and the stale window a
--     driver whose game crashed leaves their last alert painted on the prop for as
--     long as the car exists.
--   * A `seq` THAT IS NOT A NUMBER is not merely invalid, it is UNEXPIRABLE.
--
-- ── The negative controls ───────────────────────────────────────────────────
--
--   FRAMERELAY_CONTROL=election   both clients report themselves the controller.
--     This defects THE REAL CODE PATH: `publishTick` computes `mine` from
--     `tlib.occupancy.isController()`, so the module genuinely admits two writers
--     and the election assertions must FLIP. It is the pre-election bug, replayed.
--
--   FRAMERELAY_CONTROL=clock      the world's clock stops advancing.
--     This defects the module's only notion of time, which is the one way a relay
--     reasoned entirely about elapsed milliseconds can look perfect while measuring
--     nothing. The heartbeat and staleness assertions must FLIP. It also catches a
--     future edit to this file that forgets to advance the clock.
--
-- Both modes require an EXACT number of flips and name every one that did not, so a
-- control whose expected set has gone stale refuses its own run rather than agreeing
-- with whatever the code now does.
--
-- Run via `bun run test:lua`; the controls via
--   FRAMERELAY_CONTROL=election bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/framerelay-election.lua

local CONTROL = os.getenv('FRAMERELAY_CONTROL')
if CONTROL == '' then CONTROL = nil end
if CONTROL ~= nil and CONTROL ~= 'election' and CONTROL ~= 'clock' then
    error('FRAMERELAY_CONTROL must be unset, "election" or "clock"; got ' .. tostring(CONTROL), 0)
end

--- Labels that MUST fail under each control, and must pass otherwise. Everything
--- else is a decoy in both directions: an assertion that flips when it was not
--- supposed to is reported too.
local MUST_FLIP = {
    election = { ['election-one-writer'] = true, ['election-loser-silent'] = true },
    clock    = { ['stale-expires'] = true, ['heartbeat-republishes'] = true },
}

local expectedFlips = MUST_FLIP[CONTROL] or {}
local seenFlips, seenLabels = {}, {}

local function fail(message) error(message, 3) end

--- One labelled assertion.
---
--- `ok` is computed by the caller and passed in rather than being a closure, so a
--- control cannot pass by the assertion never being evaluated.
local function expect(label, ok, message)
    if seenLabels[label] then fail('duplicate assertion label: ' .. label) end
    seenLabels[label] = true

    if expectedFlips[label] then
        if ok then
            fail(('control %q: %q still passed -- the planted defect was not measured. %s')
                :format(CONTROL, label, message))
        end
        seenFlips[label] = true
        return
    end

    if not ok then fail(('%s [%s]'):format(message, label)) end
end

-- ── The world ───────────────────────────────────────────────────────────────

local entities = {}            -- [handle] = true while it exists
local bags     = {}            -- [handle] = { [key] = value }
local clock    = 0

function DoesEntityExist(h) return type(h) == 'number' and entities[h] == true end
function GetGameTimer() return clock end

--- Moves the world's clock on. A NO-OP under the `clock` control, which is the whole
--- of that defect.
local function advance(ms)
    if CONTROL == 'clock' then return end
    clock = clock + ms
end

--- A statebag value crosses the network as JSON, so a reader gets its OWN table.
--- Copied on write for that reason: handing the reader the publisher's live table
--- would let an assertion about "a frame that arrived from another client" pass
--- against a module that had been mutating the one object all along.
local function deepCopy(v)
    if type(v) ~= 'table' then return v end
    local out = {}
    for k, val in pairs(v) do out[k] = deepCopy(val) end
    return out
end

function Entity(handle)
    local bag = bags[handle]
    if bag == nil then
        bag = {}
        bags[handle] = bag
    end
    return {
        state = setmetatable({}, {
            __index = function(_, k)
                if k == 'set' then
                    return function(_, key, value) bag[key] = deepCopy(value) end
                end
                return bag[k]
            end,
        }),
    }
end

function AddEventHandler() end
function RegisterNetEvent() end
function IsDuplicityVersion() return false end
function GetCurrentResourceName() return 'tTest' end
Citizen = { CreateThread = function() end, Wait = function() end, SetTimeout = function() end }

-- ── Two clients ─────────────────────────────────────────────────────────────

local FrameRelay

--- The payload schema, which is the ONLY part a consumer owns. Deliberately neither
--- tDetector's flat field lists nor tRadar's nested tree: a third shape proves the
--- relay knows nothing about the payload beyond `powered`, `seq` and `netId`.
local function sanitise(raw)
    if type(raw) ~= 'table' then return nil end
    local text = raw.text
    if type(text) ~= 'string' then text = '' end
    return { powered = raw.powered == true, text = text }
end

local function differs(a, b)
    if a == nil or b == nil then return a ~= b end
    return (a.powered == true) ~= (b.powered == true) or a.text ~= b.text
end

local current = nil

tlib = setmetatable({}, {
    __index = function(_, key)
        if key == 'platform' or key == 'occupancy' then
            if current == nil then error('no client is current', 2) end
            return current[key]
        end
        error('the relay asked tlib for an unexpected module: ' .. tostring(key), 2)
    end,
})

local function newClient(id)
    local client = { id = id, seat = nil, vehicle = nil, netId = nil,
        driver = nil, passenger = nil, frame = nil }

    client.platform = {
        getMyId = function() return client.id end,
        getMySeat = function()
            if client.seat == nil or client.vehicle == nil then return nil end
            return client.seat, client.vehicle, client.netId
        end,
        getFrontSeatServerIds = function(vehicle)
            if vehicle ~= client.vehicle then return nil, nil end
            return client.driver, client.passenger
        end,
    }

    -- Its OWN occupancy module. `dofile` re-executes the file, so the two clients do
    -- not share the module-level `state` the real thing keeps per process.
    current = client
    client.occupancy = dofile('shared/imports/occupancy/client.lua')

    if CONTROL == 'election' then
        -- THE PLANTED DEFECT, in the real code path: `publishTick` computes `mine`
        -- from this, so the module now genuinely admits two writers on one key.
        client.occupancy.isController = function() return true end
    end

    client.relay = FrameRelay.create({
        key       = 'tTestFrame',
        sanitise  = sanitise,
        differs   = differs,
        frame     = function() return client.frame end,
        hasScreen = function(vehicle) return vehicle == client.vehicle end,
    })

    return client
end

--- Make `client` the one `tlib` answers for, re-poll its seat, and run `body`.
local function asClient(client, body)
    current = client
    client.occupancy.poll()
    body()
end

FrameRelay = dofile('shared/imports/framerelay/client.lua')

local A = newClient(1)   -- server id 1
local B = newClient(2)   -- server id 2

local CAR   = 500
local OTHER = 501
entities[CAR] = true
entities[OTHER] = true

local function bagOf(vehicle) return bags[vehicle] and bags[vehicle].tTestFrame or nil end

-- ════════════════════════════════════════════════════════════════════════════
--  A LONE DRIVER PUBLISHES
-- ════════════════════════════════════════════════════════════════════════════

A.seat, A.vehicle, A.netId = -1, CAR, 10
A.driver, A.passenger = 1, nil
A.frame = { powered = true, text = 'A1' }

asClient(A, A.relay.publishTick)

local published = bagOf(CAR)
expect('lone-driver-publishes',
    published ~= nil and published.text == 'A1' and published.seq == 1 and published.netId == 10,
    'a lone driver who owns the device did not publish its frame')

-- The payload is SANITISED on the way out, not forwarded. It arrives from another
-- client at the far end and goes straight into a browser.
expect('publish-is-sanitised',
    published.powered == true and published.extra == nil,
    'the published payload was not the sanitised shape')

-- ════════════════════════════════════════════════════════════════════════════
--  TWO FRONT-SEAT OCCUPANTS, ONE WRITER
-- ════════════════════════════════════════════════════════════════════════════
--
-- The reason the election exists. Both clients run their own NUI and both have a
-- frame; the driver is the controller, so the passenger must publish NOTHING.

B.seat, B.vehicle, B.netId = 0, CAR, 10
B.driver, B.passenger = 1, 2
B.frame = { powered = true, text = 'B-WRONG' }
A.driver, A.passenger = 1, 2

asClient(B, B.relay.publishTick)
asClient(A, A.relay.publishTick)

published = bagOf(CAR)
expect('election-one-writer',
    published ~= nil and published.text == 'A1',
    "the front passenger's frame reached the vehicle's statebag: got "
        .. tostring(published and published.text))

expect('election-loser-silent',
    B.relay.publishedVehicle() == nil and B.relay.publishedSeq() == 0,
    'the passenger relay believed it had published')

-- The DRIVER is still a writer, under the election and under its defect alike. A
-- decoy: it must not flip in either control mode.
A.frame = { powered = true, text = 'A2' }
asClient(A, A.relay.publishTick)
expect('driver-keeps-writing',
    bagOf(CAR).text == 'A2',
    'the driver stopped being able to publish once a passenger sat down')

-- ════════════════════════════════════════════════════════════════════════════
--  THE DRIVER SEAT EMPTIES
-- ════════════════════════════════════════════════════════════════════════════
--
-- A passenger is the controller only while the driver seat is genuinely empty. This
-- is a decoy for the election control: with the election defected the passenger was
-- a writer all along, so it still passes.

A.seat, A.vehicle = nil, nil
B.driver, B.passenger = nil, 2
B.frame = { powered = true, text = 'B-NOW-MINE' }
asClient(B, B.relay.publishTick)

expect('passenger-takes-over',
    bagOf(CAR).text == 'B-NOW-MINE',
    'the front passenger did not take over publishing once the driver seat emptied')

-- ════════════════════════════════════════════════════════════════════════════
--  THE READ SIDE
-- ════════════════════════════════════════════════════════════════════════════
--
-- A third client, on foot beside the car. It is not in the vehicle and has no frame
-- of its own, which is the whole case the relay exists for.

local C = newClient(3)
asClient(C, function()
    local seen = C.relay.read(CAR)
    expect('reader-sees-published',
        seen ~= nil and seen.text == 'B-NOW-MINE' and seen.powered == true,
        'a client in scope could not read the frame published on the vehicle')

    -- Within the stale window, with `seq` unmoved, it is still live.
    advance(1500)
    expect('live-within-window',
        C.relay.read(CAR) ~= nil,
        'a live frame expired inside the stale window')

    -- The writer crashed: nothing updates `seq` again. Three heartbeats later the
    -- value is leftovers. THE CLOCK CONTROL FLIPS THIS.
    advance(5000)
    expect('stale-expires',
        C.relay.read(CAR) == nil,
        'a frame whose seq stopped moving was still served as live')

    -- A `seq` that is not a number is UNEXPIRABLE, so it is rejected outright
    -- rather than clamped. Written straight into the bag, because that is where a
    -- modified client's value would come from.
    bags[CAR].tTestFrame = { powered = true, text = 'junk', seq = 'not a number' }
    expect('non-numeric-seq-rejected',
        C.relay.read(CAR) == nil,
        'a frame with a non-numeric seq was accepted')

    bags[CAR].tTestFrame = nil
    expect('absent-value-reads-nil',
        C.relay.read(CAR) == nil,
        'a vehicle with no published frame did not read as nil')
end)

-- ════════════════════════════════════════════════════════════════════════════
--  THE HEARTBEAT
-- ════════════════════════════════════════════════════════════════════════════
--
-- The publisher writes when the picture CHANGED or when the heartbeat is due. The
-- heartbeat exists only for the reader's staleness test, so an UNCHANGED frame must
-- still move `seq` once the interval passes -- otherwise a parked car with a steady
-- reading expires on every client while the device is working perfectly.

asClient(B, B.relay.publishTick)
local baseSeq = B.relay.publishedSeq()

asClient(B, B.relay.publishTick)
expect('unchanged-not-republished',
    B.relay.publishedSeq() == baseSeq,
    'an unchanged frame was republished inside the heartbeat window')

advance(1200)
asClient(B, B.relay.publishTick)
expect('heartbeat-republishes',
    B.relay.publishedSeq() == baseSeq + 1 and bagOf(CAR).seq == baseSeq + 1,
    'an unchanged frame was not republished once the heartbeat came due')

-- ════════════════════════════════════════════════════════════════════════════
--  WITHDRAWAL
-- ════════════════════════════════════════════════════════════════════════════

-- An OFF device publishes nothing rather than an off frame: the prop's baked artwork
-- already is the off state. The relay reads `powered` and nothing else of a payload.
B.frame = { powered = false, text = 'should not appear' }
asClient(B, B.relay.publishTick)
expect('off-device-withdraws',
    bagOf(CAR) == nil,
    'a switched-off device published an off frame instead of withdrawing')

-- A CHANGED CAR. The old vehicle must be withdrawn from first, or it keeps a value
-- nothing will ever update or clear again.
B.frame = { powered = true, text = 'B-CAR1' }
asClient(B, B.relay.publishTick)
expect('republish-after-off',
    bagOf(CAR) ~= nil and bagOf(CAR).text == 'B-CAR1',
    'a device switched back on did not start publishing again')

B.vehicle, B.netId = OTHER, 11
B.frame = { powered = true, text = 'B-CAR2' }
asClient(B, B.relay.publishTick)
expect('withdraw-from-old-vehicle',
    bagOf(CAR) == nil,
    'moving to another car left a value on the old one that nothing would clear')
expect('publish-to-new-vehicle',
    bagOf(OTHER) ~= nil and bagOf(OTHER).text == 'B-CAR2' and bagOf(OTHER).netId == 11,
    'moving to another car did not start publishing on it')

-- Explicit withdrawal, which is what a resource stop calls. Every ordinary case is
-- immediate because of this; the stale window is only for the ones that are not.
asClient(B, B.relay.withdraw)
expect('explicit-withdraw',
    bagOf(OTHER) == nil and B.relay.publishedVehicle() == nil,
    'withdraw left the published value behind')

-- Idempotent, and safe against a vehicle that has gone: the lifecycle calls it for
-- cars that no longer exist.
entities[OTHER] = nil
asClient(B, B.relay.withdraw)
expect('withdraw-is-idempotent', true, 'withdraw raised on a second call')

-- A client with nothing to say publishes nothing and raises nothing.
local D = newClient(4)
asClient(D, D.relay.publishTick)
expect('on-foot-publishes-nothing',
    D.relay.publishedVehicle() == nil,
    'a client on foot published a frame')

-- ════════════════════════════════════════════════════════════════════════════
--  THE DESCRIPTOR IS CHECKED AT CREATE TIME
-- ════════════════════════════════════════════════════════════════════════════
--
-- Every one of these is otherwise a nil call deep inside a publish pass, which in
-- game is a client-side error once every 250ms and no picture at all.

local function refuses(descriptor)
    return select(1, pcall(FrameRelay.create, descriptor)) == false
end
expect('descriptor-is-required', refuses(nil), 'create accepted a nil descriptor')
expect('key-is-required',
    refuses({ sanitise = sanitise, differs = differs, frame = function() end }),
    'create accepted a descriptor with no statebag key')
expect('callbacks-are-required',
    refuses({ key = 'k', sanitise = sanitise, differs = differs }),
    'create accepted a descriptor with no frame provider')

-- ════════════════════════════════════════════════════════════════════════════
--  THE CONTROL'S OWN BOOKKEEPING
-- ════════════════════════════════════════════════════════════════════════════

if CONTROL ~= nil then
    local missing, n = {}, 0
    for label in pairs(expectedFlips) do
        n = n + 1
        if not seenFlips[label] then missing[#missing + 1] = label end
    end
    if #missing > 0 then
        error(('control %q: %d of %d expected flips never happened: %s')
            :format(CONTROL, #missing, n, table.concat(missing, ', ')), 0)
    end
    -- A floor under the run itself. If a future edit removes the assertions this
    -- control targets, the loop above is vacuous and the control would pass having
    -- measured nothing.
    if n == 0 then
        error(('control %q expects no flips, which cannot prove anything'):format(CONTROL), 0)
    end
    error(('CONTROL %s: all %d expected assertions flipped (this exit is the PASS for a control run)')
        :format(CONTROL, n), 0)
end

print('PASS framerelay-election')
