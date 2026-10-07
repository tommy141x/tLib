--[[
    tLib — the in-vehicle prop: model registry, placement store and lifecycle

    Loaded into the CONSUMER's VM, like every other module under
    shared/imports/: `tlib.vehicleprop`. It has to run there rather than inside
    tLib's own VM because it creates objects the consumer's own files look at
    (a DUI screen renderer asks "is there a prop on this vehicle?"), and because
    it instantiates `tlib.propeditor`, which registers NUI callbacks against the
    consumer's `ui_page`.

        local props = tlib.vehicleprop.create({ ... descriptor ... })

    `shared.lua` rather than `client.lua` because the PURE RULES below are asked
    on both sides. The client builds the registry to decide what to SPAWN; the
    server builds the same registry to decide what a save is allowed to STORE.
    Those are two different questions over the same table, which is why both
    halves exist — but there is no reason for two implementations of the table
    itself, and the three that existed had already drifted (the server's
    validity check did not trim whitespace before measuring the name).
    `create` is client-only in practice; defining it on the server costs
    nothing, because every native it touches is reached at call time.

    ── Why this exists ─────────────────────────────────────────────────────────

    tDetector's and tRadar's `client/cl_props.lua` were both exactly 591 lines.
    Normalising only the identifier prefix, the built-in model name and the
    device noun left 80 differing lines, and EVERY ONE of them was comment prose
    or whitespace: the two files had no behavioural difference at all. tRadio's
    is the same skeleton with heavier edits; it is the file that solved this
    first and the ownership rule below is lifted from it.

    Everything that is actually a particular resource arrives in the descriptor:
    the identifier prefix, the built-in model, the decorator, the two net event
    names, the notify label and the one error string. Those were the only real
    inputs; they were already fields in the table the duplicated files built.

    ── The reasoning, which is the part that is expensive to rediscover ────────

    Four rules are implemented here rather than restated in each consumer. Each
    one fails SILENTLY in game when it is got wrong, which is why they are
    written down at the point they are enforced:

      * CASE INSENSITIVITY. `GetHashKey` routes through the lowercasing
        `HashString`, so a record saved as "RDX4000" and a config entry spelled
        "rdx4000" name the SAME archetype and must resolve to each other.
        Comparing the strings raw treats them as two models, one of which is not
        registered — and the prop silently comes out as the default.

      * THE BUILT-IN IS ALWAYS PRESENT, AND ALWAYS FIRST, and the default always
        names a model that is in the registry. A fallback is only worth anything
        if the thing it falls back to can actually be spawned.

      * OWNERSHIP IS THE DECORATOR AND NOTHING ELSE — not the model hash, not a
        distance, not "it is attached to a vehicle". See the mark's own comment
        in `tlib.propeditor`, whose instance this module reuses rather than
        keeping a second one that could disagree.

      * THE PLACEMENT TABLES ARE CLEARED IN PLACE, NEVER REPLACED. Consumers
        alias them (`tdetAttachedProps = props.attached`) and other files in the
        resource index the alias. Reassigning `attached = {}` on cleanup would
        leave every alias pointing at the previous table, which then looks
        permanently empty to half the resource and permanently full to the
        other half. `clearInPlace` below is the whole of that guarantee.

    ── Not owned here ──────────────────────────────────────────────────────────

    The DUI screen that renders on the prop, the HUD, and anything that reads a
    placement to draw something are the consumer's. This module answers "which
    prop is on this vehicle, and where" and nothing further.
]]

local VehicleProp = {}

-- ══════════════════════════════════════════════════════════════════════════
--  PURE RULES — no natives, no state. tests/lua/vehicleprop.lua drives these
--  directly, which is possible only because they take no globals.
-- ══════════════════════════════════════════════════════════════════════════

