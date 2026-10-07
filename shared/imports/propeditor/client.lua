--[[
    tLib — shared 3D prop editor (Lua half)

    Loaded into the CONSUMER's client VM, like every other module under
    shared/imports/: `tlib.propeditor`. It has to run there rather than inside
    tLib's own VM because it registers NUI callbacks against the consumer's
    `ui_page`, sends NUI messages to the consumer's page, and creates and owns
    objects the consumer's own prop lifecycle then tracks.

        local editor = tlib.propeditor.create({ ... descriptor ... })

    ── What this module is ─────────────────────────────────────────────────────

    Everything in tRadio's `client/cl_prop_editor.lua` that is not tRadio: the
    orbit camera and its maths, the disabled-control set, the Escape suppression,
    the per-frame loop with its camera-position throttle, the 18-way camera
    command switch, the prop adoption sweep, the ownership decorator, the three
    close branches, and all eleven NUI callbacks.

    Everything that IS a particular resource arrives in the descriptor. See
    `create` for the full list; the four that are easy to get wrong are called
    out here because getting them wrong is silent:

      * `vehicleKey`  — how placements are KEYED. tRadio, tRadar and tDetector
        all key by `tostring(GetEntityModel(veh))` today, but that is a fact
        about the current tree and not a law: a resource that keys by spawn name
        (`GetDisplayNameFromVehicleModel`) is keying a different namespace, and a
        shared editor that hardcoded either one would write every placement under
        the wrong key for the other — with no error, because both are strings and
        both index a table.

      * `isRegisteredPropModel` / `resolvePropModel` — the model-preservation
        rule. See `savedModelFor` below. This is the one correctness requirement
        in this file that has already cost data in two resources.

      * `decor` — the ownership mark. Two resources sharing a decorator name
        would each adopt and delete the other's props.

      * `prefix` — the event namespace. Every NUI callback, every NUI action and
        the caller-supplied net events are `<prefix>:...`.

    ── Not owned here ──────────────────────────────────────────────────────────

    The prop LIFECYCLE (the pool scan that bolts a prop to every configured
    vehicle) stays in the consumer. This module borrows one prop for the duration
    of an edit and hands it back through `takeProp`/`giveProp`, which is the only
    contact the two have.
]]

local PropEditor = {}

-- ══════════════════════════════════════════════════════════════════════════
--  PURE RULES — no natives, no state. tests/lua/propeditor-*.lua drive these
--  directly.
-- ══════════════════════════════════════════════════════════════════════════

--- What a placement record's `model` field must say when it is saved again.
---
--- ⚠️ THE ANSWER IS NEVER `resolvePropModel(record.model)`, and that is the whole
--- reason this function exists rather than being inlined.
---
--- A record written before its resource had a prop-model registry has no `model`
--- key at all, and `resolvePropModel(nil)` answers with the configured default —
--- correctly, because that IS the model such a record wears. But writing that
--- answer back turns "follow the server's default" into "pinned to ztr540
--- forever", for every legacy record, the first time someone nudged its
--- position by a centimetre. The record then stops tracking the owner's config
--- and nothing ever tells them.
---
--- The same trap has a second shape: a helper that hands callers a record with
--- `model` filled in for convenience must hand back a COPY (see `placementView`),
--- or merely READING a placement rewrites it in memory and the next save
--- persists the rewrite.
---
--- So: keep the value that was already there, or nil if there was none — and
--- drop a value naming a model this server no longer offers, because keeping it
--- would pin the record to something unspawnable.
---
--- @param record table|nil   the stored placement, or nil for a fresh one
--- @param isRegistered fun(name: any): boolean
--- @return string|nil
function PropEditor.savedModelFor(record, isRegistered)
    if type(record) ~= 'table' then return nil end
    local model = record.model
    if type(model) ~= 'string' then return nil end
    if not isRegistered(model) then return nil end
    return model
end

--- A read-only view of a placement with `model` resolved to the model that will
--- actually be spawned, so a caller never has to know the resolution rules.
---
--- A SHALLOW COPY, deliberately. Returning the live record with `model` filled in
--- is the second shape of the trap documented on `savedModelFor`: the editor
--- saves whatever it finds in the record, so reading the data would quietly
--- rewrite it.
---
--- @param record table|nil
--- @param resolve fun(name: any): string
--- @return table|nil
function PropEditor.placementView(record, resolve)
    if type(record) ~= 'table' then return nil end
    local out = {}
    for k, v in pairs(record) do out[k] = v end
    out.model = resolve(record.model)
    return out
end

--- Prop offset (vehicle-local) to world coordinates, given the vehicle's matrix
--- as `GetEntityMatrix` returns it. Used by focusSelected and viewDriverPov.
--- @param m table  { fwd = {x,y,z}, right = ..., up = ..., pos = ... }
--- @param o table  { x, y, z } vehicle-local offset
function PropEditor.localToWorld(m, o)
    return
        m.pos.x + m.right.x * o.x + m.fwd.x * o.y + m.up.x * o.z,
        m.pos.y + m.right.y * o.x + m.fwd.y * o.y + m.up.y * o.z,
        m.pos.z + m.right.z * o.x + m.fwd.z * o.y + m.up.z * o.z
end

-- ══════════════════════════════════════════════════════════════════════════
--  ORBIT CAMERA — pure maths over a plain state table
-- ══════════════════════════════════════════════════════════════════════════
--
--  state = { yaw = deg, pitch = deg, dist = m, focus = { x, y, z } }
--
--  Separated from the natives so it can be asserted off-game. Nothing in here
--  touches a cam handle; `Editor` below is what calls SetCamCoord with the
--  result of `orbit.eye`.

local orbit = {}
PropEditor.orbit = orbit

--- Degrees of orbit per pixel of pointer drag.
---
--- Per PIXEL, not per normalised axis. The delta cannot come from the pad: this
--- editor holds `SetNuiFocus(true, true)` and under NUI cursor focus CEF owns
--- pointer movement, so `GetDisabledControlNormal(0, 1)` reports one frame of
--- motion and then zero for as long as the button is held. That is the measured
--- "it moves a pixel and then stops" symptom, and disabling controls 1 and 2
--- first does not restore it. The page is the only source of this delta — see
--- `tLib/shared/ts/camera-drag.ts`.
orbit.ORBIT_SENS_PX = 0.22
--- Fraction of the orbit distance panned per pixel of pointer drag.
orbit.PAN_SENS_PX = 0.0022

