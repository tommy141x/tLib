-- Helix client adapter — mirrors fivem_client.lua so consumer code is
-- identical across engines. Where Helix hasn't shipped an equivalent yet,
-- we degrade to safe nil / empty returns rather than throwing.

local platform = {}

local function safeCall(fn, ...)
    if type(fn) ~= "function" then return nil end
    local args = { ... }
    local ok, result = pcall(function() return fn(table.unpack(args)) end)
    if not ok then return nil end
    return result
end

-- ─── Identity ───────────────────────────────────────────────────────

function platform.getMyId()
    if HPlayer and HPlayer.Id then return HPlayer.Id end
    return safeCall(GetPlayerServerId, safeCall(PlayerId)) or 0
end

function platform.getMyName()
    if HPlayer and HPlayer.Name then return HPlayer.Name end
    return safeCall(GetPlayerName, safeCall(PlayerId)) or "Player"
end

local function getLocalPed()
    if HPlayer and HPlayer.Pawn then return HPlayer.Pawn end
    if type(GetPlayerPawn) == "function" then return safeCall(GetPlayerPawn) end
    return safeCall(PlayerPedId)
end

function platform.getMyPosition()
    local ped = getLocalPed()
    if not ped then return { x = 0, y = 0, z = 0, heading = 0 } end
    local c = safeCall(GetEntityCoords, ped)
    if not c then
        -- Helix UE-style fallback.
        if ped.K2_GetActorLocation then
            local ok, loc = pcall(function() return ped:K2_GetActorLocation() end)
            if ok and loc then
                return { x = loc.X or 0, y = loc.Y or 0, z = loc.Z or 0, heading = 0 }
            end
        end
        return { x = 0, y = 0, z = 0, heading = 0 }
    end
    local h = safeCall(GetEntityHeading, ped) or 0
    return { x = c.x, y = c.y, z = c.z, heading = h }
end

function platform.getMySpeed()
    local ped = getLocalPed()
    if not ped then return 0 end
    return safeCall(GetEntitySpeed, ped) or 0
end

function platform.getMyVehicle()
    local ped = getLocalPed()
    if not ped then return nil end
    local veh = safeCall(GetVehiclePedIsIn, ped, false)
    if not veh or veh == 0 then return nil end
    local cls = safeCall(GetVehicleClass, veh) or -1
    local vtype = (cls == 15) and "heli" or (cls == 16) and "plane" or (cls == 14) and "boat" or "car"
    return {
        handle = veh,
        type = vtype,
        displayType = (cls == 15 or cls == 16) and "Air" or cls == 14 and "Boat" or "Vehicle",
        modelHash = safeCall(GetEntityModel, veh),
        isDriver = safeCall(GetPedInVehicleSeat, veh, -1) == ped,
        isEmergency = cls == 18,
        isEngineOn = safeCall(GetIsVehicleEngineRunning, veh) == true,
    }
end

function platform.getClothingItem(slotType, slotId)
    local ped = getLocalPed()
    if not ped then return -1 end
    if slotType == "prop" then
        return safeCall(GetPedPropIndex, ped, slotId) or -1
    end
    return safeCall(GetPedDrawableVariation, ped, slotId) or -1
end

function platform.isPlayerShooting()
    local ped = getLocalPed()
    if not ped then return false end
    return safeCall(IsPedShooting, ped) == true
end

function platform.getActiveWeaponId(entity)
    return safeCall(GetSelectedPedWeapon, entity or getLocalPed())
end

function platform.cancelAnimations()
    local ped = getLocalPed()
    if ped then safeCall(ClearPedTasks, ped) end
end

function platform.getMyEntityHandle()
    return getLocalPed()
end

local _ignoredWeapons = nil
function platform.getIgnoredWeaponIds()
    if not _ignoredWeapons then
        _ignoredWeapons = {}
        -- Weapon hashes are identical across engines since they're the
        -- underlying GTA model hashes.
        local names = {
            'WEAPON_STUNGUN', 'WEAPON_FLAREGUN', 'WEAPON_FIREEXTINGUISHER',
            'WEAPON_PETROLCAN', 'WEAPON_SNOWBALL', 'WEAPON_BALL', 'WEAPON_SMOKEGRENADE',
        }
        for i = 1, #names do
            local h = safeCall(GetHashKey, names[i])
            if h then _ignoredWeapons[h] = true end
        end
    end
    return _ignoredWeapons
end

-- ─── Remote / network entity access ─────────────────────────────────

