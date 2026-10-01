-- Which vehicle's device screen this client renders. Client only.
--
-- ── The constraint this module exists to live with ──────────────────────────
--
-- ADD_REPLACE_TEXTURE is keyed on the ORIGINAL texture object, which every
-- instance of an archetype shares. Replacing `rdx_screen` does not replace it on
-- one prop, it replaces it on every rdx4000 the client can see, and there is no
-- per-entity variant of the native. tRadio, tRadar and tDetector each
-- rediscovered this and each wrote it down:
--
--   tRadio/client/cl_handheld.lua:13-18
--   tRadar/client/cl_screen.lua:220-224
--   tDetector/client/cl_screen.lua:199-217   ("This is ACCEPTED, not solved")
--
-- And a DUI cannot simply be made per-vehicle either: CREATE_RUNTIME_TXD pins a
-- `ytd` streaming slot and the native registration has no destructor, so a txd
-- per vehicle is an unbounded, unreclaimable leak (tRadio/client/cl_handheld.lua:127-160,
-- tDetector/client/cl_screen.lua:219-257).
--
-- So there is exactly ONE screen, and the only question left is WHICH vehicle it
-- should be showing. That question is what this module answers, and it answers it
-- the same way for all three resources so that a player walking from one prop to
-- another does not get three different notions of "the one in front of me".
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. THE VEHICLE YOU ARE ABOARD WINS, in any seat, whenever it has a screen.
--    Not "the nearest", because a car alongside can easily be a few centimetres
--    closer to your ped than your own dashboard is, and a display that flicked to
--    the neighbour's readings every time one drew level would be worse than no
--    display. Aboard is asked of `occupancy.cabin()`, the perception tier — a rear
--    passenger PERCEIVES the cabin they are in. Nothing here grants control of
--    anything; picking what to draw is not an input path.
--
--    Being aboard a vehicle with NO screen does not blind you to the one beside
--    you: that case falls through to rule 2, which is what lets a passenger read
--    the patrol car's detector through the window.
--
-- 2. OTHERWISE THE NEAREST VEHICLE THAT HAS A SCREEN, within `range`.
--
-- 3. HYSTERESIS, because rule 2 on its own flaps. Two cars at similar distance
--    would swap the incumbency every pass and, since the texture is global, every
--    prop in the world would strobe between two devices' readings. See the
--    constants below for what "meaningfully closer" means here and why it is an
--    absolute margin rather than a ratio.
--
-- 4. NO CANDIDATE IS AN ANSWER. `update` returns nil, and the consumer is
--    expected to tear its browser down rather than leave the last vehicle's
--    numbers painted on every prop on the map.
--
-- ── Testability ─────────────────────────────────────────────────────────────
--
-- Every native this would otherwise call is an injectable provider with a native
-- default, so tests/lua/screentarget-arbitration.lua drives THIS file rather than
-- a re-implementation of it. That matters more than usual here: the failure this
-- module prevents (a flapping global texture) is a thing you can only see in
-- game, at which point you are debugging three resources at once.

local screentarget = {}

-- ── Defaults ────────────────────────────────────────────────────────────────

--- How far away a screen is still worth rendering, in metres.
---
--- "Close enough to read a small display through a window", NOT "close enough to
--- hear the device". Those are deliberately different numbers and this is the
--- short one: a radio carries down the street, a 660x140 readout does not survive
--- being a car's length away. Eight metres is chosen so that the two cases the
--- feature exists for both clear it with room -- somebody standing at the driver's
--- window (~1.5 m) and somebody in the back row of a long vehicle, measured from
--- the ped to the vehicle's CENTRE, which on a bus is already ~4 m -- while a car
--- in the next lane but one does not.
---
--- Consumers are expected to override it from their own config rather than take
--- this. It is a default so that a consumer that forgets still gets a sane number
--- instead of zero, which would silently disable the whole feature.
screentarget.DEFAULT_RANGE_M = 8.0

--- How much closer a challenger must be than the incumbent before it takes over.
---
--- ABSOLUTE METRES, NOT A FRACTION. The flap this defends against happens where
--- two candidates are nearly equidistant, and at close range -- which is all of
--- this module's range -- a proportional margin collapses to nothing exactly
--- there: 10% of 1.5 m is 15 cm, which two parked cars and a walking player cross
--- several times a second. A fixed 2 m also matches the thing being modelled,
--- which is "you are clearly at THIS window, not that one" rather than "this one
--- is relatively nearer".
---
--- Two metres is about one car width. Below that the two props are close enough
--- together that either answer is defensible, which is precisely when the choice
--- must be sticky rather than correct.
screentarget.DEFAULT_SWITCH_MARGIN_M = 2.0

