-- Platform adapter for consumer resource VMs. tLib's own VM has an equivalent
-- surface in shared/lib/adapter/; the two are separate copies because a consumer's
-- natives must be invoked from the consumer's VM, not through a tLib export.

if type(GetCurrentResourceName) ~= "function" or type(IsDuplicityVersion) ~= "function" then
    error("[tLib] Unsupported runtime: only the FiveM platform adapter is available", 0)
end

local platform = { _engine = "fivem" }

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
        -- Through nativeTruth for the same reason isEntityValid is: this is a
        -- BOOL native, so it answers with the number 0 for "off", and 0 is
        -- truthy. A consumer branching on `v.isEngineOn` saw every engine as on.
        isEngineOn = nativeTruth(GetIsVehicleEngineRunning(veh)),
    }
end

--- Fallback bound for the seat scan, matching the server adapter's constant.
--- Only reached when `GetVehicleMaxNumberOfPassengers` gives no usable answer —
--- normally the client knows the vehicle's real seat count and scans exactly it.
platform.MAX_SEAT_INDEX = 16

--- The FRONT seat the local player occupies. Mirrors the server's
--- `getPlayerFrontSeat`: seats -1 and 0 only, a rear seat reads as nil.
--- @return seat, vehicleHandle, netId — or nil.
function platform.getMyFrontSeat()
    local ped = PlayerPedId()
    if not IsPedInAnyVehicle(ped, false) then return nil end
    local veh = GetVehiclePedIsIn(ped, false)
    -- GetVehiclePedIsIn can transiently return 0 on the same frame that
    -- IsPedInAnyVehicle returns true (a one-frame native desync), so the guard
    -- is not redundant — without it seat queries are passed entity 0.
    if veh == 0 then return nil end
    local seat = nil
    if GetPedInVehicleSeat(veh, -1) == ped then
        seat = -1
    elseif GetPedInVehicleSeat(veh, 0) == ped then
        seat = 0
    end
    if seat == nil then return nil end
    return seat, veh, NetworkGetNetworkIdFromEntity(veh)
end

--- ANY seat the local player occupies, rear rows included. Mirrors the server's
--- `getPlayerSeat`, including the seat numbering: -1 driver, 0 front passenger,
--- 1 upwards the rear rows in layout order.
---
--- Unlike the server, the client CAN ask the vehicle how many seats it has
--- (`GetVehicleMaxNumberOfPassengers`, 0xA7C4F2C6E744A550), so the scan is
--- exact here and `MAX_SEAT_INDEX` is only the fallback for a vehicle that
--- answers with nothing usable.
--- @return seat, vehicleHandle, netId — or nil.
function platform.getMySeat()
    local ped = PlayerPedId()
    if not IsPedInAnyVehicle(ped, false) then return nil end
    local veh = GetVehiclePedIsIn(ped, false)
    -- Same one-frame native desync guard as getMyFrontSeat: without it the seat
    -- queries below are passed entity 0.
    if veh == 0 then return nil end

    if GetPedInVehicleSeat(veh, -1) == ped then
        return -1, veh, NetworkGetNetworkIdFromEntity(veh)
    end

    -- Passenger seats are 0 .. count-1, so the last index is one less than the
    -- count. An unusable answer falls back to the shared bound rather than to
    -- zero, which would silently make every rear seat read as on foot.
    local passengers = GetVehicleMaxNumberOfPassengers(veh)
    local last = platform.MAX_SEAT_INDEX
    if type(passengers) == "number" and passengers >= 1 then last = passengers - 1 end

    for index = 0, last do
        if GetPedInVehicleSeat(veh, index) == ped then
            return index, veh, NetworkGetNetworkIdFromEntity(veh)
        end
    end
    return nil
end