function platform.getRemotePlayerPosition(serverId)
    local playerIdx = safeCall(GetPlayerFromServerId, serverId)
    if not playerIdx or playerIdx == -1 then return nil end
    local ped = safeCall(GetPlayerPed, playerIdx)
    if not ped or ped == 0 then return nil end
    local c = safeCall(GetEntityCoords, ped)
    if not c then return nil end
    return {
        x = c.x, y = c.y, z = c.z,
        speed = safeCall(GetEntitySpeed, ped) or 0,
        heading = safeCall(GetEntityHeading, ped) or 0,
    }
end

function platform.getNetworkEntityPosition(networkId)
    if safeCall(NetworkDoesNetworkIdExist, networkId) ~= true then return nil end
    local entity = safeCall(NetworkGetEntityFromNetworkId, networkId)
    if not entity or entity == 0 then return nil end
    local c = safeCall(GetEntityCoords, entity)
    if not c then return nil end
    return { x = c.x, y = c.y, z = c.z, speed = safeCall(GetEntitySpeed, entity) or 0 }
end

function platform.isNetworkIdValid(netId)
    return safeCall(NetworkDoesNetworkIdExist, netId) == true
end

function platform.isEntityValid(handle)
    return safeCall(DoesEntityExist, handle) == true
end

function platform.getNetworkId(handle)
    return safeCall(VehToNet, handle) or 0
end

function platform.resolveNetworkId(netId)
    return safeCall(NetworkGetEntityFromNetworkId, netId)
end

function platform.getEntityPosition(entity)
    local c = safeCall(GetEntityCoords, entity)
    if not c then return { x = 0, y = 0, z = 0 } end
    return { x = c.x, y = c.y, z = c.z }
end

function platform.getCameraState()
    local ped = getLocalPed()
    if not ped then return { position = { x=0, y=0, z=0 }, rotation = { x=0, y=0, z=0 }, speed = 0 } end
    local vehicle = safeCall(GetVehiclePedIsIn, ped, false)
    local coords
    if vehicle and vehicle ~= 0 then
        coords = safeCall(GetEntityCoords, vehicle) or safeCall(GetEntityCoords, ped)
    else
        coords = safeCall(GetEntityCoords, ped)
    end
    if not coords then coords = { x = 0, y = 0, z = 0 } end
    local rotation = safeCall(GetGameplayCamRot, 0) or { x = 0, y = 0, z = 0 }
    return {
        position = { x = coords.x, y = coords.y, z = coords.z },
        rotation = { x = rotation.x, y = rotation.y, z = rotation.z },
        speed = safeCall(GetEntitySpeed, ped) or 0,
    }
end

-- ─── Map markers (Helix route; degrade to safeCall) ─────────────────

function platform.createMapMarker(x, y, z) return safeCall(AddBlipForCoord, x, y, z) end
function platform.removeMapMarker(handle) safeCall(RemoveBlip, handle) end
function platform.isMapMarkerValid(handle) return safeCall(DoesBlipExist, handle) == true end
function platform.moveMapMarker(handle, x, y, z) safeCall(SetBlipCoords, handle, x, y, z) end
function platform.setMarkerRotation(handle, rot) safeCall(SetBlipRotation, handle, rot) end
function platform.setMarkerIcon(handle, icon) safeCall(SetBlipSprite, handle, icon) end
function platform.setMarkerColor(handle, color) safeCall(SetBlipColour, handle, color) end
function platform.setMarkerScale(handle, scale) safeCall(SetBlipScale, handle, scale) end
function platform.setMarkerShortRange(handle, sr) safeCall(SetBlipAsShortRange, handle, sr) end
function platform.setMarkerDisplay(handle, display) safeCall(SetBlipDisplay, handle, display) end
function platform.setMarkerOpacity(handle, alpha) safeCall(SetBlipAlpha, handle, alpha) end

function platform.setMarkerLabel(handle, label)
    if type(BeginTextCommandSetBlipName) ~= "function" then return end
    BeginTextCommandSetBlipName("STRING")
    AddTextComponentString(label)
    EndTextCommandSetBlipName(handle)
end

function platform.setMarkerHeadingIndicator(handle, show) safeCall(ShowHeadingIndicatorOnBlip, handle, show) end
function platform.getPlayerMapMarker() return safeCall(GetMainPlayerBlipId) end

-- ─── Timing ─────────────────────────────────────────────────────────

function platform.now()
    if Timer and type(Timer.GetTime) == "function" then return Timer.GetTime() end
    return safeCall(GetGameTimer) or math.floor(os.clock() * 1000)
end

function platform.getGameTime()
    return {
        hour = safeCall(GetClockHours) or 0,
        minute = safeCall(GetClockMinutes) or 0,
    }
