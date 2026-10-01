--[[
    tlib.audio3d — the transport half of positional device audio (CLIENT).

    Receives what the server fanned out, resolves where each emitter actually is
    from this client's own copy of the world, and feeds the NUI half
    (tLib/shared/ts/audio3d) one batched frame per tick.

    ## Positions are resolved here, not streamed

    The server sends a vehicle NETWORK ID and never a coordinate. Every client
    already has that vehicle; reading its position locally is free, exact for
    that client, and costs nothing on the wire — where a streamed coordinate
    would be a packet per emitter per tick and still be a frame stale.

    ## One message per tick, not one per emitter

    `SendNUIMessage` is a JSON encode and a cross-process hop. The listener pose
    and every emitter position go in a single frame, at a rate chosen by how fast
    the listener is moving: someone standing still does not need 60 Hz, and
    someone doing 90 mph past a parked cruiser does.

    ## `send` takes ONE table, which already carries `action`

    Every call this module makes is `self.send({ action = <string>, ... })` — a
    single table, complete, with its own `action` key. It is NOT the
    `(action, data)` shape most resources' own `sendHud` uses.

    Handing such a `sendHud` straight in builds `{ action = <table> }`, and
    tLib's own `onNuiEvent` (shared/ts/nui.ts) refuses any message whose `action`
    is not a string — so every frame is dropped by the browser, silently, and the
    feature looks exactly like it was never wired up. tRadar shipped that.

    If your sender takes `(action, data)`, bridge it in one line.

    ## Usage

        -- sendHud(action, data) -> the one-table shape this module calls with.
        local function sendWorldAudio(msg)
            sendHud(msg.action, msg)
        end

        local rx = tlib.audio3d.createReceiver({
            event = 'tradar:worldSound',
            range = Config.audioRange,
            send  = sendWorldAudio,       -- this resource's own NUI sender, bridged
        })
        rx:setLocal(myVehicleNetId)       -- the unit my own UI already sounds
]]

local audio3d = {}

--- Update rates by listener speed, in ms. The same ladder tRadio measured:
--- position error is a function of speed, so the sampling rate should be too.
local POS_UPDATE_FAST_MS = 16
local POS_UPDATE_MEDIUM_MS = 33
local POS_UPDATE_SLOW_MS = 50
local SPEED_FAST_THRESHOLD = 15
local SPEED_SLOW_THRESHOLD = 5

--- Nothing to do: no live emitters. Idled rather than stopped, so an emitter
--- arriving does not have to wait for a thread to be created.
local IDLE_MS = 250

--- An emitter with no traffic for this long is abandoned.
---
--- The backstop for a lost stop. A continuous tone is held by this side until it
--- is explicitly stopped, so without this a dropped stop-packet from a car that
--- has since despawned would leave a tone running for the rest of the session.
--- Generous relative to the server's 100 ms floor: this reclaims a genuinely
--- orphaned emitter, it does not cut a live one.
local DEFAULT_KEEPALIVE_MS = 6000

--- Beyond this multiple of the configured range an emitter is dropped outright
--- rather than merely being inaudible. The curve already has it below EDGE_GAIN;
--- this stops us resolving an entity and encoding a position for it every tick.
local CULL_FACTOR = 1.25

local function platform() return tlib.platform end

--- Camera forward vector from GTA's pitch/yaw, in the engine's Z-up frame.
local function forwardFrom(rotation)
    local pitch = math.rad(rotation and rotation.x or 0.0)
    local yaw = math.rad(rotation and rotation.z or 0.0)
    local cp = math.cos(pitch)
    return { x = -math.sin(yaw) * cp, y = math.cos(yaw) * cp, z = math.sin(pitch) }
end

local Receiver = {}
Receiver.__index = Receiver

--- The emitter id a netId is known by, on both sides of the NUI boundary.
function audio3d.emitterId(netId)
    return 'veh:' .. tostring(netId)
end