--- Minimum time an incumbent holds before ANY challenger may displace it, in ms.
---
--- The margin alone is not enough. Two vehicles driving alongside each other
--- weave by more than a margin's worth over a few seconds, so margin-only
--- hysteresis still produces a slow strobe -- less frequent than the per-frame
--- one, and more confusing, because it looks like the device is glitching rather
--- than like the picker is undecided. A dwell makes the minimum period of any
--- oscillation 2 x DWELL, which at 1.5 s is long enough to read as "it changed"
--- rather than as a flicker.
---
--- It is a floor on DISPLACEMENT only. Losing the incumbent -- it despawned, its
--- prop went, it left range, or you got into a car -- is not a displacement and
--- is never delayed; a dwell that held a dead vehicle would be a blank screen for
--- a second and a half for no reason.
screentarget.DEFAULT_DWELL_MS = 1500

-- ── Sources ─────────────────────────────────────────────────────────────────

--- Why the current target was chosen. Consumers branch on this: `SOURCE_OWN`
--- means the local NUI is looking at the same device and may drive the screen
--- directly, `SOURCE_NEAREST` means the content has to come off the vehicle.
screentarget.SOURCE_OWN     = "own"
screentarget.SOURCE_NEAREST = "nearest"

-- ── Native providers ────────────────────────────────────────────────────────
--
-- Resolved lazily and per call rather than captured at load: a shared script can
-- be loaded before tlib's import system has finished initialising on the other
-- side, and these are also what a suite replaces.

local function defaultVehicles()
    return GetGamePool("CVehicle")
end

--- Whether a BOOL native said yes.
---
--- MEASURED 2026-09-26, FiveM Enhanced: every BOOL native reached from Lua here
--- returns the NUMBER 1, not `true` -- DoesEntityExist, NetworkDoesNetworkIdExist,
--- IsPedInAnyVehicle, IsEntityAVehicle and HasModelLoaded were all checked with
--- `type()` and all answered "number". So `native(...) == true` is ALWAYS FALSE, and
--- the code below used to be exactly that.
---
--- It cost a full debugging session: screentarget's `exists` provider rejected every
--- entity that existed, so no vehicle ever qualified as a screen target and the props
--- on all three devices stayed dark -- no browser, no backlight, no lamps -- while
--- every unit test passed, because the suites INJECT their own providers and so never
--- run a real native.
---
--- `not not v` is NOT the fix: 0 is truthy in Lua, so it would turn every "no" into a
--- "yes". Both shapes have to be spelled out.
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
---
--- `occupancy.cabin()` and NOT `occupancy.myVehicle()`. myVehicle answers "the
--- vehicle I am OPERATING" and is nil for a rear passenger by design, which is
--- the opposite of what this needs: the whole point of rule 1 is that the person
--- in the back of the car is aboard it. cabin() is the perception answer.
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

-- ── The arbiter ─────────────────────────────────────────────────────────────

--- Build an arbiter.
---
--- One per DEVICE KIND, not one per resource and not one global: tDetector's
--- rdx4000 and tRadar's counting unit are different props on different vehicles
--- and each has its own nearest. The only thing they share is the rules.
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
    -- not refreshed while it stays the target -- it is the dwell clock, so
    -- refreshing it would make the dwell unexpirable.
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
    --- vehicle: a target that merely changed SOURCE -- you stepped out of the car
    --- you were in and it is now simply the nearest one -- has not restarted
    --- anything and must not get a fresh grace period out of it.
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
    --- walk and a distance per candidate, and the candidate test is the
    --- consumer's own table lookup.
    --- @return vehicle, netId, source -- or nil when nothing qualifies.
    function self.update()
        local t = now()
        local origin = myPosition()

        -- ── Rule 1 ──
        local ownVehicle, ownNet = aboard()
        if ownVehicle ~= nil and ownVehicle ~= 0 and exists(ownVehicle) and hasScreen(ownVehicle) then
            if ownNet == nil then ownNet = netIdOf(ownVehicle) end
            commit(ownVehicle, ownNet, screentarget.SOURCE_OWN, 0)
            return target, targetNet, source
        end

        -- ── Rule 2: scan ──
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

        -- ── Rule 4: nothing at all ──
        if best == nil then
            clear()
            return nil
        end

        -- The incumbent did not survive the scan: it despawned, lost its prop, or
        -- left range. Not a displacement, so neither the dwell nor the margin
        -- applies -- holding a vehicle that is no longer a candidate is the one
        -- thing hysteresis must never do.
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

        -- ── Rule 3: a genuine challenger has to earn it ──
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
    --- torn its own screen down for reasons of its own and does not want the next
    --- pass to think it is still up.
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
    --- silently fell back to the default because a config key was misspelled is
    --- otherwise invisible.
    function self.settings()
        return { range = range, switchMargin = switchMargin, dwellMs = dwellMs }
    end

    return self
end

return screentarget
