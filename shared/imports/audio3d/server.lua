--[[
    tlib.audio3d — the transport half of positional device audio (SERVER).

    Its NUI half is tLib/internal/shared-ts/audio3d. This side answers one question and
    nothing else: WHO is close enough to be told that a device made a noise.

    ## The emitter is the vehicle

    These are dash-mounted devices. A bus never looks at where the player who
    sent the sound is standing — it resolves the vehicle they are aboard through
    tlib.occupancy and fans out around THAT. A sender who is not in a vehicle
    emits nothing at all, which is the correct answer for a device bolted to a
    dashboard: there is no dashboard.

    tRadio learned this the hard way; its in-cabin case emitted from the ped
    until it was fixed, and it sounded like the officer was the radio.

    ## Everything here is a cap

    The payload originates in a NUI, which means it originates in a place a
    player can reach. So:

      * `fields` is a whitelist. An unknown key is dropped, not forwarded, and a
        value of the wrong type or outside its bounds drops the whole message.
      * `minIntervalMs` is a rate limit keyed by vehicle and not by player, so
        two officers in one car cannot double the rate by taking turns. It is
        partitioned by `rateBy` — one field of the payload, usually the sound
        class — because a single per-emitter floor would let a device's
        continuous tone, which retunes ten times a second, throttle out the
        alert tone that actually matters. `maxPerSecond` then bounds the sum of
        the partitions, so adding classes cannot add bandwidth without limit.
      * `maxReceivers` is a per-broadcast event cap. Past it the nearest N are
        kept, because the ones past the cap are the quiet ones.
      * the sender is never a receiver. Their own UI is already sounding the
        device dry; see `markLocal` in the NUI half for the general case.

    ## Usage

        local bus = tlib.audio3d.createBus({
            event  = 'tradar:worldSound',
            range  = Config.audioRange,
            fields = { kind = { type = 'string', max = 16 } },
        })
        RegisterNetEvent('tradar:emitWorldSound', function(payload)
            bus:emit(source, payload)
        end)
]]

local audio3d = {}

--- Per-broadcast event cap. A city block's worth of receivers is already more
--- than anyone can pick apart; past this the extra events are pure cost.
local DEFAULT_MAX_RECEIVERS = 24

--- Per-emitter floor between broadcasts, in ms. Deliberately coarser than a
--- frame: this transport carries EVENTS and CADENCE DESCRIPTORS, never a packet
--- per beep — tDetector's own client/cl_cabin.lua refused that shape and it is
--- refused here too.
local DEFAULT_MIN_INTERVAL_MS = 100

--- Hard ceiling on broadcasts per emitter per second, across every rate
--- partition. `minIntervalMs` shapes the traffic; this bounds it.
local DEFAULT_MAX_PER_SECOND = 20

--- Ceiling on any range a consumer can ask for, so a mistyped config cannot turn
--- one beep into an event for every player on the server.
local MAX_RANGE = 250

local function platform() return tlib.platform end
local function occupancy() return tlib.occupancy end

--- The cached coordinate index. Readied here rather than in every consumer:
--- a bus that queried an un-readied index would find nobody and emit silence,
--- which is indistinguishable from "there was nobody there".
local function spatial()
    local s = tlib.spatial
    s.setReady()
    return s
end

local function clampNumber(v, lo, hi, fallback)
    if type(v) ~= 'number' or v ~= v then return fallback end
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

--- Validate one client-supplied value against its field rule.
--- @return ok, value
local function checkField(rule, value)
    if rule.type == 'string' then
        if type(value) ~= 'string' then return false end
        if #value == 0 or #value > (rule.max or 64) then return false end
        return true, value
    end
    if rule.type == 'number' then
        if type(value) ~= 'number' or value ~= value then return false end
        if rule.min and value < rule.min then return false end
        if rule.max and value > rule.max then return false end
        return true, value
    end
    if rule.type == 'boolean' then
        if type(value) ~= 'boolean' then return false end
        return true, value
    end
    return false
