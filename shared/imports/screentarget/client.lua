-- Which vehicle's device screen this client renders. Client only.
--
-- ADD_REPLACE_TEXTURE is keyed on the ORIGINAL texture object, which every
-- instance of an archetype shares. Replacing `rdx_screen` does not replace it on
-- one prop, it replaces it on every rdx4000 the client can see, and there is no
-- per-entity variant of the native. A DUI per vehicle is not an escape either:
-- CREATE_RUNTIME_TXD pins a `ytd` streaming slot and has no destructor.
--
-- So there is exactly ONE screen, and the only question left is which vehicle it
-- shows. Answered the same way for all three resources, so a player walking
-- between props gets one notion of "the one in front of me":
--
-- 1. THE VEHICLE YOU ARE ABOARD WINS, in any seat, whenever it has a screen.
--    Not "the nearest": a car alongside is easily closer to your ped than your
--    own dashboard. Asked of `occupancy.cabin()`, the perception tier.
--
-- 2. OTHERWISE THE NEAREST VEHICLE THAT HAS A SCREEN, within `range`.
--
-- 3. HYSTERESIS, because rule 2 on its own flaps. Two cars at similar distance
--    would swap the incumbency every pass, and since the texture is global every
--    prop in the world would strobe between two devices' readings.
--
-- 4. NO CANDIDATE IS AN ANSWER. `update` returns nil, and the consumer tears its
--    browser down rather than leave stale numbers painted on every prop.
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
--- ABSOLUTE METRES, NOT A FRACTION: the flap happens where two candidates are
--- nearly equidistant, and at this module's ranges a proportional margin
--- collapses to nothing exactly there. Two metres is about one car width.
screentarget.DEFAULT_SWITCH_MARGIN_M = 2.0

--- Minimum time an incumbent holds before ANY challenger may displace it, in ms.
--- The margin alone is not enough: two vehicles driving alongside weave by more
--- than a margin's worth over a few seconds, which reads as the device glitching.
--- A floor on DISPLACEMENT only -- losing the incumbent is never delayed.
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

--- Whether a BOOL native said yes.
---
--- MEASURED 2026-09-26, FiveM Enhanced: every BOOL native reached from Lua here
--- returns the NUMBER 1, not `true` -- DoesEntityExist, NetworkDoesNetworkIdExist,
--- IsPedInAnyVehicle, IsEntityAVehicle and HasModelLoaded were all checked with
--- `type()` and all answered "number". So `native(...) == true` is ALWAYS FALSE, and
--- It cost a full debugging session: `exists` rejected every entity that existed,
--- so the props on all three devices stayed dark while every unit test passed,
--- because the suites inject their own providers and never run a real native.
---
--- `not not v` is NOT the fix -- 0 is truthy in Lua. Both shapes are spelled out.
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

    -- The incumbent. `since` is when THIS VEHICLE became the target, and it is
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

    --- Adopt a vehicle. Resets the dwell clock only on an actual CHANGE of
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

    --- Re-run the arbitration. Cheap enough for a 250-1000 ms poll; it is a pool
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

        -- The incumbent did not survive the scan: it despawned, lost its prop, or
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

    --- Forget the incumbent. For a resource stop, or a consumer that has just
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

    --- The tuning actually in force, for a diag command to print. A range that
    function self.settings()
        return { range = range, switchMargin = switchMargin, dwellMs = dwellMs }
    end

    return self
end

return screentarget