--- Server IDs of the two front-seat occupants of a vehicle, as seen locally.
--- Either may be nil (empty seat, or an NPC — a ped with no player index).
--- @return driverServerId, passengerServerId
function platform.getFrontSeatServerIds(vehicle)
    if not vehicle or vehicle == 0 then return nil, nil end
    local function idOf(index)
        local ped = GetPedInVehicleSeat(vehicle, index)
        if not ped or ped == 0 then return nil end
        local playerIndex = NetworkGetPlayerIndexFromPed(ped)
        -- -1 is the natives' "this ped is not a player". Returning it as an ID
        -- would hand consumers a server ID that addresses nobody.
        if not playerIndex or playerIndex < 0 then return nil end
        local serverId = GetPlayerServerId(playerIndex)
        if not serverId or serverId <= 0 then return nil end
        return serverId
    end
    return idOf(-1), idOf(0)
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
    if type(NetworkDoesNetworkIdExist) ~= "function" then return nil end
    if not NetworkDoesNetworkIdExist(networkId) then return nil end
    local entity = NetworkGetEntityFromNetworkId(networkId)
    if not entity or entity == 0 or not DoesEntityExist(entity) then return nil end
    local c = GetEntityCoords(entity)
    return { x = c.x, y = c.y, z = c.z, speed = GetEntitySpeed(entity) }
end

function platform.isNetworkIdValid(netId)
    if type(NetworkDoesNetworkIdExist) ~= "function" then return false end
    return nativeTruth(NetworkDoesNetworkIdExist(netId))
end

function platform.isEntityValid(handle)
    -- Through nativeTruth, like isNetworkIdValid above and like the server
    -- twin. This returned the raw native for a while, which is the NUMBER 0 for
    -- a destroyed entity -- and 0 is truthy in Lua, so every caller spelling the
    -- check as `not isEntityValid(e)` read a dead entity as alive.
    return nativeTruth(DoesEntityExist(handle))
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