orbit.PITCH_LIMIT = 80.0
orbit.DIST_MIN = 0.1
orbit.DIST_MAX = 50.0
orbit.ORBIT_STEP = 15.0   -- degrees per keyboard/toolbar nudge
orbit.PAN_STEP = 0.15     -- metres per keyboard/toolbar nudge
orbit.ZOOM_STEP = 0.15    -- fraction of distance per keyboard/toolbar nudge
orbit.WASD_ORBIT_RATE = 60.0 -- degrees per second while held
orbit.WASD_ZOOM_RATE = 1.5   -- fraction per second while held
orbit.DEFAULT_FOV = 50.0
orbit.ORTHO_FOV = 5.0     -- what togglePersp flips to; not a real ortho camera

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function clampPitch(p) return clamp(p, -orbit.PITCH_LIMIT, orbit.PITCH_LIMIT) end
local function clampDist(d) return clamp(d, orbit.DIST_MIN, orbit.DIST_MAX) end

function orbit.new(focusX, focusY, focusZ)
    return {
        yaw = 0.0,
        pitch = -20.0,
        dist = 5.0,
        focus = { x = focusX or 0.0, y = focusY or 0.0, z = focusZ or 0.0 },
    }
end

--- Where the camera sits, given yaw/pitch/dist around `focus`.
function orbit.eye(s)
    local yawRad = math.rad(s.yaw)
    local pitchRad = math.rad(s.pitch)
    local cosPitch = math.cos(pitchRad)
    return
        s.focus.x + math.sin(yawRad) * cosPitch * s.dist,
        s.focus.y + math.cos(yawRad) * cosPitch * s.dist,
        s.focus.z + math.sin(pitchRad) * s.dist
end

--- The inverse of `eye`: yaw/pitch/dist that would put the camera at (x, y, z)
--- looking at the current focus. Distance is clamped to [2, 15] on purpose when
--- `clampOpen` is true — that is the "inherit the gameplay camera" case, where a
--- far-away or inside-the-car gameplay camera must not become the starting orbit.
function orbit.lookFrom(s, x, y, z, clampOpen)
    local dx, dy, dz = x - s.focus.x, y - s.focus.y, z - s.focus.z
    local dist = math.sqrt(dx * dx + dy * dy + dz * dz)
    if dist < 0.01 then dist = 0.01 end
    s.dist = clampOpen and clamp(dist, 2.0, 15.0) or dist
    s.yaw = math.deg(math.atan(dx, dy))
    s.pitch = clampPitch(math.deg(math.asin(dz / dist)))
    return s
end

--- Camera-right in world space (yaw only — right never tilts).
function orbit.camRight(s)
    local yawRad = math.rad(s.yaw)
    return math.cos(yawRad), -math.sin(yawRad), 0.0
end

--- Camera-up in world space.
function orbit.camUp(s)
    local yawRad = math.rad(s.yaw)
    local pitchRad = math.rad(s.pitch)
    return
        -math.sin(pitchRad) * math.sin(yawRad),
        -math.sin(pitchRad) * math.cos(yawRad),
        math.cos(pitchRad)
end

--- One batch of pointer movement from the page, in device pixels.
---
--- ── The sign of every term here is load-bearing ─────────────────────────────
---
--- All four axis/control pairs obey ONE convention: **the scene follows the
--- cursor**. Drag right and what you are looking at moves right; drag down and it
--- moves down. Two of the four disagreed with that and were reported in game as
--- "left = right" on Shift-pan and "inverted up/down" on orbit.
---
---   pan-horizontal  drag right -> focus moves camera-LEFT  -> scene moves right
---   pan-vertical    drag down  -> focus moves camera-UP     -> scene moves down
---   orbit-yaw       drag right -> yaw increases             -> scene swings right
---   orbit-pitch     drag down  -> pitch increases           -> scene tips down
---
--- The focus always travels OPPOSITE the apparent motion of the scene, so every
--- pan term is a `+`. Vertical already was (`+ cu*dy`); horizontal was a `-`, and
--- that lone sign is the whole of the pan bug.
---
--- `tests/lua/propeditor-orbit-camera.lua` pins each of the four independently.
--- @param mode string 'orbit' | 'pan' | 'dolly'
function orbit.applyDrag(s, dx, dy, mode)
    if mode == 'pan' then
        local panSpeed = s.dist * orbit.PAN_SENS_PX
        local crx, cry = orbit.camRight(s)
        local cux, cuy, cuz = orbit.camUp(s)
        s.focus.x = s.focus.x + crx * dx * panSpeed + cux * dy * panSpeed
        s.focus.y = s.focus.y + cry * dx * panSpeed + cuy * dy * panSpeed
        s.focus.z = s.focus.z + cuz * dy * panSpeed
    elseif mode == 'dolly' then
        s.dist = clampDist(s.dist * (1.0 + dy * 0.004))
    else
        s.yaw = s.yaw + dx * orbit.ORBIT_SENS_PX
        s.pitch = clampPitch(s.pitch + dy * orbit.ORBIT_SENS_PX)
    end
    return s
end

function orbit.zoom(s, factor)
    s.dist = clampDist(s.dist * factor)
    return s
end

