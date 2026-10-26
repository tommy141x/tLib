-- Which vehicle's device screen this client renders. Client only.
--
-- ADD_REPLACE_TEXTURE is keyed on the ORIGINAL texture object, which every
-- instance of an archetype shares. Replacing `rdx_screen` does not replace it on
-- one prop, it replaces it on every rdx4000 the client can see, and there is no
-- per-entity variant of the native. A DUI per vehicle is not an escape either:
-- CREATE_RUNTIME_TXD pins a `ytd` streaming slot and has no destructor.
--
-- So there is exactly one screen, and the only question left is which vehicle it
-- shows. Answered the same way for all three resources, so a player walking
-- between props gets one notion of "the one in front of me":
--
-- 1. The vehicle you are aboard wins, in any seat, whenever it has a screen.
--    Not "the nearest" -- a car alongside is often closer than your own
--    dashboard. Asked of `occupancy.cabin()`.
-- 2. Otherwise the nearest vehicle with a screen, within `range`.
-- 3. Hysteresis, because rule 2 alone flaps: two cars at similar distance
--    would swap the incumbency every pass, and since the texture is global
--    every prop in the world would strobe between two devices' readings.
-- 4. No candidate is an answer: `update` returns nil and the consumer tears
--    its browser down rather than leave stale numbers painted on every prop.
--
-- Every native is an injectable provider, so tests/lua/screentarget-arbitration
-- drives THIS file rather than a re-implementation of it.
--

local screentarget = {}

-- Defaults

--- How far away a screen is still worth rendering, in metres. "Close enough to
--- read a small display through a window", not "close enough to hear the
--- device" -- deliberately different numbers, and this is the short one.
--- Consumers are expected to override it from their own config.
screentarget.DEFAULT_RANGE_M = 8.0

--- How much closer a challenger must be than the incumbent before it takes over.
--- Absolute metres, not a fraction: the flap happens where two candidates are
--- nearly equidistant, where a proportional margin collapses to nothing. Two
--- metres is about one car width.
screentarget.DEFAULT_SWITCH_MARGIN_M = 2.0

--- Minimum time an incumbent holds before any challenger may displace it, in ms.
--- The margin alone isn't enough: two vehicles driving alongside weave by more
--- than a margin's worth over a few seconds, which reads as the device
--- glitching. A floor on displacement only -- losing the incumbent outright is
--- never delayed.
screentarget.DEFAULT_DWELL_MS = 1500

-- Sources

--- Why the current target was chosen. Consumers branch on this: `SOURCE_OWN`
--- means the local NUI is looking at the same device and may drive the screen
--- directly; `SOURCE_NEAREST` means the content has to come off the vehicle.
screentarget.SOURCE_OWN     = "own"
screentarget.SOURCE_NEAREST = "nearest"

-- Native providers
--

local function defaultVehicles()
    return GetGamePool("CVehicle")
end

--- Whether a BOOL native said yes. On this build, DoesEntityExist,
--- NetworkDoesNetworkIdExist, IsPedInAnyVehicle, IsEntityAVehicle and
--- HasModelLoaded all return the number 1, not `true`, so `native(...) == true`
--- is always false. `not not v` is not a fix either -- 0 is truthy in Lua.
local function nativeTruth(v)
    if v == true then return true end
    return type(v) == "number" and v ~= 0
end

local function defaultExists(entity)
    return nativeTruth(DoesEntityExist(entity))
end

local function defaultPositionOf(entity)
    local c = GetEntityCoords(entity)
    return { x = c.x, y = c.y, z = c.z }
end

local function defaultMyPosition()
    local c = GetEntityCoords(PlayerPedId())
    return { x = c.x, y = c.y, z = c.z }
end

local function defaultNetIdOf(entity)
    return NetworkGetNetworkIdFromEntity(entity)
end

local function defaultNow()
    return GetGameTimer()
end

--- The vehicle the local player is sitting in, in ANY seat, or nil.
--- `occupancy.cabin()` and NOT `myVehicle()`: myVehicle answers "the vehicle I am
--- operating" and is nil for a rear passenger, which is the opposite of what
--- rule 1 needs.
local function defaultAboard()
    local occupancy = tlib.occupancy
    if type(occupancy) ~= "table" or type(occupancy.cabin) ~= "function" then return nil end
    return occupancy.cabin()
end

local function distance(a, b)
    if a == nil or b == nil then return nil end
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

-- The arbiter

