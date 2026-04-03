-- tLib/lua/adapter/world.lua
-- World / entity platform abstractions.
--
-- Depends on: lua/adapter/init.lua  (_TLIB_IS_HELIX / _TLIB_IS_FIVEM / Platform)
--
-- Surfaces provided:
--
--   Platform.getPlayerCoords()
--     Returns the local player's current world position as {x, y, z}.
--     FiveM: GetEntityCoords(PlayerPedId()).
--     Helix: K2_GetActorLocation() on the controlled pawn's actor.
--
--   Platform.getPlayerHeading()
--     Returns the local player's current heading (yaw) in degrees.
--     FiveM: GetEntityHeading(PlayerPedId()).
--     Helix: K2_GetActorRotation().Yaw on the controlled pawn.
--
--   Platform.getPlayerPed()
--     Returns the local player's ped/pawn entity handle.
--     FiveM: PlayerPedId() — integer entity handle.
--     Helix: GetPlayerPawn() — APawn userdata.
--
--   Platform.getEntityCoords(entity)
--     Returns the world position of any entity as {x, y, z}.
--     FiveM: GetEntityCoords(entity).
--     Helix: GetEntityCoords(entity) global (Helix functions API) → Vector,
--            normalised to a plain {x, y, z} table.
--
--   Platform.setEntityCoords(entity, coords)
--     Teleports an entity to the given world position.
--     coords may be a table {x,y,z} or a Helix Vector.
--     FiveM: SetEntityCoords with no offset, world-space, clear-area flags.
--     Helix: SetEntityCoords(entity, Vector) global.
--
--   Platform.getEntityHeading(entity)
--     Returns the heading (yaw) of an entity in degrees.
--     FiveM: GetEntityHeading(entity).
--     Helix: GetEntityHeading(entity) global (Helix functions API).
--
--   Platform.setEntityHeading(entity, heading)
--     Sets the heading (yaw) of an entity in degrees.
--     FiveM: SetEntityHeading(entity, heading).
--     Helix: SetEntityHeading(entity, heading) global.
--
--   Platform.doesEntityExist(entity)
--     Returns true if the entity handle is valid and alive.
--     FiveM: DoesEntityExist(entity).
--     Helix: DoesEntityExist(entity) global.
--
--   Platform.deleteEntity(entity)
--     Deletes an entity from the world.
--     FiveM: DeleteEntity() after SetEntityAsMissionEntity().
--     Helix: DeleteEntity(entity) global.
--
--   Platform.createObject(model, coords, networked)
--     Spawns a static prop at the given coords.
--     Returns the entity handle, or nil on failure.
--     model    — FiveM: model name/hash. Helix: asset path string.
--     coords   — table {x, y, z}.
--     networked — boolean (FiveM only; Helix objects are always networked).
--     FiveM: RequestModel → CreateObject → SetModelAsNoLongerNeeded.
--     Helix: StaticMesh constructor — returns an AStaticMeshActor.
--
--   Platform.createPed(model, coords, heading, networked)
--     Spawns a ped/NPC at the given coords and heading.
--     Returns the entity handle, or nil on failure.
--     model    — FiveM: model name/hash. Helix: asset path / ignored (HPawn uses default).
--     coords   — table {x, y, z}.
--     heading  — yaw in degrees.
--     networked — boolean (FiveM only).
--     FiveM: RequestModel → CreatePed (type 4 = PED_TYPE_CIVILIAN_MALE) → SetModelAsNoLongerNeeded.
--     Helix: HPawn constructor with spawn callback.
--
--   Platform.getClosestPlayer(coords, radius)
--     Returns (player, distance) for the nearest player within radius of coords.
--     coords  — table {x, y, z}.
--     radius  — max search distance, or nil for unlimited.
--     FiveM:  Iterates GetActivePlayers() and measures distance manually.
--     Helix:  GetClosestPlayer(Vector, radius) global.
--
--   Platform.getPlayersInRadius(coords, radius)
--     Returns a list of all player handles within radius of coords.
--     coords  — table {x, y, z}.
--     radius  — search radius.
--     FiveM:  Iterates GetActivePlayers() manually.
--     Helix:  GetPlayersInArea(Vector, radius) global.
--
--   Platform.getGroundZ(x, y)
--     Returns the ground Z coordinate at the given X/Y world position.
--     FiveM: GetGroundZFor_3dCoord with a sky-drop probe.
--     Helix: Trace downward from a high point using the Trace API.
--
--   Platform.drawText3D(coords, text, opts)
--     Renders a text label in the world at coords for one frame.
--     opts: { scale, color, outline }  (all optional)
--     FiveM: Set3dTextLabelThisFrame / DrawText3d pattern.
--     Helix: TextRender constructor held for one tick then destroyed.
--            NOTE: on Helix this is expensive if called every frame;
--            consumers should cache the TextRender and update it instead.
--
--   Platform.drawMarker(markerType, coords, opts)
--     Draws a marker in the world for one frame.
--     markerType — integer (FiveM marker type index).
--     coords     — table {x, y, z}.
--     opts: { dir, rot, scale, color, bobUpDown, faceCamera }
--     FiveM: DrawMarker native.
--     Helix: Niagara / StaticMesh approximation — a warn-once stub because
--            Helix has no direct DrawMarker equivalent. Consumers should use
--            the Niagara or StaticMesh classes for persistent markers.