--- The camera commands that need nothing but this state table — sixteen of the
--- eighteen. `focusSelected`, `focusAll`, `viewDriverPov` and `togglePersp` need
--- the vehicle or the cam handle and are handled by the Editor.
--- @return boolean handled
function orbit.command(s, cmd)
    local STEP = orbit.ORBIT_STEP
    if cmd == 'orbitLeft' then s.yaw = s.yaw + STEP
    elseif cmd == 'orbitRight' then s.yaw = s.yaw - STEP
    elseif cmd == 'orbitUp' then s.pitch = clampPitch(s.pitch + STEP)
    elseif cmd == 'orbitDown' then s.pitch = clampPitch(s.pitch - STEP)
    elseif cmd == 'panLeft' then
        local rx, ry = orbit.camRight(s)
        s.focus.x = s.focus.x + rx * orbit.PAN_STEP
        s.focus.y = s.focus.y + ry * orbit.PAN_STEP
    elseif cmd == 'panRight' then
        local rx, ry = orbit.camRight(s)
        s.focus.x = s.focus.x - rx * orbit.PAN_STEP
        s.focus.y = s.focus.y - ry * orbit.PAN_STEP
    elseif cmd == 'panUp' then
        local ux, uy, uz = orbit.camUp(s)
        s.focus.x = s.focus.x - ux * orbit.PAN_STEP
        s.focus.y = s.focus.y - uy * orbit.PAN_STEP
        s.focus.z = s.focus.z - uz * orbit.PAN_STEP
    elseif cmd == 'panDown' then
        local ux, uy, uz = orbit.camUp(s)
        s.focus.x = s.focus.x + ux * orbit.PAN_STEP
        s.focus.y = s.focus.y + uy * orbit.PAN_STEP
        s.focus.z = s.focus.z + uz * orbit.PAN_STEP
    elseif cmd == 'zoomIn' then orbit.zoom(s, 1.0 - orbit.ZOOM_STEP)
    elseif cmd == 'zoomOut' then orbit.zoom(s, 1.0 + orbit.ZOOM_STEP)
    elseif cmd == 'viewFront' then s.yaw = 180.0; s.pitch = 0.0
    elseif cmd == 'viewBack' then s.yaw = 0.0; s.pitch = 0.0
    elseif cmd == 'viewRight' then s.yaw = 90.0; s.pitch = 0.0
    elseif cmd == 'viewLeft' then s.yaw = -90.0; s.pitch = 0.0
    elseif cmd == 'viewTop' then s.pitch = orbit.PITCH_LIMIT
    elseif cmd == 'viewBottom' then s.pitch = -orbit.PITCH_LIMIT
    elseif cmd == 'viewFlip' then s.yaw = s.yaw + 180.0; s.pitch = -s.pitch
    else return false end
    return true
end

-- ══════════════════════════════════════════════════════════════════════════
--  RUNTIME
-- ══════════════════════════════════════════════════════════════════════════

--- Controls disabled for every frame the editor is open. Movement, weapons,
--- vehicle inputs and melee: the player is sitting in a frozen car staring at a
--- gizmo, and anything they press is meant for the editor.
local DISABLED_CONTROLS = {
    24, 25,   -- attack / aim
    30, 31,   -- move LR / move UD
    21, 36,   -- sprint / duck
    22,       -- jump
    44, 38,   -- cover / pickup (Q / E)
    37, 47,   -- weapon select / detonate
    71, 72,   -- vehicle accel / brake
    59, 60,   -- vehicle LR / vehicle UD
    85, 86,   -- vehicle radio / horn
    140, 141, -- melee
    142, 143, -- melee alt
    257,      -- attack 2
    263, 264, -- melee alt 2
}
PropEditor.DISABLED_CONTROLS = DISABLED_CONTROLS

--- The GTA pause menu, disabled for every frame the editor is open.
---
--- ── Measured, not guessed: this is the "GTA exit sound" ─────────────────────
---
--- Reported as "when i hit save or exit etc i don't like the gta style exit
--- sound/effect that happens". It is the PAUSE MENU opening underneath the
--- editor, with its own whoosh and screen blur, on the same keypress that closes
--- the editor.
---
--- The editor holds `SetNuiFocusKeepInput(true)` so the numpad view bindings keep
--- working, and that sends every KEY to the game as well as to the page. Two of
--- the editor's own bindings are pause-menu keys:
---
---   Escape -> 200 FRONTEND_PAUSE_ALTERNATE   the editor's Cancel
---   P      -> 199 FRONTEND_PAUSE             the editor's driver-POV view
---
--- Neither was disabled. Proved in game: with the editor open and nothing else
--- touched, driving control 200 for twenty frames left `IsPauseMenuActive()` true.
---
--- `suppressInputAfterClose` below does disable the same pair, but only from the
--- frame AFTER the close — which is a frame too late for the keypress that caused
--- the close, and does nothing at all for P, which does not close anything.
---
--- Group 2 as well as 0: these are FRONTEND controls, and that is the pair
--- `suppressInputAfterClose` and `platform.releaseCursorSuppressPause` already
--- disable in both groups.
local PAUSE_CONTROLS = { 199, 200 }
PropEditor.PAUSE_CONTROLS = PAUSE_CONTROLS

--- Only resend the camera to the page when it has actually moved this far.
--- Without it every frame of a static camera is a `SendNUIMessage` round trip.
local CAM_MOVE_THRESH = 0.01

--- Driver head bone, for the `viewDriverPov` command.
local BONE_HEAD = 31086

--- Suppresses the GTA pause/back menu inputs for ~15 frames after the editor
--- closes via Escape, so the in-flight Escape does not open the GTA map.
local function suppressInputAfterClose()
    Citizen.CreateThread(function()
        Citizen.Wait(0)
        tlib.platform.setKeepInputActive(false)
        tlib.platform.setInputMode(0)
        for _ = 1, 15 do
            DisableControlAction(0, 199, true)
            DisableControlAction(0, 200, true)
            DisableControlAction(2, 199, true)
            DisableControlAction(2, 200, true)
            Citizen.Wait(0)
        end
    end)
end

local function noop() end
local function alwaysTrue() return true end

--- English text for every string the shared chrome can show. The Lua half only
--- needs the two it says out loud; the other 36 belong to the TSX half and live
--- in `tLib/shared/ts/prop-editor/strings.ts`.
local DEFAULT_STRINGS = {
    not_in_vehicle = '~y~You must be in a vehicle to open the prop editor.~w~',
    model_load_failed = '~r~Failed to load the prop model.~w~',
}
PropEditor.DEFAULT_STRINGS = DEFAULT_STRINGS