end

-- ─── KVP (scoped via Platform once adapter init is available) ───────

function platform.loadData(key)
    return safeCall(GetResourceKvpString, key)
end

function platform.saveData(key, value)
    safeCall(SetResourceKvp, key, value)
end

function platform.removeData(key)
    safeCall(DeleteResourceKvp, key)
end

-- ─── NUI / WebUI bridge ─────────────────────────────────────────────

-- Helix callers typically send to their WebUI handle via Platform.sendUIEvent;
-- this method is kept for parity with fivem_client so consumer code (tRadio
-- cl_bridge.lua) that calls platform.sendToEngine works unchanged. Consumers
-- that need the Helix WebUI handle should use Platform.sendUIEvent directly.
function platform.sendToEngine(msg)
    if _TLIB_HELIX_WEBUI and type(_TLIB_HELIX_WEBUI.SendEvent) == "function" then
        pcall(function() _TLIB_HELIX_WEBUI:SendEvent(msg and msg.action or "message", msg) end)
        return
    end
    safeCall(SendNUIMessage, msg)
end

function platform.showCursor()
    if HPlayer and HPlayer.ShowCursor then
        pcall(function() HPlayer:ShowCursor(true) end)
    else
        safeCall(SetNuiFocus, true, true)
    end
end

function platform.releaseCursor()
    if HPlayer and HPlayer.ShowCursor then
        pcall(function() HPlayer:ShowCursor(false) end)
    else
        safeCall(SetNuiFocusKeepInput, false)
        safeCall(SetNuiFocus, false, false)
    end
end

-- Helix WebUI manages its own cursor/focus pairing — mode 1 gives the UI
-- focus without freezing game input, which is already the "keep input
-- active" behaviour consumers want from FiveM's SetNuiFocusKeepInput.
function platform.setInputMode(mode)
    if mode == 1 then platform.showCursor() else platform.releaseCursor() end
end

function platform.setKeepInputActive(state)
    -- No-op: Helix WebUI doesn't freeze gameplay input when a cursor is shown.
end

function platform.releaseCursorSuppressPause()
    platform.releaseCursor()
    -- Helix doesn't ship the pause-menu-leak bug SetNuiFocusKeepInput needs
    -- guarding against, so no disable-control-action loop is required.
end

function platform.activateProximityVoice()
    safeCall(SetControlNormal, 0, 249, 1.0)
end

-- ─── Events ─────────────────────────────────────────────────────────

function platform.sendToServer(event, ...)
    if TriggerServerEvent then TriggerServerEvent(event, ...) end
end

function platform.showChatMessage(title, text)
    if TriggerEvent then
        TriggerEvent("chat:addMessage", { args = { title, text } })
    end
end

function platform.emitEvent(event, ...)
    if TriggerEvent then TriggerEvent(event, ...) end
end

function platform.getResourceId()
    if _G.__PackageName then return _G.__PackageName end
    return safeCall(GetCurrentResourceName) or "unknown"
end

function platform.wrapExport(resource, name, fn)
    local pkg = resource or _G.__PackageName or safeCall(GetCurrentResourceName)
    if type(exports) == 'function' then
        pcall(exports, pkg, name, fn)
    end
end

-- ─── Key bindings ────────────────────────────────────────────────────

do
    local function normalizePair(cb, eventType)
        if type(cb) == 'table' then
            return cb.press or cb.onPress or cb[1],
                   cb.release or cb.onRelease or cb[2]
        end
        if eventType == 'Released' then return nil, cb end
        return cb, nil
    end

    function platform.bindKey(key, cb, eventType, bindingId, label)
        if type(Input) ~= 'table' or type(Input.BindKey) ~= 'function' then return end
        local pressCb, releaseCb = normalizePair(cb, eventType)
        if pressCb   then pcall(Input.BindKey, key, pressCb,   'Pressed')  end
        if releaseCb then pcall(Input.BindKey, key, releaseCb, 'Released') end
    end
end

-- ─── Voice backend (no native Helix voice layer yet) ────────────────
-- Returns unavailable by default. Servers running a Helix-compatible voice
-- plugin can override these methods from consumer code after load.

platform.voice = {
    isAvailable = function() return false end,
    backend     = function() return 'none' end,
    onAvailabilityChanged = function(cb)
        if type(cb) == 'function' then pcall(cb, false, 'none') end
    end,
    overrideProximityRange = function() return false end,
    clearProximityOverride = function() end,
    setSubmixForServerId   = function() end,
    setAudioInputIntent    = function() end,
}

return platform