-- ── Warn-once helper ──────────────────────────────────────────────────────────

local log = Logger.create('tLib/adapter/world')

local _warnedOnce = {}
local function _warnOnce(key, msg)
    if not _warnedOnce[key] then
        _warnedOnce[key] = true
        log(msg, 3)
    end
end

-- ── Internal coord normaliser ─────────────────────────────────────────────────
-- Accepts either a plain {x,y,z} table, a FiveM vector3, or a Helix Vector
-- and always returns a plain Lua table with lowercase x/y/z keys.

local function _toCoordTable(v)
    if type(v) ~= 'table' and type(v) ~= 'userdata' then
        return { x = 0, y = 0, z = 0 }
    end
    return {
        x = v.x or v.X or 0,
        y = v.y or v.Y or 0,
        z = v.z or v.Z or 0,
    }
end

-- ── Platform.getPlayerCoords ──────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.getPlayerCoords()
        local pawn = GetPlayerPawn and GetPlayerPawn()
        if not pawn then return { x = 0, y = 0, z = 0 } end
        -- GetEntityCoords is the idiomatic Helix global (functions API).
        if type(GetEntityCoords) == 'function' then
            local v = GetEntityCoords(pawn)
            if v then return _toCoordTable(v) end
        end
        -- Fallback: Actor:K2_GetActorLocation()
        if type(pawn.K2_GetActorLocation) == 'function' then
            local v = pawn:K2_GetActorLocation()
            if v then return _toCoordTable(v) end
        end
        return { x = 0, y = 0, z = 0 }
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getPlayerCoords()
        local coords = GetEntityCoords(PlayerPedId())
        return { x = coords.x, y = coords.y, z = coords.z }
    end
else
    Platform.getPlayerCoords = Platform._stub('getPlayerCoords')
end

-- ── Platform.getPlayerHeading ─────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.getPlayerHeading()
        local pawn = GetPlayerPawn and GetPlayerPawn()
        if not pawn then return 0 end
        if type(GetEntityHeading) == 'function' then
            return GetEntityHeading(pawn) or 0
        end
        if type(pawn.K2_GetActorRotation) == 'function' then
            local rot = pawn:K2_GetActorRotation()
            return rot and (rot.Yaw or rot.yaw or 0) or 0
        end
        return 0
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getPlayerHeading()
        return GetEntityHeading(PlayerPedId())
    end
else
    Platform.getPlayerHeading = Platform._stub('getPlayerHeading')
end

-- ── Platform.getPlayerPed ─────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.getPlayerPed()
        return GetPlayerPawn and GetPlayerPawn() or nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getPlayerPed()
        return PlayerPedId()
    end
else
    Platform.getPlayerPed = Platform._stub('getPlayerPed')
end

