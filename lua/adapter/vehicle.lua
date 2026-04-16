-- tLib/lua/adapter/vehicle.lua
-- vehicle platform abstractions (FiveM + Helix)


local log = Logger.create('tLib/adapter/vehicle')

local _warnOnce = Utils.warnOnce

if _TLIB_IS_HELIX then
    function Platform.getPlayerVehicle()
        -- GetVehiclePedIsIn(pawn) is a global Helix function (functions API).
        local pawn = GetPlayerPawn and GetPlayerPawn()
        if not pawn then return nil end
        local veh = GetVehiclePedIsIn and GetVehiclePedIsIn(pawn)
        -- Helix returns nil when the pawn is not in a vehicle.
        return veh or nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getPlayerVehicle()
        local ped = PlayerPedId()
        if not IsPedInAnyVehicle(ped, false) then return nil end
        local veh = GetVehiclePedIsIn(ped, false)
        return (veh and veh ~= 0) and veh or nil
    end
else
    Platform.getPlayerVehicle = Platform._stub('getPlayerVehicle')
end

if _TLIB_IS_HELIX then
    function Platform.getVehicleSpeed(vehicle)
        if not vehicle then return 0 end
        -- HVehicle inherits from Actor; GetVelocityForNavMovement returns a
        -- Vector in cm/s (Unreal units). Divide by 100 to convert to m/s.
        local vel
        if type(vehicle.GetVelocityForNavMovement) == 'function' then
            vel = vehicle:GetVelocityForNavMovement()
        elseif vehicle.Object and type(vehicle.Object.GetVelocity) == 'function' then
            vel = vehicle.Object:GetVelocity()
        end
        if not vel then return 0 end
        -- Vector magnitude: √(X²+Y²+Z²), then cm/s → m/s.
        local x = vel.X or 0
        local y = vel.Y or 0
        local z = vel.Z or 0
        return math.sqrt(x * x + y * y + z * z) / 100.0
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getVehicleSpeed(vehicle)
        if not vehicle or vehicle == 0 then return 0 end
        return GetEntitySpeed(vehicle)
    end
else
    Platform.getVehicleSpeed = Platform._stub('getVehicleSpeed')
end

if _TLIB_IS_HELIX then
    function Platform.getVehiclePlate(vehicle)
        -- Helix HVehicle has no native plate/license-plate API as of this
        -- writing. Return empty string so callers can still do nil-safe checks.
        _warnOnce('getVehiclePlate',
            'getVehiclePlate is not natively supported on Helix — returning ""')
        return ''
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getVehiclePlate(vehicle)
        if not vehicle or vehicle == 0 then return '' end
        -- Trim the trailing spaces FiveM pads plate strings with.
        local plate = GetVehicleNumberPlateText(vehicle)
        return plate and plate:match('^%s*(.-)%s*$') or ''
    end
else
    Platform.getVehiclePlate = Platform._stub('getVehiclePlate')
end

if _TLIB_IS_HELIX then
    function Platform.setVehiclePlate(vehicle, plate)
        _warnOnce('setVehiclePlate',
            'setVehiclePlate is not natively supported on Helix — no-op')
    end
elseif _TLIB_IS_FIVEM then
    function Platform.setVehiclePlate(vehicle, plate)
        if not vehicle or vehicle == 0 then return end
        SetVehicleNumberPlateText(vehicle, tostring(plate or ''))
    end
else
    Platform.setVehiclePlate = Platform._stub('setVehiclePlate')
end

if _TLIB_IS_HELIX then
    function Platform.getVehicleNetId(vehicle)
        -- Helix does not expose a separate numeric network-id for vehicles.
        -- Return a stable string derived from the Object pointer so callers
        -- have *something* they can use as a dictionary key server-side.
        if not vehicle then return nil end
        if vehicle.Object then
            return tostring(vehicle.Object)
        end
        return tostring(vehicle)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getVehicleNetId(vehicle)
        if not vehicle or vehicle == 0 then return nil end
        return VehToNet(vehicle)
    end
else
    Platform.getVehicleNetId = Platform._stub('getVehicleNetId')
end

if _TLIB_IS_HELIX then
    -- model   → full blueprint asset path, e.g.
    --   '/abcca-dax-veh/PongaseraGt/Blueprint/BP_PongaseraGtVehicle.BP_PongaseraGtVehicle_C'
    -- coords  → table {x, y, z}  (Helix treats 1 UE unit = 1 cm)
    -- heading → yaw in degrees
    -- cb      → function(vehicle)
    function Platform.spawnVehicle(model, coords, heading, cb)
        local loc = Vector(
            coords.x or coords.X or 0,
            coords.y or coords.Y or 0,
            coords.z or coords.Z or 0
        )
        local rot = Rotator(0, heading or 0, 0)

        -- HVehicle constructor accepts an optional spawn callback as the last arg
        -- according to Helix docs; fall back to a post-construction call via
        -- Platform.setTimeout if the constructor doesn't support it directly.
        local veh = HVehicle(loc, rot, model, 'QueryAndPhysics', true)

        if veh and type(cb) == 'function' then
            -- Give the async spawn one frame to complete before handing off.
            Platform.setTimeout(function()
                cb(veh)
            end, 0)
        elseif type(cb) == 'function' then
            cb(nil)
        end
    end