end

local Bus = {}
Bus.__index = Bus

--- Whitelist a client payload down to the declared fields.
--- @return table|nil — nil when any present field is malformed.
function Bus:sanitize(payload)
    if type(payload) ~= 'table' then return nil end
    local out = {}
    for key, rule in pairs(self.fields) do
        local value = payload[key]
        if value ~= nil then
            local ok, clean = checkField(rule, value)
            -- A bad value is a rejected MESSAGE, not a dropped field. Forwarding
            -- the rest would deliver a half-message the consumer has no way to
            -- tell from a whole one.
            if not ok then return nil end
            out[key] = clean
        elseif rule.required then
            return nil
        end
    end
    return out
end

--- Widen or narrow the reach. Config reload, admin panel.
function Bus:setRange(range)
    self.range = clampNumber(range, 0, MAX_RANGE, self.range)
end

--- The reach currently in force, in metres.
function Bus:getRange()
    return self.range
end

--- Who is currently within reach of `netId`, sender excluded and capped.
--- Exposed so a consumer can reason about its own fan-out; `emit` uses it.
function Bus:receivers(netId, sender)
    local p = platform()
    local entity = p.resolveNetworkId(netId)
    if not entity or entity == 0 or not p.doesEntityExist(entity) then return {}, nil end
    local coords = p.getEntityCoords(entity)
    if type(coords) ~= 'table' then return {}, nil end

    local nearby = spatial().getNearbyPlayers(coords, self.range)
    local out = {}
    for i = 1, #nearby do
        local id = nearby[i]
        if id ~= sender then out[#out + 1] = id end
    end

    if #out <= self.maxReceivers then return out, coords end

    -- Over the cap. Keep the nearest, because the ones being dropped are by
    -- definition the quietest — the curve has them below EDGE_GAIN anyway.
    -- The extra coordinate reads only happen on this branch.
    local scored = {}
    for i = 1, #out do
        local pc = p.getPlayerCoords(out[i])
        local d = math.huge
        if type(pc) == 'table' then
            local dx, dy, dz = coords.x - pc.x, coords.y - pc.y, coords.z - pc.z
            d = dx * dx + dy * dy + dz * dz
        end
        scored[#scored + 1] = { id = out[i], d = d }
    end
    table.sort(scored, function(a, b) return a.d < b.d end)
    local capped = {}
    for i = 1, self.maxReceivers do capped[i] = scored[i].id end
    self.counters.capped = self.counters.capped + 1
    return capped, coords
end

--- The two-level rate limit, as one answer.
---
--- Level one is `minIntervalMs` within a partition — `rateBy` names the payload
--- field that chooses the partition, so a retuning tone and an alert tone hold
--- separate floors and neither can starve the other. Level two is
--- `maxPerSecond` across all of them, counted in a one-second sliding window, so
--- a consumer that invents ten classes does not thereby get ten times the wire.
function Bus:allow(netId, clean, now)
    local bucket = self.lastEmit[netId]
    if bucket == nil then
        bucket = { partitions = {}, windowStart = now, count = 0 }
        self.lastEmit[netId] = bucket
    end

    if (now - bucket.windowStart) >= 1000 then
        bucket.windowStart = now
        bucket.count = 0
    end
    if bucket.count >= self.maxPerSecond then return false end

    local key = 'all'
    if self.rateBy ~= nil then
        local v = clean[self.rateBy]
        if v ~= nil then key = tostring(v) end
    end
    local last = bucket.partitions[key]
    if last ~= nil and (now - last) < self.minIntervalMs then return false end

    bucket.partitions[key] = now
    bucket.count = bucket.count + 1
    return true
end

--- Broadcast one sound from `src`'s vehicle.
---
--- Returns the number of receivers it reached, which is 0 for every rejection —
--- on foot, rate-limited, malformed, or simply nobody nearby. A consumer that
--- wants to tell those apart should read `bus:stats()`.
function Bus:emit(src, payload)
    local clean = self:sanitize(payload)
    if clean == nil then
        self.counters.rejected = self.counters.rejected + 1
        return 0
    end

    local _, netId = occupancy().refreshOccupant(src)
    if netId == nil then
        -- On foot. A dash device has no dashboard to be bolted to.
        self.counters.notAboard = self.counters.notAboard + 1
        return 0
    end

    local now = platform().now()
    if not self:allow(netId, clean, now) then
        self.counters.throttled = self.counters.throttled + 1
        return 0
    end

    local targets = self:receivers(netId, src)
    if #targets == 0 then return 0 end

    clean.vehicle = netId
    for i = 1, #targets do
        TriggerClientEvent(self.event, targets[i], clean)
    end
    self.counters.sent = self.counters.sent + 1
    self.counters.delivered = self.counters.delivered + #targets
    return #targets
end

--- Counters since boot. Diagnostics; nothing reads these to make a decision.
function Bus:stats()
    return {
        sent = self.counters.sent,
        delivered = self.counters.delivered,
        throttled = self.counters.throttled,
        rejected = self.counters.rejected,
        notAboard = self.counters.notAboard,
        capped = self.counters.capped,
    }
end

--- Forget a vehicle's rate-limit slot. Called for you when a vehicle's last
--- occupant leaves; exposed for consumers with their own teardown.
function Bus:forget(netId)
    self.lastEmit[netId] = nil
end

--- Build a bus.
---
--- `event` is the net event name the matching client receiver listens on, and it
--- is the consumer's to choose: two resources sharing one name would deliver each
--- other's sounds.
---
--- `range` MUST come from the consumer's config and MUST exceed whatever range
--- that resource reads its own screen at. A device you can read but cannot hear
--- is backwards, and there is no default here that could know the right number.
function audio3d.createBus(opts)
    opts = type(opts) == 'table' and opts or {}
    assert(type(opts.event) == 'string' and #opts.event > 0,
        'tlib.audio3d.createBus: `event` is required')
    assert(type(opts.range) == 'number' and opts.range > 0,
        'tlib.audio3d.createBus: `range` is required and must be a positive number of metres')

    local bus = setmetatable({
        event = opts.event,
        range = clampNumber(opts.range, 0, MAX_RANGE, MAX_RANGE),
        maxReceivers = math.floor(clampNumber(opts.maxReceivers, 1, 128, DEFAULT_MAX_RECEIVERS)),
        minIntervalMs = clampNumber(opts.minIntervalMs, 0, 10000, DEFAULT_MIN_INTERVAL_MS),
        maxPerSecond = math.floor(clampNumber(opts.maxPerSecond, 1, 120, DEFAULT_MAX_PER_SECOND)),
        rateBy = type(opts.rateBy) == 'string' and opts.rateBy or nil,
        fields = type(opts.fields) == 'table' and opts.fields or {},
        lastEmit = {},
        counters = { sent = 0, delivered = 0, throttled = 0, rejected = 0, notAboard = 0, capped = 0 },
    }, Bus)

    audio3d._buses[#audio3d._buses + 1] = bus
    return bus
end

audio3d._buses = {}
audio3d.MAX_RANGE = MAX_RANGE
audio3d.DEFAULT_MAX_RECEIVERS = DEFAULT_MAX_RECEIVERS
audio3d.DEFAULT_MIN_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS
audio3d.DEFAULT_MAX_PER_SECOND = DEFAULT_MAX_PER_SECOND

-- A disconnected player's vehicle may have been theirs alone. Sweeping the
-- rate-limit table on drop keeps it from growing for the life of the server;
-- nothing else here holds per-player state.
AddEventHandler('playerDropped', function()
    local src = source
    local _, netId = occupancy().occupantSeatOf(src)
    if netId == nil then return end
    for i = 1, #audio3d._buses do audio3d._buses[i]:forget(netId) end
end)

return audio3d