-- ── Platform.getEntityCoords ──────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.getEntityCoords(entity)
        if not entity then return { x = 0, y = 0, z = 0 } end
        if type(GetEntityCoords) == 'function' then
            local v = GetEntityCoords(entity)
            if v then return _toCoordTable(v) end
        end
        -- Fallback: Actor method
        if type(entity.K2_GetActorLocation) == 'function' then
            local v = entity:K2_GetActorLocation()
            if v then return _toCoordTable(v) end
        end
        return { x = 0, y = 0, z = 0 }
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getEntityCoords(entity)
        if not entity or entity == 0 then return { x = 0, y = 0, z = 0 } end
        local c = GetEntityCoords(entity)
        return { x = c.x, y = c.y, z = c.z }
    end
else
    Platform.getEntityCoords = Platform._stub('getEntityCoords')
end

-- ── Platform.setEntityCoords ──────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.setEntityCoords(entity, coords)
        if not entity then return end
        local c = _toCoordTable(coords)
        if type(SetEntityCoords) == 'function' then
            SetEntityCoords(entity, Vector(c.x, c.y, c.z))
        elseif type(entity.K2_SetActorLocation) == 'function' then
            entity:K2_SetActorLocation(Vector(c.x, c.y, c.z), false, nil, true)
        end
    end
elseif _TLIB_IS_FIVEM then
    function Platform.setEntityCoords(entity, coords)
        if not entity or entity == 0 then return end
        local c = _toCoordTable(coords)
        SetEntityCoords(entity, c.x, c.y, c.z, false, false, false, true)
    end
else
    Platform.setEntityCoords = Platform._stub('setEntityCoords')
end

-- ── Platform.getEntityHeading ─────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.getEntityHeading(entity)
        if not entity then return 0 end
        if type(GetEntityHeading) == 'function' then
            return GetEntityHeading(entity) or 0
        end
        if type(entity.K2_GetActorRotation) == 'function' then
            local rot = entity:K2_GetActorRotation()
            return rot and (rot.Yaw or rot.yaw or 0) or 0
        end
        return 0
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getEntityHeading(entity)
        if not entity or entity == 0 then return 0 end
        return GetEntityHeading(entity)
    end
else
    Platform.getEntityHeading = Platform._stub('getEntityHeading')
end

-- ── Platform.setEntityHeading ─────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.setEntityHeading(entity, heading)
        if not entity then return end
        if type(SetEntityHeading) == 'function' then
            SetEntityHeading(entity, heading or 0)
        elseif type(entity.K2_SetActorRotation) == 'function' then
            entity:K2_SetActorRotation(Rotator(0, heading or 0, 0), true)
        end
    end
elseif _TLIB_IS_FIVEM then
    function Platform.setEntityHeading(entity, heading)
        if not entity or entity == 0 then return end
        SetEntityHeading(entity, heading or 0)
    end
else
    Platform.setEntityHeading = Platform._stub('setEntityHeading')
end

-- ── Platform.doesEntityExist ──────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.doesEntityExist(entity)
        if not entity then return false end
        if type(DoesEntityExist) == 'function' then
            return DoesEntityExist(entity) == true
        end
        -- Fallback: check if the Actor is not being destroyed
        if type(entity.IsActorBeingDestroyed) == 'function' then
            return not entity:IsActorBeingDestroyed()
        end
        return entity ~= nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.doesEntityExist(entity)
        if not entity or entity == 0 then return false end
        return DoesEntityExist(entity)
    end
else
    Platform.doesEntityExist = Platform._stub('doesEntityExist')
end

-- ── Platform.deleteEntity ─────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.deleteEntity(entity)
        if not entity then return end
        if type(DeleteEntity) == 'function' then
            DeleteEntity(entity)
        elseif type(entity.K2_DestroyActor) == 'function' then
            entity:K2_DestroyActor()
        end
    end
elseif _TLIB_IS_FIVEM then
    function Platform.deleteEntity(entity)
        if not entity or entity == 0 then return end
        SetEntityAsMissionEntity(entity, true, true)
        DeleteEntity(entity)
    end
else
    Platform.deleteEntity = Platform._stub('deleteEntity')
end

