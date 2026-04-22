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

-- NUI focus with mode-level control. Mode 1 = cursor visible + UI input;
-- mode 0 = cursor hidden, game input. Mirrors Platform.setInputMode in the
-- tLib VM so consumer code can call the same name either side.
function platform.setInputMode(mode)
    if mode == 1 then
        SetNuiFocus(true, true)
    else
        SetNuiFocus(false, false)
        SetNuiFocusKeepInput(false)
    end
end

-- Keeps gameplay input live while the NUI cursor is visible. Consumers pair
-- this with DisableControlAction for the specific controls they want to
-- suppress (attack/look/etc.) during UI focus.
function platform.setKeepInputActive(state)
    SetNuiFocusKeepInput(state == true)
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

-- Register an export under the current resource. `resource` is accepted for
-- API symmetry with the Helix 3-arg form but ignored on FiveM — `exports(name, fn)`
-- always targets the calling resource.
function platform.wrapExport(resource, name, fn)
    exports(name, fn)
end

-- ─── Key bindings ────────────────────────────────────────────────────
-- Thin FiveM wrapper over RegisterCommand + RegisterKeyMapping. The Helix
-- adapter has a matching signature that hooks Input.BindKey instead.
-- cb can be a function (defaults to 'Pressed') or {press=fn, release=fn}.

do
    local _resourceName = GetCurrentResourceName()
    local _bindCount    = {}

    local function cmdName(key)
        return (_resourceName .. '_key_' .. tostring(key)):gsub('[^%w_]', '_')
    end

    local function normalizePair(cb, eventType)
        if type(cb) == 'table' then
            return cb.press or cb.onPress or cb[1],
                   cb.release or cb.onRelease or cb[2]
        end
        if eventType == 'Released' then return nil, cb end
        return cb, nil
    end

    function platform.bindKey(key, cb, eventType, bindingId, label)
        local pressCb, releaseCb = normalizePair(cb, eventType)
        local token

        if type(bindingId) == 'string' and bindingId ~= '' then
            token = bindingId:gsub('[^%w_]', '_')
        else
            local count     = (_bindCount[key] or 0) + 1
            _bindCount[key] = count
            local base      = cmdName(key)
            token           = count == 1 and base or (base .. '_' .. count)
        end

        local displayLabel = (type(label) == 'string' and label ~= '' and label)
            or token:gsub('_', ' ')

        RegisterCommand('+' .. token, function()
            if pressCb then pressCb() end
        end, false)
        RegisterCommand('-' .. token, function()
            if releaseCb then releaseCb() end
        end, false)

        RegisterKeyMapping('+' .. token, displayLabel, 'keyboard', key or '')
    end
end

-- ─── Voice backend (pma-voice on FiveM) ─────────────────────────────
-- Per-consumer probe so each resource gets its own availability callbacks.

do
    platform.voice = {}

    local _ready           = false
    local _backend         = 'none'
    local _availabilityCbs = {}

    local function fireAvailability()
        for i = 1, #_availabilityCbs do
            pcall(_availabilityCbs[i], _ready, _backend)
        end
    end

    local function setReady(state, backend)
        if _ready == state and _backend == backend then return end
        _ready = state
        _backend = backend
        fireAvailability()
    end

    local function probePma()
        if GetResourceState('pma-voice') ~= 'started' then return false end
        local exp = exports['pma-voice']
        if not exp then return false end
        local ok, has = pcall(function()
            return exp.overrideProximityRange ~= nil
                and exp.clearProximityOverride ~= nil
        end)
        return ok and has == true
    end

    local function refresh()
        if probePma() then setReady(true, 'pma-voice') else setReady(false, 'none') end
    end

    AddEventHandler('onClientResourceStart', function(res)
        if res == 'pma-voice' then refresh() end
    end)
    AddEventHandler('onClientResourceStop', function(res)
        if res == 'pma-voice' then refresh() end
    end)

    -- Initial probe deferred so pma-voice finishes init when both resources
    -- start in the same tick.
    Citizen.CreateThread(function()
        Citizen.Wait(750)
        refresh()
    end)

    function platform.voice.isAvailable() return _ready end
    function platform.voice.backend()     return _backend end

    function platform.voice.onAvailabilityChanged(cb)
        if type(cb) ~= 'function' then return end
        _availabilityCbs[#_availabilityCbs + 1] = cb
        pcall(cb, _ready, _backend)  -- seed with current state
    end

    function platform.voice.overrideProximityRange(metres, lockCycle)
        if not _ready or _backend ~= 'pma-voice' then return false end
        local ok = pcall(function()
            exports['pma-voice']:overrideProximityRange(metres + 0.0, lockCycle == true)
        end)
        return ok
    end

    function platform.voice.clearProximityOverride()
        if not _ready or _backend ~= 'pma-voice' then return end
        pcall(function() exports['pma-voice']:clearProximityOverride() end)
    end

    function platform.voice.setSubmixForServerId(serverId, submixHandle)
        if type(MumbleSetSubmixForServerId) ~= 'function' then return end
        pcall(MumbleSetSubmixForServerId, serverId, submixHandle)
    end

    function platform.voice.setAudioInputIntent(intent)
        if type(MumbleSetAudioInputIntent) ~= 'function' then return end
        pcall(MumbleSetAudioInputIntent, intent)
    end
end

return platform