elseif _TLIB_IS_FIVEM then
    -- model   → model name string or hash integer.
    -- coords  → table {x, y, z}.
    -- heading → yaw in degrees.
    -- cb      → function(vehicle).
    function Platform.spawnVehicle(model, coords, heading, cb)
        Platform.createThread(function()
            local hash = type(model) == 'number' and model or GetHashKey(model)
            RequestModel(hash)
            local waited = 0
            while not HasModelLoaded(hash) do
                Platform.wait(10)
                waited = waited + 10
                if waited > 5000 then
                    SetModelAsNoLongerNeeded(hash)
                    if type(cb) == 'function' then cb(nil) end
                    return
                end
            end

            local veh = CreateVehicle(
                hash,
                coords.x or coords.X or 0,
                coords.y or coords.Y or 0,
                coords.z or coords.Z or 0,
                heading or 0,
                true, -- isNetwork
                false -- netMissionEntity
            )

            SetModelAsNoLongerNeeded(hash)

            if type(cb) == 'function' then
                cb((veh and veh ~= 0) and veh or nil)
            end
        end)
    end
else
    Platform.spawnVehicle = Platform._stub('spawnVehicle')
end

if _TLIB_IS_HELIX then
    function Platform.deleteVehicle(vehicle)
        if not vehicle then return end
        -- DeleteVehicle is a global Helix function (functions API).
        if type(DeleteVehicle) == 'function' then
            DeleteVehicle(vehicle)
        elseif vehicle.Object and type(vehicle.Object.K2_DestroyActor) == 'function' then
            vehicle.Object:K2_DestroyActor()
        end
    end
elseif _TLIB_IS_FIVEM then
    function Platform.deleteVehicle(vehicle)
        if not vehicle or vehicle == 0 then return end
        SetEntityAsMissionEntity(vehicle, true, true)
        DeleteVehicle(vehicle)
    end
else
    Platform.deleteVehicle = Platform._stub('deleteVehicle')
end

if _TLIB_IS_HELIX then
    -- instantly is ignored on Helix — the engine responds immediately.
    function Platform.setVehicleEngineOn(vehicle, state, _instantly)
        if not vehicle then return end
        if state then
            -- Simulate a quick key-turn: hold the starter briefly then release.
            if type(vehicle.HoldStarter) == 'function' then
                vehicle:HoldStarter(0.0)
            end
            if type(vehicle.ReleaseStarter) == 'function' then
                vehicle:ReleaseStarter()
            end
        else
            if type(vehicle.StopEngine) == 'function' then
                vehicle:StopEngine()
            end
        end
    end
elseif _TLIB_IS_FIVEM then
    function Platform.setVehicleEngineOn(vehicle, state, instantly)
        if not vehicle or vehicle == 0 then return end
        -- The 4th arg (forceInstant) matches common FiveM usage.
        SetVehicleEngineOn(vehicle, state == true, instantly == true, true)
    end
else
    Platform.setVehicleEngineOn = Platform._stub('setVehicleEngineOn')
end

if _TLIB_IS_HELIX then
    function Platform.getVehicleClass(vehicle)
        -- Helix does not expose a GTA-style numeric vehicle class.
        _warnOnce('getVehicleClass',
            'getVehicleClass is not natively supported on Helix — returning nil')
        return nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getVehicleClass(vehicle)
        if not vehicle or vehicle == 0 then return nil end
        return GetVehicleClass(vehicle)
    end
else
    Platform.getVehicleClass = Platform._stub('getVehicleClass')
end

-- seatIndex: -1 = driver, 0 = front passenger, 1+ = rear seats.

if _TLIB_IS_HELIX then
    function Platform.isVehicleSeatFree(vehicle, seatIndex)
        -- Helix HVehicle has no per-seat occupancy API.
        _warnOnce('isVehicleSeatFree',
            'isVehicleSeatFree is not natively supported on Helix — returning nil')
        return nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.isVehicleSeatFree(vehicle, seatIndex)
        if not vehicle or vehicle == 0 then return nil end
        return IsVehicleSeatFree(vehicle, seatIndex)
    end
else
    Platform.isVehicleSeatFree = Platform._stub('isVehicleSeatFree')
end

if _TLIB_IS_HELIX then
    function Platform.getVehicleNumberOfPassengers(vehicle)
        -- Helix HVehicle has no passenger-count API.
        _warnOnce('getVehicleNumberOfPassengers',
            'getVehicleNumberOfPassengers is not natively supported on Helix — returning nil')
        return nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getVehicleNumberOfPassengers(vehicle)
        if not vehicle or vehicle == 0 then return 0 end
        return GetVehicleNumberOfPassengers(vehicle)
    end
else
    Platform.getVehicleNumberOfPassengers = Platform._stub('getVehicleNumberOfPassengers')
end