-- ── Platform.createObject ─────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    -- model   → full UE static mesh asset path, e.g. '/Game/Props/SM_Barrel.SM_Barrel'
    -- coords  → table {x, y, z}
    -- networked is accepted for API symmetry but ignored (Helix always replicates).
    function Platform.createObject(model, coords, _networked)
        local c = _toCoordTable(coords)
        if type(StaticMesh) ~= 'function' then
            _warnOnce('createObject_noStaticMesh',
                'createObject: StaticMesh constructor not available on this Helix version')
            return nil
        end
        -- StaticMesh(location, rotation, assetPath) → AStaticMeshActor
        local obj = StaticMesh(
            Vector(c.x, c.y, c.z),
            Rotator(0, 0, 0),
            model
        )
        return obj or nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.createObject(model, coords, networked)
        local c    = _toCoordTable(coords)
        local hash = type(model) == 'number' and model or GetHashKey(model)

        -- Synchronous spin inside a thread — callers that need the handle back
        -- immediately should call this from within a Citizen.CreateThread.
        RequestModel(hash)
        local waited = 0
        while not HasModelLoaded(hash) do
            Citizen.Wait(10)
            waited = waited + 10
            if waited > 5000 then
                log('createObject: model load timed out for ' .. tostring(model), 4)
                return nil
            end
        end

        local obj = CreateObject(
            hash,
            c.x, c.y, c.z,
            networked ~= false, -- default networked = true
            false,              -- dynamic
            false               -- initializeSeed
        )
        SetModelAsNoLongerNeeded(hash)
        return (obj and obj ~= 0) and obj or nil
    end
else
    Platform.createObject = Platform._stub('createObject')
end

-- ── Platform.createPed ────────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    -- model    → ignored in current Helix HPawn (uses server-side character config).
    --            Pass nil or any string; it is accepted for API symmetry.
    -- coords   → table {x, y, z}
    -- heading  → yaw degrees
    -- networked → ignored (Helix always replicates pawns)
    -- Returns the HPawn wrapper; the underlying ACharacter may not be ready
    -- until the async spawn callback fires, but the wrapper itself is valid.
    function Platform.createPed(model, coords, heading, _networked)
        local c = _toCoordTable(coords)
        if type(HPawn) ~= 'function' then
            _warnOnce('createPed_noHPawn',
                'createPed: HPawn constructor not available on this Helix version')
            return nil
        end
        local pawn = HPawn(
            Vector(c.x, c.y, c.z),
            Rotator(0, heading or 0, 0)
        )
        return pawn or nil
    end
elseif _TLIB_IS_FIVEM then
    -- model    → model name string or hash integer.
    -- coords   → table {x, y, z}.
    -- heading  → yaw degrees.
    -- networked → boolean.
    function Platform.createPed(model, coords, heading, networked)
        local c    = _toCoordTable(coords)
        local hash = type(model) == 'number' and model or GetHashKey(model)

        RequestModel(hash)
        local waited = 0
        while not HasModelLoaded(hash) do
            Citizen.Wait(10)
            waited = waited + 10
            if waited > 5000 then
                log('createPed: model load timed out for ' .. tostring(model), 4)
                return nil
            end
        end

        -- PED_TYPE_CIVMALE = 4
        local ped = CreatePed(4, hash, c.x, c.y, c.z, heading or 0,
            networked ~= false, false)
        SetModelAsNoLongerNeeded(hash)
        return (ped and ped ~= 0) and ped or nil
    end
else
    Platform.createPed = Platform._stub('createPed')
end

-- ── Platform.getClosestPlayer ─────────────────────────────────────────────────
-- Returns (player, distance) — both nil if no player found within radius.

