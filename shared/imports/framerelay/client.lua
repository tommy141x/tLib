--[[
    tLib — THE VEHICLE FRAME RELAY. Client-only, loaded as `tlib.framerelay`.

        local relay = tlib.framerelay.create({
            key       = 'tdetScreenFrame',
            frame     = function() return localFrame end,
            hasScreen = function(vehicle) return tdetGetAttachedProp(vehicle) ~= nil end,
            sanitise  = tdetScreenSanitiseFrame,
            differs   = tdetScreenFrameDiffers,
        })

    Lets a screen belonging to a car you are NOT operating show something: the
    client that computes the picture publishes it on the VEHICLE's statebag
    (readable by anyone in scope — rear passengers, the officer outside, a
    front passenger whose own device is off), instead of a point-to-point
    relay that only reaches one partner.

    The relay owns publication/expiry/withdrawal; the consumer owns the frame.
    Three contract fields: `seq` (publisher-written, expiry rides on it —
    don't reuse the name), `netId` (publisher-written, for manual
    cross-checking), `powered` (read-only; an off device publishes NOTHING
    rather than an off frame, since the prop's baked artwork already is the
    off state).

    Election: two occupants would otherwise overwrite the same key every
    tick, so exactly one publisher runs, gated by `occupancy.isController()`
    (proved by tests/lua/framerelay-election.lua, which needs two clients
    over one statebag world).

    Poll it — do not use AddStateBagChangeHandler, since "changed AND still
    names this vehicle AND not stale" produces no event for two of those
    three and a handler latches on stale data. A statebag is not withdrawn
    when its writer disconnects or loses entity ownership, hence `seq`
    (moves on every publish) and the stale window — without them a crashed
    driver's last frame stays painted on the prop forever.
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