--- Give focus back to the game, in the one order that is safe either way.
---
--- There were three orderings of these two natives in this tree, two of them in
--- THIS file, and a comment in `shared/lib/adapter/ui.lua` asserting that the
--- wrong one leaks `keepInput` into the next focus cycle. That comment names no
--- measurement and its history was squashed in the layout refactor (a226c76),
--- so it is an assertion, not evidence — and the comment on
--- `setKeepInputActive` right below it asserts the opposite premise ("no-op
--- until focus has been granted"), which if true would make clearing keepInput
--- *after* the release the leaking order. The two cannot both be right.
---
--- Neither can be checked from outside the game: `SET_NUI_FOCUS` and
--- `SET_NUI_FOCUS_KEEP_INPUT` are not in the native reference at all (only the
--- `IsNuiFocused` / `IsNuiFocusKeepingInput` readers are), and the stack has no
--- offline NUI focus oracle.
---
--- So this takes the strictest reading of both claims instead of picking one:
--- clear keepInput while focus is still held, release focus, clear it again.
--- The second clear is a no-op under one semantics and the load-bearing one
--- under the other, it is idempotent under both, and it costs one native call
--- on a path that runs when a UI closes. That is cheaper than being wrong.
---
--- Do not "simplify" this back to two calls without a measurement in the
--- game. `IsNuiFocusKeepingInput()` is the oracle; read it after a release.
local function releaseNuiFocus()
    SetNuiFocusKeepInput(false)
    SetNuiFocus(false, false)
    SetNuiFocusKeepInput(false)
end

platform.releaseCursor = releaseNuiFocus

-- NUI focus with mode-level control. Mode 1 = cursor visible + UI input;
-- mode 0 = cursor hidden, game input. Mirrors Platform.setInputMode in the
-- tLib VM so consumer code can call the same name either side.
function platform.setInputMode(mode)
    if mode == 1 then
        SetNuiFocus(true, true)
    else
        releaseNuiFocus()
    end
end

-- Keeps gameplay input live while the NUI cursor is visible. Consumers pair
-- this with DisableControlAction for the specific controls they want to
-- suppress (attack/look/etc.) during UI focus.
function platform.setKeepInputActive(state)
    SetNuiFocusKeepInput(state == true)
end

--- Hold the pause menu shut for `frames` frames. The in-flight Escape that
--- closed a UI otherwise reaches the game and opens the map.
local function suppressPause(frames, stillMine)
    Citizen.CreateThread(function()
        for _ = 1, frames do
            if stillMine and not stillMine() then return end
            DisableControlAction(0, 199, true)
            DisableControlAction(0, 200, true)
            DisableControlAction(2, 199, true)
            DisableControlAction(2, 200, true)
            Citizen.Wait(0)
        end
    end)
end

function platform.releaseCursorSuppressPause()
    releaseNuiFocus()
    suppressPause(15)
end

--- Release focus on the NEXT frame, and only if the session that asked for it
--- is still the current one.
---
--- Three resources discovered both halves of this independently and none of
--- them was in the shared helper:
---
--- - `tELS/client/cl_editor.lua` — calling SetNuiFocus from inside a NUI
---   callback can fail silently, so the release has to yield first.
--- - the same file, and `tVDJ/client/nui.lua` — the generation guard. A UI that
---   reopens before the deferred thread resumes has already taken focus
---   synchronously, so an ungated release revokes the NEW session's focus. The
---   symptom is a fully-drawn editor with no cursor whose gizmo ignores every
---   click, and the only cure is exiting and re-entering. Exit-then-reopen
---   inside one frame is an ordinary user action: `/telsedit` is a toggle, and
---   tELS's settings dialog opens the editor immediately after closing itself.
--- - `tLib/client/cl_layout.lua` warns about the third part: never try to
---   re-acquire focus from a deferred thread. This only ever releases.
---
--- `session` is a snapshot of the caller's generation counter and `current` a
--- function returning the live one. Pass neither and the guard is skipped,
--- which is correct for a UI that cannot reopen within a frame.
---
---     platform.releaseCursorDeferred(mySession, function() return session end)
function platform.releaseCursorDeferred(session, current, suppressPauseFrames)
    local stillMine = function()
        if current == nil then return true end
        return current() == session
    end
    Citizen.CreateThread(function()
        Citizen.Wait(0)
        if not stillMine() then return end
        releaseNuiFocus()
        local frames = suppressPauseFrames or 15
        if frames > 0 then suppressPause(frames, stillMine) end
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

-- IT NOW ACTUALLY WRAPS. IT DID NOT, AND THE NAME SAID IT DID.
--
-- This was a bare `exports(name, fn)` with a comment explaining only why the
-- `resource` argument is ignored. Roughly 40 call sites across tRadio, tRadar,
-- tAFK and tChirp adopted it as a throw guard, because that is what it is
-- called; none of them got one. A Lua error inside an export body does not
-- propagate to the caller across the FiveM export boundary — the call returns
-- `undefined`, the real message is lost, and it resurfaces somewhere unrelated
-- as `"undefined" is not valid JSON`. That is the single most expensive failure
-- shape in this estate to debug, and the guard that was supposed to prevent it
-- was a rename of the thing it was guarding against.
--
-- `resource` is still accepted for signature symmetry and still ignored:
-- `exports(name, fn)` always registers under the calling resource. It IS used
-- in the error line, which is the first thing a reader needs.
--
-- `table.pack`/`unpack` rather than a plain `return fn(...)`: several exports
-- return more than one value (`ok, reason` is the house shape) and a guard that
-- silently truncated them to the first would be a new bug in place of the old.
function platform.wrapExport(resource, name, fn)
    exports(name, function(...)
        local result = table.pack(pcall(fn, ...))
        if result[1] then return table.unpack(result, 2, result.n) end
        -- Printed, not re-raised. Re-raising puts it back where it came from:
        -- invisible to the caller. The caller still gets nil, which is what it
        -- got before — the change is that the reason now exists somewhere.
        print(("^1[%s] export '%s' threw: %s^7"):format(resource or "?", name, tostring(result[2])))
        return nil
    end)
end

-- Thin FiveM wrapper over RegisterCommand + RegisterKeyMapping.
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

    --- Every bind this resource registered, in registration order.
    ---
    --- Exists so a keybind can be inspected rather than only fired: a controls
    --- page, a `<resource>_diag` dump, and the conflict check below all read it.
    --- Without it a `RegisterKeyMapping` is write-only — the engine takes it and
    --- nothing in-process can answer "what did we bind?".
    local _registry = {}

    --- Valid RegisterKeyMapping input groups.
    ---
    --- The group used to be hardcoded to 'keyboard', and that single line is why
    --- three resources never adopted this helper: every in-world editor needs
    --- MOUSE_BUTTON for orbit/look, so tELS, tAFK and tRadio each dropped to raw
    --- RegisterKeyMapping and took their own naming conventions with them.
    local VALID_GROUPS = {
        keyboard = true,
        MOUSE_BUTTON = true,
        pad_digitalbuttonany = true,
        pad_analogbutton = true,
    }

    --- Composed so every product reads the same way in GTA's control list.
    ---
    --- That list is flat, sorted by resource, and shows only this string. Five
    --- different formats currently ship ("ELS: X", "Radio - X", "tDetector: x",
    --- "LED Editor: X", and tLib's own bare "Open Menu"), so a player scanning
    --- ~70 rows cannot tell which product a row belongs to.
    ---
    --- The unbound suffix generalises a habit only tELS had: an entry with no
    --- default key is invisible until the player knows to go looking for it.
    local function composeLabel(product, action, defaultKey)
        local text
        if product and product ~= '' and action and action ~= '' then
            text = ('%s: %s'):format(product, action)
        else
            text = action or product or ''
        end
        if (defaultKey == nil or defaultKey == '') and text ~= '' then
            text = text .. ' (unbound — assign a key in GTA keybinds menu)'
        end
        return text
    end

    -- Same resolution the other shared/imports modules use: `tlib.name` when the
    -- table is present, falling back to the literal. `tLibName` in imports.lua is
    -- a local there and is NOT visible in a module chunk's environment.
    local tLibName = (type(tlib) == 'table' and tlib.name) or 'tLib'

    local function record(entry)
        _registry[#_registry + 1] = entry
        -- Best-effort report to tLib so conflicts can be found ACROSS resources.
        -- Intra-resource conflicts are findable here; the live ones are not —
        -- tELS's PA mic and tRadio's push-to-talk both default to B, and neither
        -- VM can see the other.
        --
        -- The pcall is NOT a version fallback — this module and
        -- client/cl_keybinds.lua's `ReportKeybind` ship in the same tLib and
        -- cannot disagree about whether the export exists. It is there because
        -- consumers call bindKey at FILE SCOPE, so tLib's own client VM may not
        -- have registered its exports yet, and a missing export RAISES rather
        -- than returning nil. A diagnostic must never take a player's keybinds
        -- down with it.
        pcall(function()
            exports[tLibName]:ReportKeybind(entry)
        end)
    end

    --- Conflicts among THIS resource's own binds.
    ---
    --- Returns `{ { group = , key = , tokens = { ... } }, ... }`. Two mappings on
    --- one default key both register and both dispatch, so nothing errors — the
    --- vehicle just does two things per press. tELS shipped exactly that: its
    --- siren-tone loop ran 1..8 while cruise, takedown and traffic advisor had
    --- already claimed 6, 7 and 8.
    function platform.keybindConflicts()
        local seen, out = {}, {}
        for _, e in ipairs(_registry) do
            if e.default and e.default ~= '' then
                local k = e.group .. '\1' .. e.default
                seen[k] = seen[k] or {}
                local list = seen[k]
                list[#list + 1] = e.token
            end
        end
        for k, tokens in pairs(seen) do
            if #tokens > 1 then
                local group, key = k:match('^(.-)\1(.*)$')
                out[#out + 1] = { group = group, key = key, tokens = tokens }
            end
        end
        return out
    end

    --- The registry, for a controls UI, a diag dump or docs generation.
    function platform.keybinds()
        return _registry
    end

    --- Register a keybind.
    ---
    --- Two call forms. The positional one is the original and is unchanged —
    --- every existing call site keeps working:
    ---
    ---     platform.bindKey(key, cb, eventType, bindingId, label)
    ---
    --- The table form is preferred for new code:
    ---
    ---     platform.bindKey{
    ---       id      = 'toggle_lights',   -- namespaced to <resource>_<id>
    ---       token   = 'lbar_toggle',     -- OPT OUT of namespacing; see below
    ---       product = 'ELS',
    ---       action  = 'Toggle Lights',
    ---       default = 'Q',
    ---       group   = 'keyboard',        -- or MOUSE_BUTTON / pad_*
    ---       press   = fn, release = fn,
    ---       pair    = true,              -- false => one command, no +/- pair
    ---       when    = SOME_FLAG,         -- false => skip registration entirely
    ---     }
    ---
    --- `token` exists because **a command name IS the stored binding**. FiveM
    --- persists a player's rebind against the command token, so renaming a token
    --- silently discards that rebind and the key reverts to default. tRadio's
    --- `talkOnRadio`/`toggleradioui` and tELS's 32 `lbar_*` tokens therefore
    --- cannot be migrated to a namespaced form — pass them as `token` and leave
    --- them alone. New binds should use `id` and get namespacing for free.
    ---
    --- `when` is not sugar for an `if` around the call. A RegisterKeyMapping is
    --- permanent in the player's FiveM settings the moment it is first seen, so a
    --- bind registered once and later removed leaves a dead row in their control
    --- list forever. Gate it here rather than registering speculatively.
    function platform.bindKey(key, cb, eventType, bindingId, label)
        local opts
        if type(key) == 'table' then
            opts = key
        else
            opts = {
                default = key,
                token = bindingId,
                label = label,
                _legacyCb = cb,
                _legacyEvent = eventType,
            }
        end

        if opts.when ~= nil and not opts.when then return end

        local pressCb, releaseCb
        if opts._legacyCb ~= nil then
            pressCb, releaseCb = normalizePair(opts._legacyCb, opts._legacyEvent)
        else
            pressCb, releaseCb = opts.press, opts.release
        end

        local defaultKey = opts.default or ''
        local group = opts.group or 'keyboard'
        if not VALID_GROUPS[group] then
            error(('platform.bindKey: unknown input group %q'):format(tostring(group)), 2)
        end

        local token
        if type(opts.token) == 'string' and opts.token ~= '' then
            token = opts.token:gsub('[^%w_]', '_')
        elseif type(opts.id) == 'string' and opts.id ~= '' then
            token = (_resourceName:lower() .. '_' .. opts.id):gsub('[^%w_]', '_')
        else
            local count           = (_bindCount[defaultKey] or 0) + 1
            _bindCount[defaultKey] = count
            local base            = cmdName(defaultKey)
            token                 = count == 1 and base or (base .. '_' .. count)
        end

        local displayLabel
        if type(opts.label) == 'string' and opts.label ~= '' then
            displayLabel = opts.label
        elseif opts.product or opts.action then
            displayLabel = composeLabel(opts.product, opts.action, defaultKey)
        else
            displayLabel = token:gsub('_', ' ')
        end

        local pair = opts.pair
        if pair == nil then pair = true end

        if pair then
            RegisterCommand('+' .. token, function()
                if pressCb then pressCb() end
            end, false)
            RegisterCommand('-' .. token, function()
                if releaseCb then releaseCb() end
            end, false)
            RegisterKeyMapping('+' .. token, displayLabel, group, defaultKey)
        else
            -- One-shot toggles (tDetector's mute/dim/mark) are plain commands with
            -- no release half. Forcing a +/- pair on them would register a dead
            -- `-token` command and a release the caller never asked for.
            RegisterCommand(token, function()
                if pressCb then pressCb() end
            end, false)
            RegisterKeyMapping(token, displayLabel, group, defaultKey)
        end

        record({
            token = token,
            resource = _resourceName,
            label = displayLabel,
            product = opts.product,
            action = opts.action,
            default = defaultKey,
            group = group,
            pair = pair,
        })
    end
end

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