if _TLIB_IS_HELIX then
    function Platform.getClosestPlayer(coords, radius)
        if type(GetClosestPlayer) == 'function' then
            local c = _toCoordTable(coords)
            local player, dist = GetClosestPlayer(Vector(c.x, c.y, c.z), radius)
            return player or nil, dist or nil
        end
        _warnOnce('getClosestPlayer',
            'getClosestPlayer: GetClosestPlayer global not available on this Helix version')
        return nil, nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getClosestPlayer(coords, radius)
        local c                    = _toCoordTable(coords)
        local myId                 = PlayerId()
        local closest, closestDist = nil, math.huge

        for _, pid in ipairs(GetActivePlayers()) do
            if pid ~= myId then
                local ped  = GetPlayerPed(pid)
                local pc   = GetEntityCoords(ped)
                local dx   = pc.x - c.x
                local dy   = pc.y - c.y
                local dz   = pc.z - c.z
                local dist = math.sqrt(dx * dx + dy * dy + dz * dz)

                if (not radius or dist <= radius) and dist < closestDist then
                    closestDist = dist
                    closest     = pid
                end
            end
        end

        if closest then
            return closest, closestDist
        end
        return nil, nil
    end
else
    Platform.getClosestPlayer = Platform._stub('getClosestPlayer')
end

-- ── Platform.getPlayersInRadius ───────────────────────────────────────────────
-- Returns a list (array table) of player handles within radius of coords.

if _TLIB_IS_HELIX then
    function Platform.getPlayersInRadius(coords, radius)
        if type(GetPlayersInArea) == 'function' then
            local c      = _toCoordTable(coords)
            local result = GetPlayersInArea(Vector(c.x, c.y, c.z), radius)
            -- GetPlayersInArea returns an array of APlayerController.
            if type(result) == 'table' then return result end
        end
        _warnOnce('getPlayersInRadius',
            'getPlayersInRadius: GetPlayersInArea global not available on this Helix version')
        return {}
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getPlayersInRadius(coords, radius)
        local c      = _toCoordTable(coords)
        local result = {}

        for _, pid in ipairs(GetActivePlayers()) do
            local ped  = GetPlayerPed(pid)
            local pc   = GetEntityCoords(ped)
            local dx   = pc.x - c.x
            local dy   = pc.y - c.y
            local dz   = pc.z - c.z
            local dist = math.sqrt(dx * dx + dy * dy + dz * dz)
            if dist <= radius then
                table.insert(result, pid)
            end
        end

        return result
    end
else
    Platform.getPlayersInRadius = Platform._stub('getPlayersInRadius')
end

-- ── Platform.getGroundZ ───────────────────────────────────────────────────────
-- Returns the ground Z at (x, y), or nil if the probe fails.

if _TLIB_IS_HELIX then
    function Platform.getGroundZ(x, y)
        if type(Trace) ~= 'table' or type(Trace.LineTrace) ~= 'function' then
            _warnOnce('getGroundZ',
                'getGroundZ: Trace API not available on this Helix version — returning nil')
            return nil
        end
        -- Cast a ray straight down from a high point.
        local startVec = Vector(x, y, 10000)
        local endVec   = Vector(x, y, -1000)
        local hit      = Trace.LineTrace(startVec, endVec, {
            CollisionChannel.WorldStatic,
            CollisionChannel.WorldDynamic,
        })
        if hit and hit.bBlockingHit and hit.ImpactPoint then
            return hit.ImpactPoint.Z or hit.ImpactPoint.z
        end
        return nil
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getGroundZ(x, y)
        -- GetGroundZFor_3dCoord requires the Z position to be above the ground.
        -- Start high and work downward in a thread-safe probe.
        local found, groundZ = GetGroundZFor_3dCoord(x, y, 1000.0, false)
        if found then return groundZ end

        -- Fallback: request collision load then retry.
        RequestCollisionAtCoord(x, y)
        local tries = 0
        while tries < 30 do
            Citizen.Wait(100)
            found, groundZ = GetGroundZFor_3dCoord(x, y, 1000.0, false)
            if found then return groundZ end
            tries = tries + 1
        end
        return nil
    end
else
    Platform.getGroundZ = Platform._stub('getGroundZ')
end

-- ── Platform.drawText3D ───────────────────────────────────────────────────────
-- Renders world-space text for ONE frame.  Call every frame from a thread.
-- opts keys (all optional):
--   scale   number  text scale (FiveM default 0.35)
--   color   table   {r, g, b, a} 0-255
--   outline boolean draw text shadow/outline

