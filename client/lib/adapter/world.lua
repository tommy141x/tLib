-- World and entity natives behind Platform.

local log = Logger.create('tLib/adapter/world')

-- Takes either key case. A FiveM vector3 already has .x/.y/.z, so it passes
-- through without a copy.
local function _toCoordTable(v)
    if type(v) ~= 'table' and type(v) ~= 'userdata' then
        return { x = 0, y = 0, z = 0 }
    end
    if _TLIB_IS_FIVEM and v.x ~= nil then
        return v
    end
    return {
        x = v.x or v.X or 0,
        y = v.y or v.Y or 0,
        z = v.z or v.Z or 0,
    }
end

if _TLIB_IS_FIVEM then
    function Platform.getPlayerCoords()
        local coords = GetEntityCoords(PlayerPedId())
        return { x = coords.x, y = coords.y, z = coords.z }
    end
else
    Platform.getPlayerCoords = Platform._stub('getPlayerCoords')
end

if _TLIB_IS_FIVEM then
    function Platform.getPlayerHeading()
        return GetEntityHeading(PlayerPedId())
    end
else
    Platform.getPlayerHeading = Platform._stub('getPlayerHeading')
end

if _TLIB_IS_FIVEM then
    function Platform.getPlayerPed()
        return PlayerPedId()
    end
else
    Platform.getPlayerPed = Platform._stub('getPlayerPed')
end

if _TLIB_IS_FIVEM then
    function Platform.getEntityCoords(entity)
        if not entity or entity == 0 then return { x = 0, y = 0, z = 0 } end
        local c = GetEntityCoords(entity)
        return { x = c.x, y = c.y, z = c.z }
    end
else
    Platform.getEntityCoords = Platform._stub('getEntityCoords')
end

if _TLIB_IS_FIVEM then
    function Platform.setEntityCoords(entity, coords)
        if not entity or entity == 0 then return end
        local c = _toCoordTable(coords)
        SetEntityCoords(entity, c.x, c.y, c.z, false, false, false, true)
    end
else
    Platform.setEntityCoords = Platform._stub('setEntityCoords')
end

if _TLIB_IS_FIVEM then
    function Platform.getEntityHeading(entity)
        if not entity or entity == 0 then return 0 end
        return GetEntityHeading(entity)
    end
else
    Platform.getEntityHeading = Platform._stub('getEntityHeading')
end

if _TLIB_IS_FIVEM then
    function Platform.setEntityHeading(entity, heading)
        if not entity or entity == 0 then return end
        SetEntityHeading(entity, heading or 0)
    end
else
    Platform.setEntityHeading = Platform._stub('setEntityHeading')
end

if _TLIB_IS_FIVEM then
    function Platform.doesEntityExist(entity)
        if not entity or entity == 0 then return false end
        return DoesEntityExist(entity)
    end
else
    Platform.doesEntityExist = Platform._stub('doesEntityExist')
end

if _TLIB_IS_FIVEM then
    function Platform.deleteEntity(entity)
        if not entity or entity == 0 then return end
        SetEntityAsMissionEntity(entity, true, true)
        DeleteEntity(entity)
    end
else
    Platform.deleteEntity = Platform._stub('deleteEntity')
end

if _TLIB_IS_FIVEM then
    function Platform.createObject(model, coords, networked)
        local c    = _toCoordTable(coords)
        local hash = type(model) == 'number' and model or GetHashKey(model)

        -- Spins while the model loads, so call it from inside a thread.
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
            networked ~= false,
            false, -- dynamic
            false  -- initializeSeed
        )
        SetModelAsNoLongerNeeded(hash)
        return (obj and obj ~= 0) and obj or nil
    end
else
    Platform.createObject = Platform._stub('createObject')
end

if _TLIB_IS_FIVEM then
    --- `model` is a name or a hash; `heading` is yaw in degrees.
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

-- Returns (player, distance), or nil, nil if nobody is within radius.
if _TLIB_IS_FIVEM then
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

if _TLIB_IS_FIVEM then
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

if _TLIB_IS_FIVEM then
    --- Ground Z at (x, y), or nil if the probe never resolves.
    function Platform.getGroundZ(x, y)
        -- GetGroundZFor_3dCoord needs a Z above the ground, so probe from high up.
        local found, groundZ = GetGroundZFor_3dCoord(x, y, 1000.0, false)
        if found then return groundZ end

        -- Nothing there yet: load the collision and retry.
        RequestCollisionAtCoord(x, y)
        local tries = 0
        while tries < 10 do
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

-- One frame of world-space text; call every frame from a thread.
-- opts: scale, color = {r,g,b,a}, outline.
if _TLIB_IS_FIVEM then
    function Platform.drawText3D(coords, text, opts)
        opts          = opts or {}
        local c       = _toCoordTable(coords)
        local scale   = opts.scale or 0.35
        local color   = opts.color or { r = 255, g = 255, b = 255, a = 255 }
        local outline = opts.outline ~= false

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

-- One frame of a marker; call every frame from a thread.
-- opts: dir, rot, scale, color, bobUpDown, faceCamera.
if _TLIB_IS_FIVEM then
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
            2,     -- p19, always 2
            false, -- rotate
            nil,   -- textureDict
            nil,   -- textureName
            false  -- drawOnEnts
        )
    end
else
    Platform.drawMarker = Platform._stub('drawMarker')
end
