--[[
    tLib — THE VEHICLE FRAME RELAY

    Loaded into the CONSUMER's VM like every other module under shared/imports/:
    `tlib.framerelay`. Client only.

        local relay = tlib.framerelay.create({
            key       = 'tdetScreenFrame',
            frame     = function() return localFrame end,
            hasScreen = function(vehicle) return tdetGetAttachedProp(vehicle) ~= nil end,
            sanitise  = tdetScreenSanitiseFrame,
            differs   = tdetScreenFrameDiffers,
        })

     What this is for

    How a screen belonging to a car you are NOT operating gets something to show.
    Only the client running the device computes its picture, and that client is
    not the one looking at the prop.

    So the client that HAS the picture publishes it, on the VEHICLE's statebag, and
    everyone who can see the vehicle reads it — the rear passengers, the officer at
    the window, and the front passenger whose own device is stopped. A statebag is
    readable by anyone in scope, where a point-to-point seat relay only ever reaches
    one partner.

     What is OWNED HERE and what is the consumer's

    The relay owns publication, expiry and withdrawal. The consumer owns the frame
    itself — producing it, sanitising it, and deciding whether two differ.

    THE RELAY TOUCHES EXACTLY THREE FIELDS of a payload, and they are part of the
    contract:
      * `seq`     — written by the publisher, read by the reader. The expiry rides on
                    it, so a payload may not use that name for anything else.
      * `netId`   — written by the publisher, for cross-checking by hand.
      * `powered` — READ, never written. A switched-off device publishes NOTHING
                    rather than an off frame: the prop's baked artwork already IS the
                    off state, so the absence of a value renders correctly with no
                    work anywhere. Every consumer wanted this and stating it once is
                    the point.

     WHY THE ELECTION

     Two occupants of one vehicle would otherwise write the same statebag key with
     two different pictures, each overwriting the other every tick. So exactly one
     publishes: `occupancy.isController()`. The suite that proves this is
     tests/lua/framerelay-election.lua, and it needs two clients over one statebag
     world because no single-VM resource suite can reach the state at all.

     TWO HARD-WON FACTS ABOUT THIS PATTERN

     * POLL IT; DO NOT USE AddStateBagChangeHandler. The condition is not "the value
       changed", it is "the value changed AND the consumer still names this vehicle
       AND it has not gone stale", and two of those three produce no statebag event
       at all. A handler latches on whatever it last heard.
     * A STATEBAG IS NOT WITHDRAWN WHEN ITS WRITER DISCONNECTS, and the write only
       lands while the writer OWNS the entity — ownership migration silently stops
       it. Hence `seq`, which moves on every publish including an identical one, and
       hence the stale window. Without them a driver whose game crashed leaves their
       last alert painted on the prop for as long as the car exists.

]]

local FrameRelay = {}

--- How often a publisher looks at whether it owes the vehicle a write, in ms.
---
FrameRelay.PUBLISH_MS = 250

--- How long a publisher will go without writing anything at all, in ms.
---
FrameRelay.HEARTBEAT_MS = 1000

--- How long a value may go without its `seq` moving before it is leftovers, in ms.
---
FrameRelay.STALE_MS = FrameRelay.HEARTBEAT_MS * 3

--- @param descriptor table
---   key          string    the statebag key, e.g. 'tdetScreenFrame'
---   frame        function  () -> the local payload, or nil when there is none
---   sanitise     function  (raw) -> payload|nil, coerced to what the page expects
---   differs      function  (a, b) -> boolean, "anything the prop can show changed"
---   hasScreen    function? (vehicle) -> boolean. Defaults to "yes".
---   heartbeatMs  number?   overrides FrameRelay.HEARTBEAT_MS
---   staleMs      number?   overrides FrameRelay.STALE_MS
function FrameRelay.create(descriptor)
    assert(type(descriptor) == 'table', 'tlib.framerelay.create: descriptor table required')
    local d = descriptor

    assert(type(d.key) == 'string' and d.key ~= '',
        'tlib.framerelay.create: descriptor.key must be a non-empty statebag key')
    for _, name in ipairs({ 'frame', 'sanitise', 'differs' }) do
        assert(type(d[name]) == 'function',
            ('tlib.framerelay.create: descriptor.%s must be a function'):format(name))
    end

    local KEY          = d.key
    local HEARTBEAT_MS = d.heartbeatMs or FrameRelay.HEARTBEAT_MS
    local STALE_MS     = d.staleMs or FrameRelay.STALE_MS
    local hasScreen    = d.hasScreen

    local instance = {}

    -- Publish side

    local publishedVehicle = nil
    local publishedFrame   = nil
    local publishSeq       = 0
    local publishedAt      = 0

    --- Withdraw whatever we published, if anything. Idempotent.
    ---
    function instance.withdraw()
        local vehicle = publishedVehicle
        publishedVehicle, publishedFrame = nil, nil
        if not vehicle or not DoesEntityExist(vehicle) then return end
        Entity(vehicle).state:set(KEY, nil, true)
    end

    --- One publish pass. Safe to call every frame; it writes rarely.
    function instance.publishTick()
        local occupancy = tlib.occupancy
        local vehicle, netId = occupancy.myVehicle()
        local mine = vehicle ~= nil and occupancy.isController() == true

        local present = mine and (hasScreen == nil or hasScreen(vehicle) == true)
        local raw = present and d.frame() or nil
        local frame = (type(raw) == 'table' and raw.powered == true) and d.sanitise(raw) or nil

        if frame == nil then
            instance.withdraw()
            return
        end

        if publishedVehicle and publishedVehicle ~= vehicle then instance.withdraw() end

        local now = GetGameTimer()
        if publishedVehicle == vehicle
            and not d.differs(publishedFrame, frame)
            and (now - publishedAt) < HEARTBEAT_MS
        then
            return
        end

        publishSeq       = publishSeq + 1
        publishedVehicle = vehicle
        publishedFrame   = frame
        publishedAt      = now

        frame.seq   = publishSeq
        frame.netId = netId
        Entity(vehicle).state:set(KEY, frame, true)
    end

    function instance.publishedVehicle() return publishedVehicle end

    --- The sequence number of the last write. Same purpose.
    function instance.publishedSeq() return publishSeq end

    -- Read side

    local remoteSeq     = nil
    local remoteSeqAt   = 0
    local remoteVehicle = nil

    --- The payload published on `vehicle`, or nil — covering "there is none" and "the
    --- one there is has gone stale". Poll-driven; see the header.
    function instance.read(vehicle)
        -- A different car's counter says nothing about this one's.
        if remoteVehicle ~= vehicle then
            remoteVehicle = vehicle
            remoteSeq, remoteSeqAt = nil, 0
        end

        local raw = Entity(vehicle).state[KEY]
        if type(raw) ~= 'table' then return nil end

        -- A `seq` that is not a number is not merely invalid, it is UNEXPIRABLE, so it
        -- is rejected outright rather than clamped.
        local seq = tonumber(raw.seq)
        if not seq then return nil end

        local now = GetGameTimer()
        if seq ~= remoteSeq then
            remoteSeq, remoteSeqAt = seq, now
        elseif now - remoteSeqAt > STALE_MS then
            -- The same number for longer than anyone still publishing would leave it:
            -- the writer crashed, disconnected, or lost ownership of the vehicle.
            return nil
        end

        return d.sanitise(raw)
    end

    return instance
end

return FrameRelay