if _TLIB_IS_HELIX then
    -- Helix has no "draw for one frame" text API.  The idiomatic approach is
    -- to create a TextRender actor and destroy it each tick, but that is very
    -- expensive.  We provide it correctly and warn once about the cost so
    -- consumers know to use a cached TextRender for frequent updates instead.
    _warnOnce('drawText3D_helix_note',
        'drawText3D on Helix creates/destroys a TextRender each call. '
        .. 'For per-frame use, create a TextRender once and update its text instead.')

    function Platform.drawText3D(coords, text, opts)
        if type(TextRender) ~= 'function' then
            _warnOnce('drawText3D_noTextRender',
                'drawText3D: TextRender constructor not available on this Helix version')
            return
        end
        opts        = opts or {}
        local c     = _toCoordTable(coords)
        local scale = opts.scale or 1.0
        local color = opts.color or { r = 255, g = 255, b = 255, a = 255 }

        local tr    = TextRender(
            Vector(c.x, c.y, c.z),
            Rotator(0, 0, 0),
            tostring(text),
            scale
        )

        -- Destroy after one tick so it doesn't persist.
        Platform.setTimeout(function()
            if tr and type(tr.K2_DestroyActor) == 'function' then
                tr:K2_DestroyActor()
            end
        end, 0)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.drawText3D(coords, text, opts)
        opts          = opts or {}
        local c       = _toCoordTable(coords)
        local scale   = opts.scale or 0.35
        local color   = opts.color or { r = 255, g = 255, b = 255, a = 255 }
        local outline = opts.outline ~= false -- default true

        SetTextScale(scale, scale)
        SetTextFont(0)
        SetTextProportional(true)
        SetTextColour(color.r, color.g, color.b, color.a)
        if outline then
            SetTextOutline()
        end
        SetTextEntry('STRING')
        SetTextCentre(true)
        AddTextComponentString(tostring(text))

        local onScreen, sx, sy = World3dToScreen2d(c.x, c.y, c.z)
        if onScreen then
            DrawText(sx, sy)
        end
    end
else
    Platform.drawText3D = Platform._stub('drawText3D')
end

-- ── Platform.drawMarker ───────────────────────────────────────────────────────
-- Draws a marker in the world for ONE frame.  Call every frame from a thread.
-- markerType — integer (FiveM marker type; see FiveM docs).
-- coords     — table {x, y, z}
-- opts keys (all optional):
--   dir       table  {x,y,z} direction vector     (default {0,0,0})
--   rot       table  {x,y,z} rotation in degrees  (default {0,0,0})
--   scale     table  {x,y,z} size                 (default {1,1,1})
--   color     table  {r,g,b,a} 0-255              (default {255,0,0,200})
--   bobUpDown boolean                             (default false)
--   faceCamera boolean                            (default false)

if _TLIB_IS_HELIX then
    -- Helix has no direct DrawMarker equivalent.  Persistent markers should
    -- use StaticMesh or Niagara.  We warn once and no-op rather than silently
    -- dropping frames — this makes it obvious the caller needs a Helix-specific
    -- implementation.
    function Platform.drawMarker(markerType, coords, opts)
        _warnOnce('drawMarker',
            'drawMarker is not natively supported on Helix. '
            .. 'Use StaticMesh or Niagara for persistent world markers.')
    end
elseif _TLIB_IS_FIVEM then
    function Platform.drawMarker(markerType, coords, opts)
        opts      = opts or {}
        local c   = _toCoordTable(coords)
        local dir = opts.dir or { x = 0, y = 0, z = 0 }
        local rot = opts.rot or { x = 0, y = 0, z = 0 }
        local scl = opts.scale or { x = 1, y = 1, z = 1 }
        local col = opts.color or { r = 255, g = 0, b = 0, a = 200 }

        DrawMarker(
            markerType,
            c.x, c.y, c.z,
            dir.x, dir.y, dir.z,
            rot.x, rot.y, rot.z,
            scl.x, scl.y, scl.z,
            col.r, col.g, col.b, col.a,
            opts.bobUpDown == true,
            opts.faceCamera == true,
            2,     -- p19 (always 2)
            false, -- rotate
            nil,   -- textureDict
            nil,   -- textureName
            false  -- drawOnEnts
        )
    end
else
    Platform.drawMarker = Platform._stub('drawMarker')
end