--- Name the vehicle whose device THIS client's own UI is already sounding dry.
---
--- Half of the dedup; the other half is `markLocal` in the NUI, which refuses
--- every sound routed to the marked id even if one slips through here. Two
--- copies of the same tone a few milliseconds apart comb-filter — tRadio's voice
--- path shipped exactly that — so the guard is built in on both sides rather
--- than relied upon in one.
---
--- Pass `nil` on leaving the vehicle.
function Receiver:setLocal(netId)
    local id = netId ~= nil and audio3d.emitterId(netId) or nil
    if id == self.localId then return end
    self.localId = id
    -- Drop anything already running under it: a player moving from the back seat
    -- to the driver's seat was hearing the panned copy a moment ago.
    if id ~= nil and self.emitters[id] ~= nil then
        self.emitters[id] = nil
        self.dropped[#self.dropped + 1] = id
    end
    self.send({ action = self.prefix .. ':local', id = id })
end

--- The marked local emitter id, or nil. Diagnostics and tests.
function Receiver:getLocal()
    return self.localId
end

--- Live emitter ids. Diagnostics and tests.
function Receiver:activeEmitters()
    local out = {}
    for id in pairs(self.emitters) do out[#out + 1] = id end
    table.sort(out)
    return out
end

function Receiver:setRange(range)
    if type(range) ~= 'number' or range ~= range or range <= 0 then return end
    self.range = range
    self.send({ action = self.prefix .. ':range', range = range })
end

--- Accept one broadcast. Returns true when it was forwarded to the NUI.
---
--- Separated from the event handler so a test can drive it without a network,
--- and so the validation reads as one thing.
function Receiver:accept(payload)
    if type(payload) ~= 'table' then return false end
    local netId = payload.vehicle
    if type(netId) ~= 'number' then return false end
    local id = audio3d.emitterId(netId)
    -- The dedup, on the receiving side of the wire. The server already excludes
    -- the sender; this catches the other cases — a passenger whose own UI is
    -- mirroring the unit, or a stale local mark on a car that changed hands.
    if id == self.localId then
        self.counters.deduped = self.counters.deduped + 1
        return false
    end

    local now = platform().now()
    local e = self.emitters[id]
    if e == nil then
        e = { netId = netId, lastSeen = now }
        self.emitters[id] = e
    else
        e.lastSeen = now
    end

    payload.id = id
    payload.action = self.prefix .. ':sound'
    self.send(payload)
    self.counters.received = self.counters.received + 1
    return true
end

--- Build and send one frame: the listener pose plus every live emitter.
function Receiver:pushFrame()
    local p = platform()
    local cam = p.getCameraState()
    if type(cam) ~= 'table' or type(cam.position) ~= 'table' then return IDLE_MS end

    local now = p.now()
    local cull = self.range * CULL_FACTOR
    local cullSq = cull * cull
    local emitters = {}

    for id, e in pairs(self.emitters) do
        local drop = (now - e.lastSeen) > self.keepAliveMs
        local coords
        if not drop then
            local entity = p.resolveNetworkId(e.netId)
            if not entity or entity == 0 or not p.isEntityValid(entity) then
                -- The car is no longer streamed to this client, or is gone. Either
                -- way there is nothing here to hear.
                drop = true
            else
                coords = p.getEntityPosition(entity)
                local dx = cam.position.x - coords.x
                local dy = cam.position.y - coords.y
                local dz = cam.position.z - coords.z
                if (dx * dx + dy * dy + dz * dz) > cullSq then drop = true end
            end
        end

        if drop then
            self.emitters[id] = nil
            self.dropped[#self.dropped + 1] = id
        else
            emitters[#emitters + 1] = { id = id, x = coords.x, y = coords.y, z = coords.z }
        end
    end

    local dropped = self.dropped
    self.dropped = {}

    self.send({
        action = self.prefix .. ':frame',
        listener = {
            position = cam.position,
            forward = forwardFrom(cam.rotation),
            up = { x = 0.0, y = 0.0, z = 1.0 },
        },
        emitters = emitters,
        dropped = dropped,
    })

    if #emitters == 0 and #dropped == 0 then return IDLE_MS end
    local speed = cam.speed or 0
    if speed > SPEED_FAST_THRESHOLD then return POS_UPDATE_FAST_MS end
    if speed > SPEED_SLOW_THRESHOLD then return POS_UPDATE_MEDIUM_MS end
    return POS_UPDATE_SLOW_MS
end

--- Counters since boot. Diagnostics.
function Receiver:stats()
    return { received = self.counters.received, deduped = self.counters.deduped }
end

--- Silence everything in the NUI and forget every emitter.
---
--- A NUI frame can outlive the Lua that was driving it — a resource restart does
--- not necessarily destroy CEF — and the new script instance starts with an empty
--- emitter table, so it will never send a stop for anything the old one started.
--- A looping cadence would then play for the rest of the session. Called for you
--- on `onResourceStop`; exposed because a consumer may have its own teardown.
function Receiver:stopAll()
    self.emitters = {}
    self.dropped = {}
    self.localId = nil
    pcall(function() self.send({ action = self.prefix .. ':stopAll' }) end)
end

--- Build a receiver.
---
--- `send` is the consumer's OWN NUI sender, not tLib's: a resource that declares
--- its own `ui_page` has its own browser and its own ready-handshake queue, and
--- routing through tLib's would deliver these frames to the wrong page.
function audio3d.createReceiver(opts)
    opts = type(opts) == 'table' and opts or {}
    assert(type(opts.event) == 'string' and #opts.event > 0,
        'tlib.audio3d.createReceiver: `event` is required')
    assert(type(opts.send) == 'function',
        'tlib.audio3d.createReceiver: `send` is required — this resource\'s own NUI sender')
    assert(type(opts.range) == 'number' and opts.range > 0,
        'tlib.audio3d.createReceiver: `range` is required and must be a positive number of metres')

    local rx = setmetatable({
        event = opts.event,
        prefix = type(opts.prefix) == 'string' and opts.prefix or 'audio3d',
        send = opts.send,
        range = opts.range,
        keepAliveMs = type(opts.keepAliveMs) == 'number' and opts.keepAliveMs or DEFAULT_KEEPALIVE_MS,
        emitters = {},
        dropped = {},
        localId = nil,
        counters = { received = 0, deduped = 0 },
    }, Receiver)

    RegisterNetEvent(rx.event)
    AddEventHandler(rx.event, function(payload)
        -- Server-only. A client can trigger a net event on another client's
        -- handler in FiveM; `source` is 65535 exactly when the server sent it.
        if source ~= 65535 then return end
        rx:accept(payload)
    end)

    AddEventHandler('onResourceStop', function(resourceName)
        if resourceName ~= GetCurrentResourceName() then return end
        rx:stopAll()
    end)

    CreateThread(function()
        -- One tick before the first push: `send` is usually a queue that is not
        -- flushed until the NUI reports ready, and the range is boot state the
        -- page needs before any frame means anything.
        Wait(0)
        rx.send({ action = rx.prefix .. ':range', range = rx.range })
        while true do
            local ok, wait = pcall(function() return rx:pushFrame() end)
            Wait(ok and wait or IDLE_MS)
        end
    end)

    audio3d._receivers[#audio3d._receivers + 1] = rx
    return rx
end

audio3d._receivers = {}
audio3d.DEFAULT_KEEPALIVE_MS = DEFAULT_KEEPALIVE_MS
audio3d.CULL_FACTOR = CULL_FACTOR
audio3d._forwardFrom = forwardFrom

return audio3d