--- Is `model` a plausible archetype name?
---
--- An archetype name is one of the few strings out of a config file that
--- reaches a native: it goes to `GetHashKey` and then to `CreateObject`. A path
--- separator in one is never legitimate, and neither is an empty or absurdly
--- long string. The server applies the same shape check to a vehicle model name.
---
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
--- Built wholesale rather than merged into whatever was there before: a model
--- the owner deleted from config has to stop being offered, and a merge would
--- keep it forever.
---
--- An ABSENT block is the common case, not an error. It means "the built-in,
--- alone".
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

        -- The built-in is seeded FIRST so it is always offered and always
        -- first, which means an owner who also lists it — and the config.lua
        -- these resources ship does exactly that, as 'RDX-4000 (built in)' —
        -- would otherwise have their label thrown away by the de-duplication.
        -- A real label replaces a placeholder one (a label that is only the
        -- model name); a second real label does not win.
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
--- placements.
---
--- Filtered on `x ~= nil` rather than trusted wholesale. `data.json` is a shared
--- file with other sections in it (`soundWavMap`, `installedSounds`), and a bug
--- on the server side that handed the whole document over instead of the
--- `props` section would otherwise have the lifecycle thread trying to attach a
--- prop to a vehicle model called "installedSounds".
---
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

-- ══════════════════════════════════════════════════════════════════════════
--  THE INSTANCE
-- ══════════════════════════════════════════════════════════════════════════

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

    -- ── Registry ─────────────────────────────────────────────────────────
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
    --- the registry's own spelling.
    ---
    --- Everything unresolvable lands on the default, deliberately. There are
    --- three ways to get here with something that is not a registered model and
    --- all three are ordinary rather than exceptional:
    ---   * nil — every record written before a record could name a model
    ---   * a model the owner has since removed from the config block
    ---   * a typo, or a model whose streaming resource is not running
    --- Spawning NOTHING for those would not read as "misconfigured", it would
    --- read as the device disappearing: CreateObject returns 0 for a model that
    --- is not resident, and it does it silently.
    function instance.resolveModel(name)
        local entry = type(name) == 'string' and index[name:lower()] or nil
        if entry then return entry.model end
        return defaultModel
    end

    function instance.defaultModel() return defaultModel end

    instance.PROP_MODEL = BUILTIN
    instance.models = models

    instance.setRegistry(d.registry)

    -- ── Placement store ──────────────────────────────────────────────────
    --
    --   placements[<vehicle model hash as a string>] = { x, y, z, rx, ry, rz, model? }
    --
    -- Keyed by the hash rather than by the spawn name because that is what
    -- GetEntityModel answers with, and it is the one identifier a client can
    -- get off a vehicle without a lookup table of every archetype on the server.
    --
    -- Two sources, merged by the server before it sends this: the owner's seeds
    -- in config, and the `props` section of data.json that the editor writes.
    -- The server resolves the precedence, so there is exactly one place that
    -- decision is made.
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

    --- The saved placement for a vehicle, or nil.
    ---
    --- `model` is always filled in with the model that will actually be
    --- spawned, so a caller never has to know the resolution rules. It is a
    --- SHALLOW COPY, not the live record: writing the resolved name back would
    --- give every record that never had a `model` key one, and the editor saves
    --- whatever it finds there — so merely READING the data would quietly
    --- rewrite data.json. `tlib.propeditor.placementView` is the one
    --- implementation of that copy.
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

    -- ── Gizmo state, shared with the prop editor ─────────────────────────
    --
    -- Written by `tlib.propeditor` (through `onStateChange` below) while it has
    -- hold of a prop; nothing else writes them. Both guards below are written
    -- `if not gizmoActive` and `obj ~= gizmoProp`, which are correct against nil
    -- as well as false — the editor never having been opened is the normal
    -- case, not an error case.
    local gizmoActive = false
    local gizmoProp = nil
    local onGizmoChange = d.onGizmoChange

    function instance.isGizmoActive() return gizmoActive end
    function instance.gizmoProp() return gizmoProp end

    -- ── Model streaming ──────────────────────────────────────────────────

    --- Blocks until the model is loaded, or gives up after ~1s.
    ---
    --- Declared above the editor because the descriptor takes it BY VALUE:
    --- `tlib.propeditor.create` asserts it is a function at call time, and a
    --- forward local would still be nil there.
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

    -- ── The editor, and the ownership mark that comes with it ────────────
    --
    -- Created here rather than by the consumer because the editor and the
    -- lifecycle share one prop: takeProp/giveProp are the handover, and the
    -- ownership mark is the editor instance's — so there is exactly one
    -- implementation of it rather than two that can disagree.
    local editor = tlib.propeditor.create({
        prefix      = d.prefix,
        decor       = d.decor,
        saveEvent   = d.saveEvent,
        removeEvent = d.removeEvent,
        fov         = d.fov,

        -- Placements are keyed by model HASH as a string, the same key
        -- `getPlacement` and the lifecycle thread index by. Both are strings
        -- and both index `placements`, so keying by the other one would
        -- silently write every record into a namespace nothing reads.
        vehicleKey  = function(vehicle) return tostring(GetEntityModel(vehicle)) end,
        displayName = d.displayName,
        placements  = function() return placements end,

        -- THE MODEL-PRESERVATION RULE lives in these two. The editor asks
        -- rather than deciding: it keeps a record's own `model` field exactly
        -- as it found it (nil on the legacy records, which is all of them) and
        -- resolves separately for what to spawn. A second copy of the
        -- resolution rules in the editor could disagree with what the lifecycle
        -- thread actually attaches.
        resolvePropModel      = instance.resolveModel,
        isRegisteredPropModel = instance.isRegisteredModel,
        loadPropModel         = loadPropModel,

        canEdit   = d.canEdit,
        notify    = d.notify,
        translate = d.translate,

        -- The handover. The editor borrows the vehicle's prop for the duration
        -- of an edit and gives it back on save/cancel; a stale handle is left
        -- alone so the editor falls through to its own pool sweep.
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

    -- ── Attach / detach ──────────────────────────────────────────────────

    --- Attaches the device to a vehicle using its saved placement.
    --- Yields while the model streams, so it is only ever called from the
    --- lifecycle thread below.
    local function attachPropToVehicle(vehicle, placement)
        if attached[vehicle] then return end

        local modelName = instance.resolveModel(placement and placement.model)
        local propHash  = GetHashKey(modelName)

        -- Re-adopt a prop of OURS this vehicle is already wearing: the tracking
        -- table went out of sync, which across an unclean restart it always
        -- has. Requires our own mark, because adopting on model + attachment
        -- alone would make us the owner of another resource's object and we
        -- delete what we own.
        --
        -- A prop of ours on this vehicle whose model is NOT the one we are
        -- about to spawn is a leftover from before the owner changed the model
        -- for this vehicle. It has to go, or the vehicle silently ends up
        -- wearing two devices: adoption rejects it on the model test, and
        -- nothing else would ever look at it again because it is not in
        -- `attached`.
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

        -- ⚠️ TWO MECHANISMS, CHOSEN BY THE SCALE. See the long note on
        -- `reattach` in tlib.propeditor: `AttachEntityToEntity` cannot carry a
        -- scale, because the attach recomputation rewrites the basis from the
        -- parent's matrix every frame and has no notion of one. A same-tick read
        -- says 3.0 and the next frame says 1.0.
        --
        -- A prop at UNIT SCALE stays attached, which is free and is what every
        -- placement on every server does today — none of them has a `scale` key.
        -- The per-frame cost of the driven path (~0.8 µs per prop, measured) is
        -- paid only by the placements that actually ask for a scale.
        if tlib.drivenprop.isUnitScale(placement.scale) then
            AttachEntityToEntity(
                prop, vehicle, 0,
                placement.x  or 0.0, placement.y  or 0.0, placement.z  or 0.0,
                placement.rx or 0.0, placement.ry or 0.0, placement.rz or 0.0,
                false, false, false, false, 0, true
            )
        else
            -- The EDITOR'S driver, deliberately, not one of our own. The editor
            -- and this lifecycle hand one prop back and forth through
            -- takeProp/giveProp, and two drivers would both think they owned its
            -- matrix.
            editor.driver.add(prop, vehicle, {
                x  = placement.x  or 0.0, y  = placement.y  or 0.0, z  = placement.z  or 0.0,
                rx = placement.rx or 0.0, ry = placement.ry or 0.0, rz = placement.rz or 0.0,
                scale = placement.scale,
            })
        end

        attached[vehicle] = prop
        SetModelAsNoLongerNeeded(propHash)
    end

    --- Deletes the prop attached to a vehicle and clears the tracking entry.
    ---
    --- Deletes the TRACKED HANDLE and nothing else. In particular it does not
    --- sweep nearby objects of the same model, which is the obvious-looking
    --- resync fallback and is wrong twice over: proximity is not ownership, so
    --- two equipped cars parked near each other would have one player leaving
    --- delete the prop off BOTH; and when this is called for a vehicle that no
    --- longer exists — which the lifecycle thread does on every pass —
    --- GetEntityCoords on the dead handle returns the world origin, so the
    --- sweep would run there instead. Out-of-sync entries are recovered by
    --- adoption, keyed off our own mark.
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

    --- Deletes props WE created that no longer have a tracking entry.
    ---
    --- The narrow recovery policy. Ownership is the decorator and nothing else:
    --- not the model hash, not a distance, and not the fact that the object is
    --- attached to a vehicle. An object without our mark is somebody else's
    --- problem even if it is one of our models bolted to a windshield.
    ---
    --- Callers must hold `gizmoActive == false`. Mid-edit the editor's prop
    --- carries our mark but is deliberately absent from `attached` — it is not
    --- attached to anything yet — so it reads as an orphan and would be deleted
    --- out from under the editor. `gizmoProp` is the second half of that guard,
    --- for the window where a sweep runs before the flag has been raised.
    local function reclaimOrphanProps()
        -- ⚠️ "IS IT IN THE TRACKING TABLE AT ALL", NOT "DOES ITS ATTACHMENT MAP
        -- BACK TO IT". This used to read the object's parent with
        -- `GetEntityAttachedTo(obj)` and test `attached[parent] ~= obj`.
        --
        -- That test is wrong for a SCALED prop, and wrong in the worst
        -- direction: a scaled prop is deliberately NOT attached to anything (see
        -- attachPropToVehicle), so `GetEntityAttachedTo` answers 0, `attached[0]`
        -- is nil, and every scaled prop on the server reads as an orphan and is
        -- deleted on the next sweep. The prop would appear, then vanish, with
        -- nothing logged — and only for the placements that had been given a
        -- scale, which is the hardest possible version to diagnose.
        --
        -- The tracking table is the ownership record either way, so asking it
        -- directly is both correct for both mechanisms and simpler. The one
        -- behaviour this gives up is deleting a prop that IS in `attached` but
        -- attached to a different vehicle than the one it is filed under — a
        -- desync the old test would have cleaned up. Nothing produces that state
        -- (only this file writes the table, and it writes the handle it just
        -- attached), and the next pass's own bookkeeping catches a vehicle that
        -- has gone.
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

        -- The table is empty now, so every remaining object carrying our mark
        -- is an orphan — including any a previous incarnation left behind.
        reclaimOrphanProps()
        -- Nothing is driven once every prop is gone. Belt and braces: the
        -- driver's own pass drops entries for deleted entities, but its thread
        -- does not run again after a resource stop.
        editor.driver.clear()
    end

    --- Drops tracking for props whose vehicle or prop handle has gone away.
    ---
    --- What respawning needs, and deliberately NOT cleanupAll: dying must not
    --- delete the props on every other car in the world, and it must not delete
    --- the prop being edited either. Live vehicles keep their props and the
    --- lifecycle thread reconciles the rest on its next pass.
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

    -- ── Events ───────────────────────────────────────────────────────────

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
        -- Ask once, shortly after start. The server also greets joining
        -- players, so this is the resource-restart path rather than the join
        -- path.
        Citizen.CreateThread(function()
            Citizen.Wait(STARTUP_REQUEST_DELAY_MS)
            TriggerServerEvent(d.requestEvent)
        end)
    end

    -- ── Lifecycle thread ─────────────────────────────────────────────────
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

        -- ── One reclaim, after the FIRST pass only ───────────────────────
        --
        -- For the props an unclean stop left behind that adoption cannot
        -- rescue. Adoption keys off `IsEntityAttachedToEntity`, and a SCALED
        -- prop is deliberately not attached to anything — so a previous
        -- incarnation's scaled props are invisible to it, and the pass above
        -- would spawn a second prop over the top of each one while the
        -- original sat there forever.
        --
        -- ⚠️ AFTER the pass, not before, and that ordering is the whole of why
        -- this is not simply called at startup. Before the first pass
        -- `attached` is empty, so every prop of ours in the world reads as an
        -- orphan — including the attached ones adoption was about to reclaim,
        -- which it would delete and then respawn. Running it after means
        -- adoption has already had its chance and anything still unaccounted
        -- for genuinely is a leftover.
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
