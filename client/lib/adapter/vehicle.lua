-- vehicle platform abstractions (FiveM)

if _TLIB_IS_FIVEM then
    function Platform.getPlayerVehicle()
        local ped = PlayerPedId()
        if not IsPedInAnyVehicle(ped, false) then return nil end
        local veh = GetVehiclePedIsIn(ped, false)
        return (veh and veh ~= 0) and veh or nil
    end
else
    Platform.getPlayerVehicle = Platform._stub('getPlayerVehicle')
end

if _TLIB_IS_FIVEM then
    function Platform.getVehicleSpeed(vehicle)
        if not vehicle or vehicle == 0 then return 0 end
        return GetEntitySpeed(vehicle)
    end
else
    Platform.getVehicleSpeed = Platform._stub('getVehicleSpeed')
end

if _TLIB_IS_FIVEM then
    function Platform.getVehiclePlate(vehicle)
        if not vehicle or vehicle == 0 then return '' end
        -- Trim the trailing spaces FiveM pads plate strings with.
        local plate = GetVehicleNumberPlateText(vehicle)
        return plate and plate:match('^%s*(.-)%s*$') or ''
    end
else
    Platform.getVehiclePlate = Platform._stub('getVehiclePlate')
end

if _TLIB_IS_FIVEM then
    function Platform.setVehiclePlate(vehicle, plate)
        if not vehicle or vehicle == 0 then return end
        SetVehicleNumberPlateText(vehicle, tostring(plate or ''))
    end
else
    Platform.setVehiclePlate = Platform._stub('setVehiclePlate')
end

if _TLIB_IS_FIVEM then
    function Platform.getVehicleNetId(vehicle)
        if not vehicle or vehicle == 0 then return nil end
        return VehToNet(vehicle)
    end
else
    Platform.getVehicleNetId = Platform._stub('getVehicleNetId')
end

if _TLIB_IS_FIVEM then
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

if _TLIB_IS_FIVEM then
    function Platform.deleteVehicle(vehicle)
        if not vehicle or vehicle == 0 then return end
        SetEntityAsMissionEntity(vehicle, true, true)
        DeleteVehicle(vehicle)
    end
else
    Platform.deleteVehicle = Platform._stub('deleteVehicle')
end

if _TLIB_IS_FIVEM then
    function Platform.setVehicleEngineOn(vehicle, state, instantly)
        if not vehicle or vehicle == 0 then return end
        -- The 4th arg (forceInstant) matches common FiveM usage.
        SetVehicleEngineOn(vehicle, state == true, instantly == true, true)
    end
else
    Platform.setVehicleEngineOn = Platform._stub('setVehicleEngineOn')
end

if _TLIB_IS_FIVEM then
    function Platform.getVehicleClass(vehicle)
        if not vehicle or vehicle == 0 then return nil end
        return GetVehicleClass(vehicle)
    end
else
    Platform.getVehicleClass = Platform._stub('getVehicleClass')
end

-- seatIndex: -1 = driver, 0 = front passenger, 1+ = rear seats.

if _TLIB_IS_FIVEM then
    function Platform.isVehicleSeatFree(vehicle, seatIndex)
        if not vehicle or vehicle == 0 then return nil end
        return IsVehicleSeatFree(vehicle, seatIndex)
    end
else
    Platform.isVehicleSeatFree = Platform._stub('isVehicleSeatFree')
end

if _TLIB_IS_FIVEM then
    function Platform.getVehicleNumberOfPassengers(vehicle)
        if not vehicle or vehicle == 0 then return 0 end
        return GetVehicleNumberOfPassengers(vehicle)
    end
else
    Platform.getVehicleNumberOfPassengers = Platform._stub('getVehicleNumberOfPassengers')
end
