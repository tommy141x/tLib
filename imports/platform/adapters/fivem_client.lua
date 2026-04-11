-- FiveM client adapter

local platform = {}

function platform.getMyId()
    return GetPlayerServerId(PlayerId())
end

function platform.getMyName()
    return GetPlayerName(PlayerId())
end

function platform.getMyPosition()
    local ped = PlayerPedId()
    local c = GetEntityCoords(ped)
    return { x = c.x, y = c.y, z = c.z, heading = GetEntityHeading(ped) }
end

function platform.getMySpeed()
    return GetEntitySpeed(PlayerPedId())
end

function platform.getMyVehicle()
    local ped = PlayerPedId()
    local veh = GetVehiclePedIsIn(ped, false)
    if veh == 0 then return nil end
    local cls = GetVehicleClass(veh)
    local vtype = (cls == 15) and "heli" or (cls == 16) and "plane" or (cls == 14) and "boat" or "car"
    return {
        handle = veh,
        type = vtype,
        displayType = (cls == 15 or cls == 16) and "Air" or cls == 14 and "Boat" or "Vehicle",
        modelHash = GetEntityModel(veh),
        isDriver = GetPedInVehicleSeat(veh, -1) == ped,
        isEmergency = cls == 18,
        isEngineOn = GetIsVehicleEngineRunning(veh),
    }
end

function platform.getClothingItem(slotType, slotId)
    local ped = PlayerPedId()
    if slotType == "prop" then
        return GetPedPropIndex(ped, slotId)
    end
    return GetPedDrawableVariation(ped, slotId)
end

function platform.isPlayerShooting()
    return IsPedShooting(PlayerPedId())
end

function platform.getActiveWeaponId(entity)
    return GetSelectedPedWeapon(entity or PlayerPedId())
end

function platform.cancelAnimations()
    ClearPedTasks(PlayerPedId())
end

function platform.getMyEntityHandle()
    return PlayerPedId()
end

-- lazy-init so we only hash these once
local _ignoredWeapons = nil

function platform.getIgnoredWeaponIds()
    if not _ignoredWeapons then
        _ignoredWeapons = {
            [GetHashKey('WEAPON_STUNGUN')] = true,
            [GetHashKey('WEAPON_FLAREGUN')] = true,
            [GetHashKey('WEAPON_FIREEXTINGUISHER')] = true,
            [GetHashKey('WEAPON_PETROLCAN')] = true,
            [GetHashKey('WEAPON_SNOWBALL')] = true,
            [GetHashKey('WEAPON_BALL')] = true,
            [GetHashKey('WEAPON_SMOKEGRENADE')] = true,
        }
    end
    return _ignoredWeapons
end

function platform.getRemotePlayerPosition(serverId)
    local playerIdx = GetPlayerFromServerId(serverId)
    if playerIdx == -1 then return nil end
    local ped = GetPlayerPed(playerIdx)
    if not ped or not DoesEntityExist(ped) then return nil end
    local c = GetEntityCoords(ped)
    return {
        x = c.x, y = c.y, z = c.z,
        speed = GetEntitySpeed(ped),
        heading = GetEntityHeading(ped),
    }
end

function platform.getNetworkEntityPosition(networkId)
    if not NetworkDoesNetworkIdExist(networkId) then return nil end
    local entity = NetworkGetEntityFromNetworkId(networkId)
    if not entity or entity == 0 or not DoesEntityExist(entity) then return nil end
    local c = GetEntityCoords(entity)
    return { x = c.x, y = c.y, z = c.z, speed = GetEntitySpeed(entity) }
end

function platform.isNetworkIdValid(netId)
    return NetworkDoesNetworkIdExist(netId)
end

function platform.isEntityValid(handle)
    return DoesEntityExist(handle)
end

function platform.getNetworkId(handle)
    return VehToNet(handle)
end