--- Builds the editor. Returns an instance; see the bottom of this file for its
--- surface.
---
--- Descriptor — required:
---   prefix        string   event/callback namespace, e.g. 'radio'. Every NUI
---                          callback and NUI action becomes '<prefix>:<name>'.
---   decor         string   ownership decorator, e.g. 'tRadio_prop'. MUST be
---                          unique per resource.
---   saveEvent     string   server event: (key, data, displayName)
---   removeEvent   string   server event: (key, displayName)
---   vehicleKey    fun(veh): string   how placements are keyed.
---   placements    fun(): table       key -> stored record. Read, never written.
---   resolvePropModel      fun(name: any): string
---   isRegisteredPropModel fun(name: any): boolean
---   loadPropModel fun(name: string): boolean   streams the model in; blocks.
---
--- Descriptor — optional:
---   displayName   fun(veh): string   defaults to the vehicle's display name.
---   canEdit       fun(): boolean     client-side gate. Defaults to allowing;
---                                    the SERVER is the authority either way.
---   notify        fun(message)       defaults to a bare `print`.
---   translate     fun(key): string?  'not_in_vehicle' | 'model_load_failed'.
---   takeProp      fun(veh): number?  removes the vehicle's prop from the
---                                    consumer's lifecycle tracking and returns
---                                    it, for the editor to borrow.
---   giveProp      fun(veh, prop)     hands a prop back to lifecycle tracking.
---   onStateChange fun(active, prop)  mirrors the editor's state into whatever
---                                    the consumer's lifecycle thread reads, so
---                                    it does not reclaim the prop mid-edit.
---   onOpen        fun(key, name)     after the page is told to open.
---   onClose       fun()              after the page is told to close.
---   fov           number             defaults to 50.
function PropEditor.create(descriptor)
    assert(type(descriptor) == 'table', 'tlib.propeditor.create: descriptor table required')
    for _, key in ipairs({ 'prefix', 'decor', 'saveEvent', 'removeEvent' }) do
        assert(type(descriptor[key]) == 'string' and descriptor[key] ~= '',
            ('tlib.propeditor.create: descriptor.%s must be a non-empty string'):format(key))
    end
    for _, key in ipairs({ 'vehicleKey', 'placements', 'resolvePropModel',
                           'isRegisteredPropModel', 'loadPropModel' }) do
        assert(type(descriptor[key]) == 'function',
            ('tlib.propeditor.create: descriptor.%s must be a function'):format(key))
    end

    local d = descriptor
    local prefix = d.prefix
    local decor = d.decor
    local fov = tonumber(d.fov) or orbit.DEFAULT_FOV

    local vehicleKey = d.vehicleKey
    local placements = d.placements
    local resolveModel = d.resolvePropModel
    local isRegistered = d.isRegisteredPropModel
    local loadModel = d.loadPropModel
    local displayNameOf = d.displayName
        or function(veh) return (GetDisplayNameFromVehicleModel(GetEntityModel(veh))):upper() end
    local canEdit = d.canEdit or alwaysTrue
    local takeProp = d.takeProp or function() return nil end
    local giveProp = d.giveProp or noop
    local onStateChange = d.onStateChange or noop
    local onOpen = d.onOpen or noop
    local onClose = d.onClose or noop

    local notify = d.notify or function(message) print(('[%s] %s'):format(prefix, message)) end
    local translate = d.translate or function() return nil end
    local function T(key)
        local value = translate(key)
        if type(value) == 'string' and value ~= '' then return value end
        return DEFAULT_STRINGS[key] or key
    end

    local function event(name) return ('%s:%s'):format(prefix, name) end

    -- ── State ────────────────────────────────────────────────────────────

    local active = false
    local vehicle = nil
    local prop = nil
    local key = ''          -- the placement key, from vehicleKey
    local displayName = ''
    local propModel = nil   -- the model actually spawned
    -- What `model` must say when this placement is saved again. NOT propModel.
    -- See PropEditor.savedModelFor.
    local savedModel = nil
    local offset = { x = 0.0, y = 0.0, z = 0.0 }
    local rotation = { x = 0.0, y = 0.0, z = 0.0 }
    -- Uniform scale. ONE scalar, by the owner's decision, though the matrix
    -- underneath supports three. 1.0 is "normal size" and is what every record
    -- written before records had a scale means.
    local scale = tlib.drivenprop.SCALE_DEFAULT
    local panelHovered = false
    local camMode = false   -- WASD camera
    local lastTime = 0
    local stopped = false

    local cam = nil
    local camState = orbit.new()

    local lastSentCamPos, lastSentCamFocus = nil, nil

    local function setActive(value)
        active = value
        onStateChange(active, prop)
    end

    -- ── Ownership mark ───────────────────────────────────────────────────
    --
    -- The tracking table only lasts as long as this incarnation of the
    -- resource; a prop bolted to a car outlives it. Recovering those needs
    -- evidence that survives a restart, and neither the model hash nor "it is
    -- attached to a vehicle" is that — either one would have us deleting an
    -- object another resource created and happens to have attached. A decorator
    -- is set BY US, ON the object we created.
    --
    -- If another resource already holds a DecorRegisterLock, registration fails
    -- and every DecorSetBool is a no-op — so `isOwnedProp` answers false for
    -- everything and the adoption sweep simply finds nothing. That is the right
    -- way round: the failure mode is an orphan left behind, never someone
    -- else's prop deleted.
    Citizen.CreateThread(function()
        if not DecorIsRegisteredAsType(decor, 2) then
            DecorRegister(decor, 2) -- 2 = bool
        end
    end)

    local function markOwnedProp(obj)
        if not obj or obj == 0 or not DoesEntityExist(obj) then return obj end
        if DecorIsRegisteredAsType(decor, 2) then
            DecorSetBool(obj, decor, true)
        end
        return obj
    end

    local function isOwnedProp(obj)
        if not obj or obj == 0 or not DoesEntityExist(obj) then return false end
        return DecorExistOn(obj, decor) and DecorGetBool(obj, decor)
    end

    -- ── Camera ───────────────────────────────────────────────────────────

    local function pushCam()
        if not cam or not DoesCamExist(cam) then return end
        if not vehicle or not DoesEntityExist(vehicle) then return end
        local ex, ey, ez = orbit.eye(camState)
        SetCamCoord(cam, ex + 0.0, ey + 0.0, ez + 0.0)
        PointCamAtCoord(cam, camState.focus.x + 0.0, camState.focus.y + 0.0, camState.focus.z + 0.0)
    end

    local function createCam()
        if cam and DoesCamExist(cam) then DestroyCam(cam, false) end
        cam = CreateCam('DEFAULT_SCRIPTED_CAMERA', true)
        SetCamFov(cam, fov + 0.0)

        local vehPos = GetEntityCoords(vehicle)
        camState = orbit.new(vehPos.x + 0.0, vehPos.y + 0.0, vehPos.z + 1.0)

        -- Start from wherever the gameplay camera already is, clamped so an
        -- inside-the-car or far-off gameplay camera is not inherited verbatim.
        local camPos = GetGameplayCamCoord()
        orbit.lookFrom(camState, camPos.x, camPos.y, camPos.z, true)

        pushCam()
        RenderScriptCams(true, true, 500, true, false)
    end

    local function destroyCam()
        if cam and DoesCamExist(cam) then
            RenderScriptCams(false, true, 500, true, false)
            DestroyCam(cam, false)
        end
        cam = nil
    end

    --- One wheel notch from the page. `delta` is a raw DOM `WheelEvent.deltaY`:
    --- positive scrolls the content down, which by every 3D editor's convention
    --- means zoom OUT.
    ---
    --- The wheel used to be read here as `IsDisabledControlJustPressed(0, 241/242)`
    --- and never fired once. The editor holds `SetNuiFocus(true, true)`, and under
    --- that focus CEF owns the wheel outright -- exactly as it owns pointer
    --- movement, which is why the middle-mouse orbit had to move to the browser
    --- too. `SetNuiFocusKeepInput` does not rescue it: it keeps key controls and
    --- mouse BUTTONS flowing, and the wheel is neither. The page gets every wheel
    --- event, so the page is the only correct source.
    local function applyScrollZoom(delta)
        -- A wheel over a NUI panel scrolls that panel; it must not also dolly.
        -- The canvas is the only element with the listener, so this is belt and
        -- braces rather than the primary guard.
        if panelHovered then return end
        if delta > 0 then
            orbit.zoom(camState, 1.0 + orbit.ZOOM_STEP)
        elseif delta < 0 then
            orbit.zoom(camState, 1.0 - orbit.ZOOM_STEP)
        else
            return
        end
        pushCam()
    end

    local function handleWasdCam(dt)
        if not camMode then return end
        local rate = orbit.WASD_ORBIT_RATE
        if IsDisabledControlPressed(0, 21) then rate = rate * 2.5 end

        local dirty = false
        local s = camState
        if IsControlPressed(0, 34) then s.yaw = s.yaw + rate * dt; dirty = true end                      -- A
        if IsControlPressed(0, 35) then s.yaw = s.yaw - rate * dt; dirty = true end                      -- D
        if IsControlPressed(0, 32) then s.pitch = math.min(orbit.PITCH_LIMIT, s.pitch + rate * dt); dirty = true end  -- W
        if IsControlPressed(0, 33) then s.pitch = math.max(-orbit.PITCH_LIMIT, s.pitch - rate * dt); dirty = true end -- S
        if IsControlPressed(0, 44) then s.dist = math.max(orbit.DIST_MIN, s.dist * (1.0 - orbit.WASD_ZOOM_RATE * dt)); dirty = true end -- Q
        if IsControlPressed(0, 38) then s.dist = math.min(orbit.DIST_MAX, s.dist * (1.0 + orbit.WASD_ZOOM_RATE * dt)); dirty = true end -- E
        if dirty then pushCam() end
    end

    -- ── Prop ─────────────────────────────────────────────────────────────
    --
    -- ⚠️ TWO MECHANISMS, CHOSEN BY THE SCALE, AND THAT IS NOT AN OPTIMISATION
    -- THAT COULD BE DROPPED.
    --
    -- `AttachEntityToEntity` cannot carry a scale. Measured: a prop attached and
    -- then given a scaled matrix reads 3.000 in the same tick and 1.000 on the
    -- next frame, and driving the matrix every frame WHILE ATTACHED survives one
    -- frame and then loses it too — the attach recomputation rewrites the basis
    -- from the parent's matrix and the stored offset, and it has no notion of
    -- scale. The entity never detaches; `IsEntityAttached` stays true throughout.
    --
    -- So a scaled prop is driven instead: detached, frozen, and its matrix
    -- written from the vehicle's. `tlib.drivenprop` is that mechanism, with the
    -- measurements and the handedness invariant at its head.
    --
    -- A prop at UNIT scale stays attached, because attachment is free and every
    -- placement that exists today is unit-scaled. The cost of this feature is
    -- therefore paid only by the placements that use it.
    --
    -- The driver is created HERE and exposed on the instance so the consumer's
    -- lifecycle can share it, for the same reason `markOwnedProp` is shared: one
    -- prop is handed back and forth between the editor and the lifecycle through
    -- takeProp/giveProp, and two drivers could both think they owned its matrix.
    local driver = tlib.drivenprop.create({
        onError = function(message) notify(tostring(message)) end,
    })

    --- Puts the prop where the state says, by whichever of the two mechanisms
    --- the current scale calls for — and takes it off the other one.
    ---
    --- Both directions matter. Going scaled -> unit without `driver.remove`
    --- leaves the driver writing the matrix of a prop the engine is also
    --- attaching, which is the fighting-writers case; going unit -> scaled
    --- without `DetachEntity` is the measured failure above.
    local function reattach()
        if not prop or not DoesEntityExist(prop) then return end
        if not (vehicle and DoesEntityExist(vehicle)) then return end

        local placement = {
            x = offset.x, y = offset.y, z = offset.z,
            rx = rotation.x, ry = rotation.y, rz = rotation.z,
            scale = scale,
        }

        if tlib.drivenprop.isUnitScale(scale) then
            if driver.isDriven(prop) then
                driver.remove(prop)
                -- Frozen by the driver, and an attached entity must not be:
                -- the attach is what positions it now.
                FreezeEntityPosition(prop, false)
                SetEntityCollision(prop, false, false)
            end
            DetachEntity(prop, false, false)
            AttachEntityToEntity(
                prop, vehicle, 0,
                offset.x, offset.y, offset.z,
                rotation.x, rotation.y, rotation.z,
                false, false, false, false, 0, true
            )
            return
        end

        -- `update` rather than `add` once it is already driven: `add` would
        -- re-detach and re-freeze an entity that is already both, every frame of
        -- a drag.
        if driver.isDriven(prop) then
            driver.update(prop, placement)
        else
            driver.add(prop, vehicle, placement)
        end
    end

    local function vehicleMatrixData()
        local fwd, right, up, pos = GetEntityMatrix(vehicle)
        return {
            fwd   = { x = fwd.x,   y = fwd.y,   z = fwd.z   },
            right = { x = right.x, y = right.y, z = right.z },
            up    = { x = up.x,    y = up.y,    z = up.z    },
            pos   = { x = pos.x,   y = pos.y,   z = pos.z   },
        }
    end

    --- Finds a prop OF OURS already attached to this vehicle, so the editor
    --- moves the prop the player can see rather than spawning a second one over
    --- the top of it.
    ---
    --- `isOwnedProp` is the ownership test and there is no substitute for it:
    --- taking over an object on model + attachment alone would hand the editor
    --- another resource's prop, which it then repositions and may delete on
    --- save. The model tested is the one THIS vehicle's record resolves to, not
    --- a built-in default — on a server that has moved its default, testing the
    --- built-in would miss every adoption.
    local function adoptAttachedProp(veh, hash)
        for _, obj in ipairs(GetGamePool('CObject')) do
            if GetEntityModel(obj) == hash
                and IsEntityAttachedToEntity(obj, veh)
                and isOwnedProp(obj) then
                return obj
            end
        end
        return nil
    end

    local function deleteProp()
        if prop and DoesEntityExist(prop) then
            -- Off the driver FIRST. The driver drops entries for entities that
            -- no longer exist on its next pass anyway, but leaving a deleted
            -- handle in its table until then is a claim on a handle the engine
            -- is free to reuse immediately.
            driver.remove(prop)
            DetachEntity(prop, false, false)
            DeleteObject(prop)
        end
    end

    --- Hands the prop back to the consumer's lifecycle at a given transform.
    ---
    --- `s` is the uniform scale and is NOT optional in practice: a caller that
    --- omits it hands the prop back at normal size, which for the cancel branch
    --- would silently discard the scale the record was saved with.
    local function attachAt(pos, rot, s)
        s = tlib.drivenprop.normaliseScale(s)
        if tlib.drivenprop.isUnitScale(s) then
            if driver.isDriven(prop) then
                driver.remove(prop)
                FreezeEntityPosition(prop, false)
            end
            DetachEntity(prop, false, false)
            AttachEntityToEntity(
                prop, vehicle, 0,
                pos.x, pos.y, pos.z,
                rot.x, rot.y, rot.z,
                false, false, false, false, 0, true
            )
        else
            driver.add(prop, vehicle, {
                x = pos.x, y = pos.y, z = pos.z,
                rx = rot.x, ry = rot.y, rz = rot.z,
                scale = s,
            })
        end
        giveProp(vehicle, prop)
    end

    -- ── Open / close ─────────────────────────────────────────────────────

    local function open()
        if active then return end

        -- Defence in depth only — the server's save/remove handlers are
        -- independently gated regardless of what this answers.
        if not canEdit() then return end

        local ped = PlayerPedId()
        if not IsPedInAnyVehicle(ped, false) then
            notify(T('not_in_vehicle'))
            return
        end

        local veh = GetVehiclePedIsIn(ped, false)
        local placementKey = vehicleKey(veh)
        local name = displayNameOf(veh)

        -- Set active early so the consumer's lifecycle thread does not
        -- re-attach or reclaim while we are still setting up.
        setActive(true)
        lastTime = GetGameTimer()

        local existing = placements()[placementKey]

        -- The record's own `model`, kept exactly as it was found, and the model
        -- to actually spawn. These are two different values and conflating them
        -- is the data-loss bug PropEditor.savedModelFor documents.
        savedModel = PropEditor.savedModelFor(existing, isRegistered)
        propModel = resolveModel(existing and existing.model)

        if existing and existing.x ~= nil then
            offset = { x = existing.x + 0.0, y = existing.y + 0.0, z = existing.z + 0.0 }
            rotation = { x = existing.rx + 0.0, y = existing.ry + 0.0, z = existing.rz + 0.0 }
            -- Normalised rather than read raw: `scale` is absent on every record
            -- written before this feature, and `normaliseScale(nil)` is 1.0.
            scale = tlib.drivenprop.normaliseScale(existing.scale)
        else
            offset = { x = 0.0, y = 0.0, z = 0.0 }
            rotation = { x = 0.0, y = 0.0, z = 0.0 }
            scale = tlib.drivenprop.SCALE_DEFAULT
        end

        local hash = GetHashKey(propModel)

        -- Borrow the lifecycle's prop if there is one, then sweep the object
        -- pool as a fallback for when the tracking table is out of sync.
        local borrowed = takeProp(veh)
        if borrowed and DoesEntityExist(borrowed) then
            prop = borrowed
        else
            prop = adoptAttachedProp(veh, hash)
            if not prop then
                if not loadModel(propModel) then
                    setActive(false)
                    vehicle, key, displayName, prop = nil, '', '', nil
                    notify(T('model_load_failed'))
                    return
                end
                prop = CreateObject(hash, 0.0, 0.0, 0.0, false, false, false)
                -- Marked at creation, so an editor prop orphaned by a crash is
                -- reclaimable on the same terms as a lifecycle one.
                markOwnedProp(prop)
            end
        end

        vehicle = veh
        key = placementKey
        displayName = name
        setActive(true)

        reattach()
        createCam()
        FreezeEntityPosition(vehicle, true)

        tlib.platform.setInputMode(1)
        tlib.platform.setKeepInputActive(true)

        SendNUIMessage({
            action = event('propEditorInit'),
            vehicleModel = key,
            vehicleDisplayName = displayName,
            propData = {
                x  = offset.x,   y  = offset.y,   z  = offset.z,
                rx = rotation.x, ry = rotation.y, rz = rotation.z,
                scale = scale,
            },
            vehicleMatrix = vehicleMatrixData(),
            hasExisting = existing ~= nil,
            cameraFov = fov,
        })

        onOpen(key, displayName)
    end

    local function close(save, remove)
        if not active then return end
        setActive(false)

        destroyCam()

        if vehicle and DoesEntityExist(vehicle) then
            FreezeEntityPosition(vehicle, false)

            if remove then
                deleteProp()
            elseif save then
                -- Hand the prop back to the consumer's lifecycle tracking, where
                -- we found it.
                if prop and DoesEntityExist(prop) then
                    attachAt(offset, rotation, scale)
                end
            else
                -- Cancel: put the prop back at the saved position, or delete it
                -- if there was never one to go back to.
                local original = placements()[key]
                if original and original.x ~= nil and prop and DoesEntityExist(prop) then
                    attachAt(
                        { x = original.x, y = original.y, z = original.z },
                        { x = original.rx, y = original.ry, z = original.rz },
                        -- The SAVED scale, not the one on screen. Cancel must
                        -- undo a scale change like it undoes a move.
                        original.scale
                    )
                else
                    deleteProp()
                end
            end
        else
            -- Vehicle gone; the prop has nothing to hang on.
            deleteProp()
        end

        prop = nil
        vehicle = nil
        -- Cleared, so `currentKey()` cannot hand a caller the key of an edit that
        -- is already over — an export picker left open past a close would
        -- otherwise act on the last vehicle edited.
        key = ''
        displayName = ''
        savedModel = nil
        -- Back to normal size, so the next open of a record that has no scale
        -- does not inherit the last edit's. `open` sets it from the record
        -- either way; this is belt and braces for the window in between, where
        -- `currentScale()` would otherwise answer with a finished edit's value.
        scale = tlib.drivenprop.SCALE_DEFAULT
        camMode = false
        panelHovered = false
        onStateChange(false, nil)

        SendNUIMessage({ action = event('propEditorClose') })

        -- NUI focus is released on the next frame so an in-flight Escape does
        -- not reach the GTA map.
        suppressInputAfterClose()
        onClose()
    end

    -- ── Camera commands ──────────────────────────────────────────────────

    local function propWorldPos()
        local fwd, right, up, pos = GetEntityMatrix(vehicle)
        return PropEditor.localToWorld({
            fwd = fwd, right = right, up = up, pos = pos,
        }, offset)
    end

    local function cameraCommand(cmd)
        if orbit.command(camState, cmd) then
            pushCam()
            return
        end

        if cmd == 'focusSelected' then
            if not (vehicle and DoesEntityExist(vehicle)) then return end
            local wx, wy, wz = propWorldPos()
            camState.focus = { x = wx + 0.0, y = wy + 0.0, z = wz + 0.0 }
            pushCam()

        elseif cmd == 'focusAll' then
            if not (vehicle and DoesEntityExist(vehicle)) then return end
            local vehPos = GetEntityCoords(vehicle)
            camState.focus = { x = vehPos.x + 0.0, y = vehPos.y + 0.0, z = vehPos.z + 1.0 }
            camState.dist = 5.0
            pushCam()

        elseif cmd == 'togglePersp' then
            -- Not a real orthographic camera: GTA's scripted cams have no ortho
            -- projection, so a very narrow FOV stands in for one.
            if cam and DoesCamExist(cam) then
                local current = GetCamFov(cam)
                SetCamFov(cam, ((current > 10.0) and orbit.ORTHO_FOV or fov) + 0.0)
            end

        elseif cmd == 'viewDriverPov' then
            if not (vehicle and DoesEntityExist(vehicle)) then return end
            local wx, wy, wz = propWorldPos()
            camState.focus = { x = wx + 0.0, y = wy + 0.0, z = wz + 0.0 }
            local head = GetPedBoneCoords(PlayerPedId(), BONE_HEAD, 0.0, 0.0, 0.0)
            orbit.lookFrom(camState, head.x, head.y, head.z, false)
            pushCam()
        end
    end

    -- ── Per-frame thread ─────────────────────────────────────────────────

    Citizen.CreateThread(function()
        while true do
            if stopped then return end

            if not active then
                Citizen.Wait(250)
                lastSentCamPos, lastSentCamFocus = nil, nil

            elseif not vehicle
                or not DoesEntityExist(vehicle)
                or not IsPedInAnyVehicle(PlayerPedId(), false) then
                -- Vehicle or player lost: cancel without saving.
                close(false, false)

            else
                local now = GetGameTimer()
                local dt = math.max(0.001, math.min(0.1, (now - lastTime) / 1000.0))
                lastTime = now
                Citizen.Wait(0)
                if stopped then return end

                for _, ctrl in ipairs(DISABLED_CONTROLS) do
                    DisableControlAction(0, ctrl, true)
                end
                for _, ctrl in ipairs(PAUSE_CONTROLS) do
                    DisableControlAction(0, ctrl, true)
                    DisableControlAction(2, ctrl, true)
                end

                handleWasdCam(dt)

                if cam and DoesCamExist(cam) then
                    local coord = GetCamCoord(cam)
                    local focus = camState.focus
                    local moved = not lastSentCamPos or not lastSentCamFocus
                        or math.abs(coord.x - lastSentCamPos.x) > CAM_MOVE_THRESH
                        or math.abs(coord.y - lastSentCamPos.y) > CAM_MOVE_THRESH
                        or math.abs(coord.z - lastSentCamPos.z) > CAM_MOVE_THRESH
                        or math.abs(focus.x - lastSentCamFocus.x) > CAM_MOVE_THRESH
                        or math.abs(focus.y - lastSentCamFocus.y) > CAM_MOVE_THRESH
                        or math.abs(focus.z - lastSentCamFocus.z) > CAM_MOVE_THRESH

                    if moved then
                        lastSentCamPos = { x = coord.x, y = coord.y, z = coord.z }
                        lastSentCamFocus = { x = focus.x, y = focus.y, z = focus.z }
                        SendNUIMessage({
                            action = 'setCameraPosition',
                            data = {
                                position = { x = coord.x + 0.0, y = coord.y + 0.0, z = coord.z + 0.0 },
                                focus    = { x = focus.x + 0.0, y = focus.y + 0.0, z = focus.z + 0.0 },
                            },
                        })
                    end
                end
            end
        end
    end)

    AddEventHandler('onResourceStop', function(resourceName)
        if resourceName ~= GetCurrentResourceName() then return end
        stopped = true
        if vehicle and DoesEntityExist(vehicle) then
            FreezeEntityPosition(vehicle, false)
        end
    end)

    -- ── NUI callbacks (all eleven) ───────────────────────────────────────

    RegisterNUICallback(event('openPropEditor'), function(_, cb)
        cb(1)
        open()
    end)

    RegisterNUICallback(event('propMoved'), function(data, cb)
        cb(1)
        if not active then return end
        offset = { x = data.x + 0.0, y = data.y + 0.0, z = data.z + 0.0 }
        reattach()
    end)

    RegisterNUICallback(event('propRotated'), function(data, cb)
        cb(1)
        if not active then return end
        rotation = { x = data.rx + 0.0, y = data.ry + 0.0, z = data.rz + 0.0 }
        reattach()
    end)

    RegisterNUICallback(event('propScaled'), function(data, cb)
        cb(1)
        if not active then return end
        if type(data) ~= 'table' then return end
        scale = tlib.drivenprop.normaliseScale(data.scale)
        reattach()
    end)

    RegisterNUICallback(event('propEditorSave'), function(_, cb)
        cb(1)
        if not active then return end
        TriggerServerEvent(d.saveEvent, key, {
            x  = offset.x,   y  = offset.y,   z  = offset.z,
            rx = rotation.x, ry = rotation.y, rz = rotation.z,
            -- `scale` is sent ONLY when it is not unit, so a record that was
            -- never scaled is written back byte-identical to how it was found.
            --
            -- That is the same rule `savedModelFor` documents, for the same
            -- reason: writing `scale = 1.0` into every record the first time
            -- anyone nudged its position would add a key to every legacy record
            -- on disk, and a reader cannot then tell "deliberately normal size"
            -- from "never had an opinion". It also keeps data.json diffs honest.
            scale = (not tlib.drivenprop.isUnitScale(scale)) and scale or nil,
            -- nil on a record that never had one, which keeps it exactly as
            -- legacy as it was. See PropEditor.savedModelFor.
            model = savedModel,
        }, displayName)
        close(true, false)
    end)

    RegisterNUICallback(event('propEditorCancel'), function(_, cb)
        cb(1)
        close(false, false)
    end)

    RegisterNUICallback(event('propEditorRemove'), function(_, cb)
        cb(1)
        if not active then return end
        TriggerServerEvent(d.removeEvent, key, displayName)
        close(false, true)
    end)

    -- One batch of pointer movement from the page, already accumulated over an
    -- animation frame; deltas are device pixels. See orbit.ORBIT_SENS_PX for why
    -- this cannot be read from the pad, and tLib/shared/ts/camera-drag.ts for
    -- the sender.
    RegisterNUICallback(event('propEditorCamDrag'), function(data, cb)
        cb(1)
        if not active then return end
        if type(data) ~= 'table' then return end
        local dx = tonumber(data.dx) or 0.0
        local dy = tonumber(data.dy) or 0.0
        if dx == 0.0 and dy == 0.0 then return end
        orbit.applyDrag(camState, dx + 0.0, dy + 0.0, tostring(data.mode or 'orbit'))
        pushCam()
    end)

    -- One wheel notch from the page. Same reason as the drag above: under
    -- SetNuiFocus(true, true) the wheel never reaches the pad at all, so the
    -- browser sends it. See `applyScrollZoom`.
    RegisterNUICallback(event('propEditorCamZoom'), function(data, cb)
        cb(1)
        if not active then return end
        if type(data) ~= 'table' then return end
        applyScrollZoom(tonumber(data.delta) or 0.0)
    end)

    RegisterNUICallback(event('propEditorPanelHover'), function(data, cb)
        cb(1)
        panelHovered = data.hovered == true
    end)

    RegisterNUICallback(event('setCamMode'), function(data, cb)
        cb(1)
        camMode = data.enabled == true
    end)

    RegisterNUICallback(event('propEditorCameraCmd'), function(data, cb)
        cb(1)
        if not active then return end
        cameraCommand(data.cmd)
    end)

    -- ── Instance surface ─────────────────────────────────────────────────

    return {
        --- Opens the editor for the vehicle the player is in. Safe to bind to a
        --- command or call from an event handler.
        open = open,
        --- `close(save, remove)`. Same three branches the page's buttons take.
        close = close,
        isActive = function() return active end,
        --- The prop currently being edited, or nil. A consumer's lifecycle
        --- reclaim must exclude it: mid-edit it carries the ownership mark but
        --- is deliberately absent from the lifecycle's tracking table, so it
        --- reads as an orphan.
        currentProp = function() return prop end,
        --- The placement key of the open edit, or ''. Callers that add their own
        --- NUI callbacks (an export picker, say) use this rather than keeping a
        --- second copy of the key.
        currentKey = function() return key end,
        currentVehicle = function() return vehicle end,
        --- The ownership decorator, built from `descriptor.decor`. Exposed so a
        --- consumer's own lifecycle uses the same mark rather than a second
        --- implementation that can disagree with this one.
        markOwnedProp = markOwnedProp,
        isOwnedProp = isOwnedProp,
        --- The uniform scale of the open edit, or 1.0. Exposed for the same
        --- reason `currentKey` is: a consumer that adds its own NUI callback
        --- should read the editor's state rather than keep a second copy.
        currentScale = function() return scale end,
        --- The shared `tlib.drivenprop` driver.
        ---
        --- ⚠️ A CONSUMER'S LIFECYCLE MUST USE THIS ONE, not a driver of its own.
        --- One prop is handed back and forth between the editor and the
        --- lifecycle through takeProp/giveProp, and two drivers would both
        --- believe they owned its matrix — which presents as a prop that
        --- flickers between two transforms, with nothing logged, exactly like
        --- two resources streaming one model name.
        driver = driver,
        --- Sends an arbitrary action to the editor page, namespaced.
        send = function(payload)
            payload = payload or {}
            SendNUIMessage(payload)
        end,
        event = event,
    }
end

return PropEditor