--- Build an arbiter. One per DEVICE KIND, not per resource and not global:
--- tDetector's rdx4000 and tRadar's counting unit are different props on
--- different vehicles and each has its own nearest. Only the rules are shared.
---
--- @param opts table
---   hasScreen   (required) function(vehicle) -> truthy if this vehicle carries a
---               prop of the kind this arbiter is picking for. The consumer owns
---               this: only it knows what it streams.
---   range       metres; defaults to DEFAULT_RANGE_M
---   switchMargin metres; defaults to DEFAULT_SWITCH_MARGIN_M
---   dwellMs     ms; defaults to DEFAULT_DWELL_MS
---   vehicles, exists, positionOf, myPosition, netIdOf, now, aboard
---               native providers, each defaulting as above. Present so a suite
---               can drive the real rules with no game attached.
function screentarget.create(opts)
    opts = opts or {}

    local hasScreen = opts.hasScreen
    if type(hasScreen) ~= "function" then
        error("tlib.screentarget.create requires a hasScreen(vehicle) function", 2)
    end

    local self = {}

    local range        = tonumber(opts.range) or screentarget.DEFAULT_RANGE_M
    local switchMargin = tonumber(opts.switchMargin) or screentarget.DEFAULT_SWITCH_MARGIN_M
    local dwellMs      = tonumber(opts.dwellMs) or screentarget.DEFAULT_DWELL_MS

    local vehicles   = opts.vehicles   or defaultVehicles
    local exists     = opts.exists     or defaultExists
    local positionOf = opts.positionOf or defaultPositionOf
    local myPosition = opts.myPosition or defaultMyPosition
    local netIdOf    = opts.netIdOf    or defaultNetIdOf
    local now        = opts.now        or defaultNow
    local aboard     = opts.aboard     or defaultAboard

    -- The incumbent. `since` is when this vehicle became the target.
    local target   = nil
    local targetNet = nil
    local source   = nil
    local since    = 0
    local lastDist = nil

    local listeners = {}

    local function announce()
        if #listeners == 0 then return end
        for i = 1, #listeners do listeners[i](target, targetNet, source) end
    end

    --- Adopt a vehicle. Resets the dwell clock only on an actual change of target.
    local function commit(vehicle, netId, why, dist)
        local changed = (vehicle ~= target)
        if changed then
            target = vehicle
            since  = now()
        end
        targetNet = netId
        lastDist  = dist
        local sourceChanged = (why ~= source)
        source = why
        if changed or sourceChanged then announce() end
    end

    local function clear()
        if target == nil then
            source, targetNet, lastDist = nil, nil, nil
            return
        end
        target, targetNet, source, lastDist = nil, nil, nil, nil
        since = 0
        announce()
    end

    --- Re-run the arbitration. Cheap enough for a 250-1000 ms poll.
    --- @return vehicle, netId, source -- or nil when nothing qualifies.
    function self.update()
        local t = now()
        local origin = myPosition()

        -- Rule 1
        local ownVehicle, ownNet = aboard()
        if ownVehicle ~= nil and ownVehicle ~= 0 and exists(ownVehicle) and hasScreen(ownVehicle) then
            if ownNet == nil then ownNet = netIdOf(ownVehicle) end
            commit(ownVehicle, ownNet, screentarget.SOURCE_OWN, 0)
            return target, targetNet, source
        end

        -- Rule 2: scan
        local best, bestDist = nil, nil
        local incumbentDist = nil
        local pool = vehicles() or {}
        for i = 1, #pool do
            local vehicle = pool[i]
            if vehicle ~= nil and vehicle ~= 0 and exists(vehicle) and hasScreen(vehicle) then
                local d = distance(origin, positionOf(vehicle))
                if d ~= nil and d <= range then
                    if vehicle == target then incumbentDist = d end
                    if bestDist == nil or d < bestDist then
                        best, bestDist = vehicle, d
                    end
                end
            end
        end

        -- Rule 4: nothing at all
        if best == nil then
            clear()
            return nil
        end

        -- The incumbent did not survive the scan: it despawned, lost its prop, or left range.
        if target ~= nil and incumbentDist == nil then
            target, targetNet, source, lastDist, since = nil, nil, nil, nil, 0
        end

        if target == nil then
            commit(best, netIdOf(best), screentarget.SOURCE_NEAREST, bestDist)
            return target, targetNet, source
        end

        if best == target then
            commit(target, targetNet or netIdOf(target), screentarget.SOURCE_NEAREST, incumbentDist)
            return target, targetNet, source
        end

        -- Rule 3: a genuine challenger has to earn it
        if (t - since) < dwellMs then
            commit(target, targetNet, screentarget.SOURCE_NEAREST, incumbentDist)
            return target, targetNet, source
        end
        if (incumbentDist - bestDist) < switchMargin then
            commit(target, targetNet, screentarget.SOURCE_NEAREST, incumbentDist)
            return target, targetNet, source
        end

        commit(best, netIdOf(best), screentarget.SOURCE_NEAREST, bestDist)
        return target, targetNet, source
    end

    --- The last decision, without re-running it.
    --- @return vehicle, netId, source -- or nil.
    function self.current()
        if target == nil then return nil end
        return target, targetNet, source
    end

    --- Distance to the current target at the last `update`, or nil. Diagnostics.
    function self.currentDistance()
        return lastDist
    end

    --- Forget the incumbent, e.g. for a resource stop.
    function self.reset()
        clear()
    end

    --- Called with (vehicle, netId, source) whenever the answer changes, and with
    --- (nil, nil, nil) when it becomes "nothing". Returns an unsubscribe function.
    function self.onChange(fn)
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

    --- The tuning actually in force, for a diag command to print.
    function self.settings()
        return { range = range, switchMargin = switchMargin, dwellMs = dwellMs }
    end

    return self
end

return screentarget
