--[[
    tLib — the in-vehicle prop: model registry, placement store and lifecycle.

    Loaded into the CONSUMER's VM: it creates objects the consumer's own files
    look at, and it instantiates `tlib.propeditor`, which registers NUI
    callbacks against the consumer's `ui_page`. `shared.lua` because the pure
    rules are asked on both sides -- what to spawn, and what a save may store.

    Ownership is the DECORATOR and nothing else, and the placement tables are
    cleared in place and never replaced, because consumers alias them.
    Design notes: docs/internal/vehicle-prop.md

]]

local VehicleProp = {}

--  PURE RULES — no natives, no state. tests/lua/vehicleprop.lua drives these
--  directly, which is possible only because they take no globals.

--- Is `model` a plausible archetype name? It is one of the few config strings
--- that reaches a native -- `GetHashKey` then `CreateObject` -- so a path
--- separator, an empty string or an absurd length is never legitimate.
--- @param model any
--- @return string|nil  the trimmed name, or nil when it is not usable
function VehicleProp.normaliseModelName(model)
    if type(model) ~= 'string' then return nil end
    model = model:gsub('^%s+', ''):gsub('%s+$', '')
    if model == '' or #model > 128 or model:find('[/\\%.]') then return nil end
    return model
end

--- Builds the prop-model registry from a `Config.vehicleProp`-shaped table:
---   { default = 'rdx4000', models = { { model = 'rdx4000', label = 'RDX-4000' }, ... } }
---
--- Built wholesale rather than merged: a model the owner deleted from config has
--- to stop being offered. An ABSENT block is the common case, not an error.
---
--- @param builtin string          the model the resource streams itself
--- @param cfg table|nil           the owner's block
--- @return table list             ordered entries, built-in first
--- @return table index            lowercased model name -> entry
--- @return string default         always a model that is in `list`
function VehicleProp.buildRegistry(builtin, cfg)
    local list, index = {}, {}

    local function add(model, label)
        model = VehicleProp.normaliseModelName(model)
        if not model then return end

        local key  = model:lower()
        local text = (type(label) == 'string' and label ~= '') and label or model

        local existing = index[key]
        if existing then
            if existing.label == existing.model and text ~= model then
                existing.label = text
            end
            return
        end

        local entry = { model = model, label = text }
        index[key] = entry
        list[#list + 1] = entry
    end

    add(builtin, builtin)
    if type(cfg) == 'table' and type(cfg.models) == 'table' then
        for _, entry in ipairs(cfg.models) do
            if type(entry) == 'table' then add(entry.model, entry.label) end
        end
    end

    local wanted = type(cfg) == 'table' and cfg.default or nil
    local chosen = type(wanted) == 'string' and index[wanted:lower()] or nil

    return list, index, (chosen and chosen.model) or builtin
end

--- Empties a table WITHOUT replacing it. See the header: consumers alias the
--- placement tables, so the identity of the table is part of the contract.
--- @param t table
--- @return table  the same table
function VehicleProp.clearInPlace(t)
    for k in pairs(t) do t[k] = nil end
    return t
end

--- Copies `source` into `target` in place, keeping only records that look like
--- placements. Filtered on `x ~= nil` rather than trusted: data.json is shared,
--- and a server bug that sent the whole document would have the lifecycle
--- thread attaching a prop to a vehicle model called "installedSounds".
--- @param target table
--- @param source any
--- @return table target
function VehicleProp.replacePlacements(target, source)
    VehicleProp.clearInPlace(target)
    if type(source) ~= 'table' then return target end
    for key, val in pairs(source) do
        if type(val) == 'table' and val.x ~= nil then target[key] = val end
    end
    return target
end

--  THE INSTANCE

local LIFECYCLE_INTERVAL_MS = 2500
local STARTUP_REQUEST_DELAY_MS = 2000
local MODEL_LOAD_ATTEMPTS = 100
local MODEL_LOAD_WAIT_MS = 10

--- @param descriptor table
---   prefix        string    identifier/event namespace, e.g. 'tdet'
---   model         string    the built-in model, streamed by the consumer itself
---   decor         string    the ownership decorator — see the header
---   saveEvent     string    net event the editor saves through
---   removeEvent   string    net event the editor removes through
---   receiveEvent  string?   net event the server pushes the merged table on
---   requestEvent  string?   server event to ask on, ~2s after start
---   registry      table?    initial `Config.vehicleProp`-shaped block
---   fov           number?   editor camera FOV
---   canEdit       function? defence in depth; the server gates independently
---   notify        function? (message) -> ()
---   translate     function? (key) -> string|nil
---   displayName   function? (vehicle) -> string, for the editor's title
---   onOpen        function? passed through to the editor
---   onClose       function? passed through to the editor
---   onGizmoChange function? (isActive, prop) -> (), for consumer-visible globals
function VehicleProp.create(descriptor)
    assert(type(descriptor) == 'table', 'tlib.vehicleprop.create: descriptor table required')
    for _, key in ipairs({ 'prefix', 'model', 'decor', 'saveEvent', 'removeEvent' }) do
        assert(type(descriptor[key]) == 'string' and descriptor[key] ~= '',
            ('tlib.vehicleprop.create: descriptor.%s must be a non-empty string'):format(key))
    end

    local d = descriptor
    local BUILTIN = assert(VehicleProp.normaliseModelName(d.model),
        'tlib.vehicleprop.create: descriptor.model is not a usable archetype name')

    local instance = {}

    --
    -- `models` is a stable table for the same reason the placement tables are:
    -- a consumer hands it to a settings UI once. `setRegistry` refills it.
    local models = {}
    local index  = {}
    local defaultModel = BUILTIN

    --- Rebuilds the registry from a `Config.vehicleProp`-shaped table.
    --- Two invariants it always holds: the built-in is present and first, and
    --- `defaultModel` always names a model in the list.
    function instance.setRegistry(cfg)
        local list, idx, def = VehicleProp.buildRegistry(BUILTIN, cfg)
        VehicleProp.clearInPlace(models)
        for i = 1, #list do models[i] = list[i] end
        index = idx
        defaultModel = def
    end

    --- True when `name` is a model this server offers. Case-insensitive.
    function instance.isRegisteredModel(name)
        return type(name) == 'string' and index[name:lower()] ~= nil
    end

    --- The model name to actually spawn for a saved record's `model` field, in
    --- the registry's own spelling. Everything unresolvable lands on the default,
    --- because all three ways of getting here are ordinary: a record from before
    --- records named a model, a model the owner removed, and a typo. Spawning
    --- nothing reads as the device disappearing, not as a misconfiguration.
    function instance.resolveModel(name)
        local entry = type(name) == 'string' and index[name:lower()] or nil
        if entry then return entry.model end
        return defaultModel
    end

    function instance.defaultModel() return defaultModel end

    instance.PROP_MODEL = BUILTIN
    instance.models = models

    instance.setRegistry(d.registry)

    --
    --   placements[<vehicle model hash as a string>] = { x, y, z, rx, ry, rz, model? }
    --
    --
    local placements = {}
    -- { [vehicleHandle] = propHandle }. This incarnation of the resource only.
    local attached = {}

    instance.placements = placements
    instance.attached   = attached

    --- The prop handle attached to a vehicle, or nil. A DUI screen renderer
    --- asks this to find out whether there is a screen to render at all.
    function instance.getAttached(vehicle)
        local prop = attached[vehicle]
        if prop and DoesEntityExist(prop) then return prop end
        return nil
    end

    --- The saved placement for a vehicle, or nil. `model` is filled in with what
    --- will actually be spawned, as a SHALLOW COPY: writing the resolved name
    --- back would give every legacy record a `model` key, and the editor saves
    --- whatever it finds -- so merely reading would rewrite data.json.
    function instance.getPlacement(vehicle)
        if not DoesEntityExist(vehicle) then return nil end
        local data = placements[tostring(GetEntityModel(vehicle))]
        if type(data) ~= 'table' then return nil end
        return tlib.propeditor.placementView(data, instance.resolveModel)
    end

    --- Replaces the placement table, in place. The consumer's receive handler.
    function instance.setPlacements(source)
        VehicleProp.replacePlacements(placements, source)
    end

    local gizmoActive = false
    local gizmoProp = nil
    local onGizmoChange = d.onGizmoChange

    function instance.isGizmoActive() return gizmoActive end
    function instance.gizmoProp() return gizmoProp end

    -- Model streaming

    --- Blocks until the model is loaded, or gives up after ~1s. Declared above
    --- the editor because the descriptor takes it BY VALUE, and
    --- `tlib.propeditor.create` asserts it is a function at call time.
    local function loadPropModel(modelName)
        local hash = GetHashKey(instance.resolveModel(modelName))
        if not IsModelValid(hash) then return false end
        RequestModel(hash)
        local attempts = 0
        while not HasModelLoaded(hash) and attempts < MODEL_LOAD_ATTEMPTS do
            Citizen.Wait(MODEL_LOAD_WAIT_MS)
            attempts = attempts + 1
        end
        if not HasModelLoaded(hash) then
            SetModelAsNoLongerNeeded(hash)
            return false
        end
        return true
    end

    instance.loadPropModel = loadPropModel

    -- The editor, and the ownership mark that comes with it. Created here rather
    -- than by the consumer because the editor and the lifecycle share one prop,
    -- so there is exactly one implementation of the mark.
    --
    local editor = tlib.propeditor.create({
        prefix      = d.prefix,
        decor       = d.decor,
        saveEvent   = d.saveEvent,
        removeEvent = d.removeEvent,
        fov         = d.fov,

        vehicleKey  = function(vehicle) return tostring(GetEntityModel(vehicle)) end,
        displayName = d.displayName,
        placements  = function() return placements end,

        resolvePropModel      = instance.resolveModel,
        isRegisteredPropModel = instance.isRegisteredModel,
        loadPropModel         = loadPropModel,

        canEdit   = d.canEdit,
        notify    = d.notify,
        translate = d.translate,

        takeProp = function(vehicle)
            local prop = attached[vehicle]
            if not (prop and DoesEntityExist(prop)) then return nil end
            attached[vehicle] = nil
            return prop
        end,
        giveProp = function(vehicle, prop)
            attached[vehicle] = prop
        end,
        onStateChange = function(isActive, prop)
            gizmoActive = isActive
            gizmoProp   = prop
            if onGizmoChange then onGizmoChange(isActive, prop) end
        end,

        onOpen  = d.onOpen,
        onClose = d.onClose,
    })

    instance.editor        = editor
    instance.markOwnedProp = editor.markOwnedProp
    instance.isOwnedProp   = editor.isOwnedProp

    -- Attach / detach

    --- Attaches the device to a vehicle using its saved placement.
    --- Yields while the model streams, so it is only ever called from the
    --- lifecycle thread below.
    local function attachPropToVehicle(vehicle, placement)
        if attached[vehicle] then return end

        local modelName = instance.resolveModel(placement and placement.model)
        local propHash  = GetHashKey(modelName)

        -- Adopt before creating. A prop survives a resource restart while
        -- `attached` does not, so without this sweep a reload spawns a second
        -- prop on top of the first and only tracks the new one.
        for _, obj in ipairs(GetGamePool('CObject')) do
            if IsEntityAttachedToEntity(obj, vehicle)
                and editor.isOwnedProp(obj)
                and obj ~= gizmoProp
            then
                if GetEntityModel(obj) == propHash then
                    attached[vehicle] = obj
                    return
                end
                DetachEntity(obj, false, false)
                DeleteObject(obj)
            end
        end

        if not loadPropModel(modelName) then return end

        -- Streaming took up to a second and the vehicle can have gone in that
        -- window — despawned, exploded, driven out of the streaming radius.
        -- Re-check before attaching to a handle that may now name nothing.
        if not DoesEntityExist(vehicle) then
            SetModelAsNoLongerNeeded(propHash)
            return
        end

        local prop = CreateObject(propHash, 0.0, 0.0, 0.0, false, false, false)
        -- CreateObject signals failure with 0, which Lua treats as TRUE — so
        -- `if not prop` alone never catches it, and the prop silently never
        -- appears.
        if prop == 0 then
            SetModelAsNoLongerNeeded(propHash)
            return
        end
        editor.markOwnedProp(prop)

        -- Unit scale attaches; anything else is DRIVEN. `AttachEntityToEntity`
        -- cannot carry a scale -- measured, with the full write-up and the
        -- handedness invariant at propeditor/client.lua's `TWO MECHANISMS` block.
        if tlib.drivenprop.isUnitScale(placement.scale) then
            AttachEntityToEntity(
                prop, vehicle, 0,
                placement.x  or 0.0, placement.y  or 0.0, placement.z  or 0.0,
                placement.rx or 0.0, placement.ry or 0.0, placement.rz or 0.0,
                false, false, false, false, 0, true
            )
        else
            editor.driver.add(prop, vehicle, {
                x  = placement.x  or 0.0, y  = placement.y  or 0.0, z  = placement.z  or 0.0,
                rx = placement.rx or 0.0, ry = placement.ry or 0.0, rz = placement.rz or 0.0,
                scale = placement.scale,
            })
        end

        attached[vehicle] = prop
        SetModelAsNoLongerNeeded(propHash)
    end

    --- Deletes the prop attached to a vehicle and clears the tracking entry --
    --- the TRACKED HANDLE and nothing else. It deliberately does not sweep nearby
    --- objects of the same model: proximity is not ownership, and on a dead
    --- handle GetEntityCoords returns the world origin. See
    --- docs/internal/vehicle-prop.md.
    local function detachProp(vehicle)
        local prop = attached[vehicle]
        if prop and DoesEntityExist(prop) then
            -- Off the driver first, whether or not it was ever driven: `remove`
            -- is a no-op for an undriven prop, and leaving a deleted handle in
            -- the driver's table is a claim on a handle the engine may reuse.
            editor.driver.remove(prop)
            DetachEntity(prop, false, false)
            DeleteObject(prop)
        end
        attached[vehicle] = nil
    end

    instance.detach = detachProp

    --- Deletes props WE created that no longer have a tracking entry. Ownership
    --- is the decorator and nothing else. Callers must hold
    --- `gizmoActive == false`: mid-edit the editor's prop carries our mark and is
    --- deliberately absent from `attached`, so it would read as an orphan.
    local function reclaimOrphanProps()
        -- "Is it in the tracking table at all", NOT "does its attachment map
        -- back to it": a scaled prop is deliberately not attached, so the
        -- attachment test reads every one of them as an orphan and deletes it.
        local tracked = {}
        for _, prop in pairs(attached) do tracked[prop] = true end

        for _, obj in ipairs(GetGamePool('CObject')) do
            if editor.isOwnedProp(obj) and obj ~= gizmoProp and not tracked[obj] then
                editor.driver.remove(obj)
                DetachEntity(obj, false, false)
                DeleteObject(obj)
            end
        end
    end

    instance.reclaimOrphans = reclaimOrphanProps

    --- Every prop, gone. Resource stop only.
    function instance.cleanupAll()
        for vehicle in pairs(attached) do detachProp(vehicle) end
        VehicleProp.clearInPlace(attached)

        -- Explicitly, because reclaimOrphanProps skips it. Without this the
        -- editor's working prop is the one object that survives a resource stop.
        if gizmoProp and DoesEntityExist(gizmoProp) then
            editor.driver.remove(gizmoProp)
            DetachEntity(gizmoProp, false, false)
            DeleteObject(gizmoProp)
        end
        gizmoProp = nil
        gizmoActive = false
        if onGizmoChange then onGizmoChange(false, nil) end

        reclaimOrphanProps()
        editor.driver.clear()
    end

    --- Drops tracking for props whose vehicle or prop handle has gone away.
    ---
    function instance.reconcile()
        for vehicle, prop in pairs(attached) do
            if not DoesEntityExist(vehicle) or not prop or not DoesEntityExist(prop) then
                detachProp(vehicle)
            end
        end
    end

    AddEventHandler('playerSpawned', instance.reconcile)

    AddEventHandler('onResourceStop', function(resourceName)
        if resourceName ~= GetCurrentResourceName() then return end
        instance.cleanupAll()
    end)

    -- Events

    if type(d.receiveEvent) == 'string' and d.receiveEvent ~= '' then
        RegisterNetEvent(d.receiveEvent, function(props)
            -- Rejects anything that did not come from the server. This decides
            -- which archetype gets streamed in and attached, so a local
            -- TriggerEvent from a cheat menu could otherwise name any model it
            -- liked.
            if source ~= 65535 then return end
            instance.setPlacements(props)
        end)
    end

    if type(d.requestEvent) == 'string' and d.requestEvent ~= '' then
        Citizen.CreateThread(function()
            Citizen.Wait(STARTUP_REQUEST_DELAY_MS)
            TriggerServerEvent(d.requestEvent)
        end)
    end

    --
    -- One pass over the vehicle pool every 2.5s, attaching props to configured
    -- models and clearing stale entries. A poll rather than an event because
    -- there is no event: a vehicle streaming in near the player is not
    -- something a client is told about, and the alternative — attaching only on
    -- entry — would mean the prop popped into existence as a player opened the
    -- door, on a device other people are supposed to be able to see from
    -- outside the car.

    --- True until the first completed pass. See the reclaim at the end of `tick`.
    local firstPassDone = false

    --- One pass. Exposed so a suite can drive it without a thread.
    function instance.tick()
        -- Suppressed while the editor holds a prop: the thread would otherwise
        -- attach a second prop to the vehicle being edited, or detach the one
        -- the editor is moving on the pass after the editor took it off the
        -- tracking table. Skipping is safe rather than lossy — the next pass
        -- after the flag drops reconciles everything this one did not.
        if gizmoActive then return end

        if not next(placements) then
            -- Nothing configured. Still clear entries whose vehicle has gone,
            -- or a server that removes its last placement leaks the table
            -- forever.
            for vehicle in pairs(attached) do
                if not DoesEntityExist(vehicle) then detachProp(vehicle) end
            end
            return
        end

        local seen = {}
        for _, vehicle in ipairs(GetGamePool('CVehicle')) do
            local placement = placements[tostring(GetEntityModel(vehicle))]
            if placement then
                seen[vehicle] = true
                if not attached[vehicle] then
                    attachPropToVehicle(vehicle, placement)
                end
            end
        end

        -- Gone, or lost its configuration while we were looking away.
        for vehicle in pairs(attached) do
            if not DoesEntityExist(vehicle) or not seen[vehicle] then
                detachProp(vehicle)
            end
        end

        -- One reclaim, after the FIRST pass only
        --
        --
        if not firstPassDone then
            firstPassDone = true
            reclaimOrphanProps()
        end
    end

    Citizen.CreateThread(function()
        while true do
            Citizen.Wait(LIFECYCLE_INTERVAL_MS)
            instance.tick()
        end
    end)

    return instance
end

return VehicleProp