function platform.resolveNetworkId(netId)
    return NetworkGetEntityFromNetworkId(netId)
end

function platform.getEntityPosition(entity)
    local c = GetEntityCoords(entity)
    return { x = c.x, y = c.y, z = c.z }
end

function platform.getCameraState()
    local ped = PlayerPedId()
    local vehicle = GetVehiclePedIsIn(ped, false)
    local coords
    if vehicle and vehicle ~= 0 then
        if GetFollowVehicleCamViewMode() == 4 then
            coords = GetEntityCoords(vehicle)
        else
            coords = GetGameplayCamCoord()
        end
    else
        coords = GetEntityCoords(ped)
    end
    local rotation = GetGameplayCamRot(0)
    return {
        position = { x = coords.x, y = coords.y, z = coords.z },
        rotation = { x = rotation.x, y = rotation.y, z = rotation.z },
        speed = GetEntitySpeed(ped),
    }
end

function platform.createMapMarker(x, y, z)
    return AddBlipForCoord(x, y, z)
end

function platform.removeMapMarker(handle)
    RemoveBlip(handle)
end

function platform.isMapMarkerValid(handle)
    return DoesBlipExist(handle)
end

function platform.moveMapMarker(handle, x, y, z)
    SetBlipCoords(handle, x, y, z)
end

function platform.setMarkerRotation(handle, rot)
    SetBlipRotation(handle, rot)
end

function platform.setMarkerIcon(handle, icon)
    SetBlipSprite(handle, icon)
end

function platform.setMarkerColor(handle, color)
    SetBlipColour(handle, color)
end

function platform.setMarkerScale(handle, scale)
    SetBlipScale(handle, scale)
end

function platform.setMarkerShortRange(handle, sr)
    SetBlipAsShortRange(handle, sr)
end

function platform.setMarkerDisplay(handle, display)
    SetBlipDisplay(handle, display)
end

function platform.setMarkerOpacity(handle, alpha)
    SetBlipAlpha(handle, alpha)
end

function platform.setMarkerLabel(handle, label)
    BeginTextCommandSetBlipName("STRING")
    AddTextComponentString(label)
    EndTextCommandSetBlipName(handle)
end

function platform.setMarkerHeadingIndicator(handle, show)
    ShowHeadingIndicatorOnBlip(handle, show)
end

function platform.getPlayerMapMarker()
    return GetMainPlayerBlipId()
end

function platform.now()
    return GetGameTimer()
end

function platform.getGameTime()
    return { hour = GetClockHours(), minute = GetClockMinutes() }
end

function platform.loadData(key)
    return GetResourceKvpString(key)
end

function platform.saveData(key, value)
    SetResourceKvp(key, value)
end

function platform.removeData(key)
    DeleteResourceKvp(key)
end

function platform.sendToEngine(msg)
    SendNUIMessage(msg)
end

function platform.showCursor()
    SetNuiFocus(true, true)
end

function platform.releaseCursor()
    SetNuiFocusKeepInput(false)
    SetNuiFocus(false, false)
end

function platform.releaseCursorSuppressPause()
    SetNuiFocusKeepInput(false)
    SetNuiFocus(false, false)
    Citizen.CreateThread(function()
        for _ = 1, 15 do
            DisableControlAction(0, 199, true)
            DisableControlAction(0, 200, true)
            DisableControlAction(2, 199, true)
            DisableControlAction(2, 200, true)
            Citizen.Wait(0)
        end
    end)
end

function platform.activateProximityVoice()
    SetControlNormal(0, 249, 1.0)
end

function platform.sendToServer(event, ...)
    TriggerServerEvent(event, ...)
end

function platform.showChatMessage(title, text)
    TriggerEvent("chat:addMessage", { args = { title, text } })
end

function platform.emitEvent(event, ...)
    TriggerEvent(event, ...)
end

function platform.getResourceId()
    return GetCurrentResourceName()
end

return platform
