-- The in-vehicle prop module: registry, placement store, ownership and the
-- lifecycle pass.
--
-- Every rule in `shared/imports/vehicleprop/client.lua` fails SILENTLY in game
-- when it is got wrong, which is the reason this suite exists at all:
--
--   * an unresolvable prop model spawns nothing, because CreateObject returns 0
--     for a model that is not resident and does not say so;
--   * a case-sensitive registry lookup falls back to the default, so the prop
--     still appears — just the wrong one;
--   * a placement table REPLACED instead of cleared leaves every consumer alias
--     pointing at the previous table, which then looks permanently empty to
--     half the resource;
--   * an ownership test that uses the model hash instead of the decorator
--     deletes another resource's object, and leaks ours the moment the owner
--     changes a model.
--
-- The module is loaded FOR REAL against host stubs, with the REAL
-- `tlib.propeditor` under it, rather than being re-implemented here. A suite
-- that reimplements its subject asserts that two copies agree and notices
-- nothing when the shipped one changes.
--
-- Run via `bun run test:lua`.

local function fail(message) error(message, 2) end

-- ── A fake world ────────────────────────────────────────────────────────────
--
-- Entities are integer handles into `world`. Enough of one that the adoption
-- sweep, the orphan reclaim and the lifecycle pass are all exercised against
-- real table state rather than against constant stubs: `GetGamePool` returning
-- `{}` (which is all the propeditor suites need) would make every one of those
-- three assertions pass vacuously.

local world = {}        -- [handle] = { kind, model, attachedTo, decor, deleted }
local nextHandle = 100

local function spawn(kind, model, attachedTo)
    nextHandle = nextHandle + 1
    world[nextHandle] = { kind = kind, model = model, attachedTo = attachedTo }
    return nextHandle
end

local function pool(kind)
    local out = {}
    for handle, e in pairs(world) do
        if e.kind == kind and not e.deleted then out[#out + 1] = handle end
    end
    table.sort(out)
    return out
end

-- ── Host stubs ──────────────────────────────────────────────────────────────

-- Threads are CAPTURED, then run with a budget. Both long-lived threads in
-- these two modules are `while true do ... Citizen.Wait(n) end`, so a Wait stub
-- that simply returns turns "run the captured threads" into a hang rather than
-- a slow test. The budget makes the N+1'th Wait raise, which unwinds the loop
-- through the pcall in `runThreads` — so a thread runs exactly N iterations and
-- then stops, deterministically.
local threads, timeouts = {}, {}
local waitBudget = nil
local function budgetedWait()
    if not waitBudget then return end
    waitBudget = waitBudget - 1
    if waitBudget < 0 then error('__thread budget exhausted__', 0) end
end
Citizen = {
    CreateThread = function(fn) threads[#threads + 1] = fn end,
    Wait = budgetedWait,
    SetTimeout = function(_, fn) timeouts[#timeouts + 1] = fn end,
}
function CreateThread(fn) threads[#threads + 1] = fn end
Wait = budgetedWait

--- Runs every thread captured so far, each allowed `budget` Waits, and clears
--- the queue.
local function runThreads(budget)
    local pending = threads
    threads = {}
    for _, fn in ipairs(pending) do
        waitBudget = budget
        pcall(fn)
    end
    waitBudget = nil
end

local events = {}
local netEvents = {}
local serverEvents = {}
function AddEventHandler(name, fn) events[name] = fn end
function RegisterNetEvent(name, fn) if fn then netEvents[name] = fn end end
function TriggerServerEvent(name, ...) serverEvents[#serverEvents + 1] = { name = name, ... } end
function TriggerEvent(name, ...) local fn = events[name]; if fn then fn(...) end end
function RegisterNUICallback() end
function SendNUIMessage() end
function GetCurrentResourceName() return 'tTest' end

-- `source` is a real global on a client net event: 65535 means "the server".
-- The receive handler's whole security guard is a comparison against it, so it
-- has to be settable here or that assertion measures nothing.
source = 65535

-- Case-insensitive and collision-free enough that two spawn names do not land
-- on one key. It does NOT have to be joaat: nothing here compares a hash
-- against one produced elsewhere.
function GetHashKey(s)
    local h, lower = 5381, tostring(s):lower()
    for i = 1, #lower do h = (h * 33 + lower:byte(i)) % 2147483647 end
    return h
end

-- Every model is valid except this one. `loadPropModel` asks IsModelValid
-- before RequestModel, and that branch is the difference between "nothing
-- spawns" and "nothing spawns after a one-second stall".
local INVALID_MODEL = GetHashKey('not_a_model')
function IsModelValid(hash) return hash ~= INVALID_MODEL end
function RequestModel() end
function HasModelLoaded(hash) return hash ~= INVALID_MODEL end
function SetModelAsNoLongerNeeded() end

function DoesEntityExist(e)
    return type(e) == 'number' and world[e] ~= nil and not world[e].deleted
end
function GetEntityModel(e)
    local rec = world[e]
    return rec and GetHashKey(rec.model) or 0
end
function GetEntityAttachedTo(e)
    local rec = world[e]
    return (rec and rec.attachedTo) or 0
end
function IsEntityAttachedToEntity(a, b)
    local rec = world[a]
    return rec ~= nil and rec.attachedTo == b
end
function GetGamePool(kind) return pool(kind) end

local created = {}
function CreateObject(hash, ...)
    for _, name in ipairs({ 'rdx4000', 'arc360', 'rdx8000' }) do
        if GetHashKey(name) == hash then
            local h = spawn('CObject', name, nil)
            created[#created + 1] = h
            return h
        end
    end
    return 0
end
local deleted = {}
function DeleteObject(e)
    if world[e] then world[e].deleted = true end
    deleted[#deleted + 1] = e
end
function AttachEntityToEntity(obj, target)
    if world[obj] then world[obj].attachedTo = target end
end
function DetachEntity(obj)
    if world[obj] then world[obj].attachedTo = nil end
end
function FreezeEntityPosition() end

-- Mutable: the editor refuses to open for a player who is not in a vehicle, so
-- the suppression assertion further down needs a real one to sit in.
local pedVehicle = 0
function PlayerPedId() return 1 end
function IsPedInAnyVehicle() return pedVehicle ~= 0 end
function GetVehiclePedIsIn() return pedVehicle end
function DisableControlAction() end
function DisablePlayerFiring() end
function SetEntityCollision() end
function SetEntityVisible() end
function IsDisabledControlPressed() return false end
function IsDisabledControlJustPressed() return false end
function GetDisabledControlNormal() return 0.0 end
function SetEntityCoords() end
function SetEntityRotation() end
function GetPedBoneCoords() return { x = 0.0, y = 0.0, z = 0.0 } end
function GetGameTimer() return 0 end
function GetEntityCoords() return { x = 0.0, y = 0.0, z = 0.0 } end
function GetGameplayCamCoord() return { x = 0.0, y = 5.0, z = 2.0 } end
function GetDisplayNameFromVehicleModel() return 'police' end
function GetEntityMatrix()
    return { x = 0, y = 1, z = 0 }, { x = 1, y = 0, z = 0 },
           { x = 0, y = 0, z = 1 }, { x = 0, y = 0, z = 0 }
end
function CreateCam() return 7 end
function DoesCamExist(c) return c == 7 end
function DestroyCam() end
function SetCamFov() end
function GetCamFov() return 50.0 end
function SetCamCoord() end
function PointCamAtCoord() end
function RenderScriptCams() end

-- The ownership decorator, as a real per-entity store. A stub that answered
-- `true` for everything (which the propeditor suites can afford) would make the
-- "an object without our mark is somebody else's problem" assertion below pass
-- against code that deleted every object in the pool.
local decorTypes = {}
function DecorIsRegisteredAsType(name) return decorTypes[name] == true end
function DecorRegister(name) decorTypes[name] = true end
function DecorSetBool(e, name, value)
    local rec = world[e]
    if rec then rec.decor = rec.decor or {}; rec.decor[name] = value end
end
function DecorExistOn(e, name)
    local rec = world[e]
    return rec ~= nil and rec.decor ~= nil and rec.decor[name] ~= nil
end
function DecorGetBool(e, name)
    local rec = world[e]
    return rec ~= nil and rec.decor ~= nil and rec.decor[name] == true
end

tlib = {
    platform = { setInputMode = function() end, setKeepInputActive = function() end },
}
tlib.propeditor = dofile('shared/imports/propeditor/client.lua')

local VehicleProp = dofile('shared/imports/vehicleprop/shared.lua')

-- ════════════════════════════════════════════════════════════════════════════
--  THE PURE RULES
-- ════════════════════════════════════════════════════════════════════════════

-- ── Archetype names that reach a native ─────────────────────────────────────
--
-- An archetype name goes to GetHashKey and then to CreateObject. A path
-- separator in one is never legitimate.
for _, junk in ipairs({ '../../etc/passwd', 'a/b', 'a\\b', 'a.ydr', '', string.rep('x', 129), 17, nil, {} }) do
    if VehicleProp.normaliseModelName(junk) ~= nil then
        fail('a junk archetype name was accepted: ' .. tostring(junk))
    end
end
if VehicleProp.normaliseModelName('  rdx4000  ') ~= 'rdx4000' then
    fail('surrounding whitespace was not trimmed off an archetype name')
end

-- ── The registry ────────────────────────────────────────────────────────────

local list, index, default = VehicleProp.buildRegistry('rdx4000', nil)
if #list ~= 1 or list[1].model ~= 'rdx4000' or default ~= 'rdx4000' then
    fail('an absent config block did not produce the built-in registry alone')
end
if list[1].label ~= 'rdx4000' then
    fail('a model with no label did not fall back to its own name')
end
if index['rdx4000'] ~= list[1] then fail('the index does not point at the list entry') end

-- The built-in is always FIRST, whether or not the owner listed it, and the
-- owner's label for it wins over the placeholder it is seeded with. The shipped
-- config.lua of both consumers lists the built-in itself, as
-- 'RDX-4000 (built in)', so this is the common path and not an edge case.
list, index, default = VehicleProp.buildRegistry('rdx4000', {
    default = 'arc360',
    models = {
        { model = 'arc360',  label = 'ARC-360' },
        { model = 'rdx4000', label = 'RDX-4000 (built in)' },
        { model = 'rdx8000' },
    },
})
if list[1].model ~= 'rdx4000' then
    fail('the built-in is not first in the registry: ' .. tostring(list[1].model))
end
if list[1].label ~= 'RDX-4000 (built in)' then
    fail("the owner's label for the built-in was discarded by de-duplication: "
        .. tostring(list[1].label))
end
if #list ~= 3 then fail('expected the built-in plus two models, got ' .. #list) end
if default ~= 'arc360' then fail('the configured default was not adopted: ' .. tostring(default)) end

-- A default naming a model the owner forgot to add. The built-in is the only
-- safe answer: a default that cannot be spawned is worse than no default.
local _, _, ghostDefault = VehicleProp.buildRegistry('rdx4000', {
    default = 'ghost', models = { { model = 'arc360' } },
})
if ghostDefault ~= 'rdx4000' then
    fail('a default naming an unlisted model did not fall back to the built-in: '
        .. tostring(ghostDefault))
end

-- Junk is rejected rather than registered.
local junkList = VehicleProp.buildRegistry('rdx4000', {
    models = {
        { model = '../../etc/passwd' }, { model = 'a/b' }, { model = '' },
        { model = string.rep('x', 129) }, { model = 17 }, 'not a table',
    },
})
if #junkList ~= 1 then
    fail('junk model names were registered: ' .. #junkList .. ' entries survived')
end

-- ── clearInPlace is the alias contract ──────────────────────────────────────
--
-- Consumers do `tdetAttachedProps = props.attached` and other files in the
-- resource index that alias. If anything in this module ever reassigns instead
-- of clearing, the alias silently stops tracking.
local aliased = { a = 1 }
local alias = aliased
VehicleProp.clearInPlace(aliased)
if alias ~= aliased then fail('clearInPlace replaced the table instead of emptying it') end
if next(alias) ~= nil then fail('clearInPlace left entries behind') end

-- ── Placements are filtered, not trusted ────────────────────────────────────
--
-- data.json is a SHARED document: a server-side bug that handed the whole thing
-- over instead of the `props` section would otherwise have the lifecycle thread
-- trying to attach a prop to a vehicle model called "installedSounds".
local target = {}
VehicleProp.replacePlacements(target, {
    ['123'] = { x = 1.0, y = 2.0, z = 3.0 },
    installedSounds = { { filename = 'ka_band.wav' } },
    soundWavMap = { BLIP = 'blip.wav' },
    ['456'] = 'not a table',
})
if target['123'] == nil then fail('a real placement was filtered out') end
if target.installedSounds ~= nil or target.soundWavMap ~= nil or target['456'] ~= nil then
    fail('a non-placement section survived the filter')
end
VehicleProp.replacePlacements(target, nil)
if next(target) ~= nil then fail('a nil payload did not clear the placements') end

-- ════════════════════════════════════════════════════════════════════════════
--  THE INSTANCE
-- ════════════════════════════════════════════════════════════════════════════

local notifications = {}
local gizmoSeen = {}

local props = VehicleProp.create({
    prefix       = 'ttest',
    model        = 'rdx4000',
    decor        = 'tTest_prop',
    saveEvent    = 'ttest:saveVehicleProp',
    removeEvent  = 'ttest:removeVehicleProp',
    receiveEvent = 'ttest:receiveVehicleProps',
    requestEvent = 'ttest:requestVehicleProps',
    registry     = {
        default = 'rdx4000',
        models  = { { model = 'rdx4000', label = 'RDX-4000 (built in)' } },
    },
    canEdit       = function() return true end,
    notify        = function(m) notifications[#notifications + 1] = m end,
    translate     = function() return nil end,
    onGizmoChange = function(active, prop) gizmoSeen = { active = active, prop = prop } end,
})

-- Three threads were captured by `create`: the decor registration (no Wait),
-- the start-up placement request (one Wait, then the ask), and the lifecycle
-- loop. A budget of one lets the first two finish and stops the third after a
-- single pass — which is harmless here because nothing is configured yet.
runThreads(1)

-- Without this every DecorSetBool is a no-op and the ownership assertions below
-- would be measuring an unregistered decorator rather than the real mark.
if not decorTypes['tTest_prop'] then
    fail('the ownership decorator was never registered')
end

-- The start-up ask. The server also greets joining players, so this is the
-- resource-restart path rather than the join path.
local asked = false
for _, e in ipairs(serverEvents) do
    if e.name == 'ttest:requestVehicleProps' then asked = true end
end
if not asked then fail('the start-up placement request was never sent') end

-- ── Registry, through the instance ──────────────────────────────────────────

if props.PROP_MODEL ~= 'rdx4000' then fail('the built-in model is not exposed') end
if props.defaultModel() ~= 'rdx4000' then
    fail('the shipped registry does not default to the built-in: ' .. tostring(props.defaultModel()))
end
if #props.models ~= 1 or props.models[1].label ~= 'RDX-4000 (built in)' then
    fail('the initial registry was not built from descriptor.registry')
end

-- `models` is a STABLE table: a consumer hands it to a settings UI once.
local modelsAlias = props.models
props.setRegistry({
    default = 'arc360',
    models = { { model = 'arc360', label = 'ARC-360' }, { model = 'rdx8000' } },
})
if modelsAlias ~= props.models then
    fail('setRegistry replaced the models table instead of refilling it')
end
if #props.models ~= 3 then
    fail('expected the built-in plus two models, got ' .. #props.models)
end

-- Case insensitivity, asserted against a NON-DEFAULT model, deliberately. If it
-- were asserted against the default, a case-sensitive lookup would miss it and
-- fall back to... the default, and the assertion would pass while measuring
-- nothing. That is the exact shape of a gate that proves nothing.
if props.defaultModel() == 'rdx8000' then
    fail('precondition broken: rdx8000 must not be the default, or this test is vacuous')
end
if props.resolveModel('RDX8000') ~= 'rdx8000' then
    fail('model resolution is case-sensitive; a differently-cased record fell back to the default')
end
if not props.isRegisteredModel('RdX8000') then fail('registry membership is case-sensitive') end
if props.resolveModel('no_such_model') ~= 'arc360' then
    fail('an unregistered model did not fall back to the default')
end
if props.resolveModel(nil) ~= 'arc360' then
    fail('a record with no model did not resolve to the default')
end
if props.resolveModel(42) ~= 'arc360' then
    fail('a non-string model did not fall back to the default')
end
if props.isRegisteredModel('no_such_model') then
    fail('an unregistered model was reported as registered')
end

-- ── loadPropModel refuses an invalid archetype ──────────────────────────────
--
-- The IsModelValid gate. Without it the caller stalls for a second on a model
-- that can never stream, once per lifecycle pass, forever.
props.setRegistry({ default = 'not_a_model', models = { { model = 'not_a_model' } } })
if props.loadPropModel('not_a_model') ~= false then
    fail('loadPropModel accepted an archetype IsModelValid rejects')
end
props.setRegistry({
    default = 'rdx4000',
    models = { { model = 'arc360' }, { model = 'rdx8000' } },
})

-- ── The receive event is server-only ────────────────────────────────────────
--
-- This decides which archetype gets streamed in and attached, so a local
-- TriggerEvent from a cheat menu could otherwise name any model it liked.
local receive = netEvents['ttest:receiveVehicleProps']
if type(receive) ~= 'function' then fail('the receive net event was not registered') end

local placementsAlias = props.placements
source = 1
receive({ ['999'] = { x = 9.0 } })
if next(props.placements) ~= nil then
    fail('a placement payload from a client was accepted')
end

source = 65535
local POLICE = spawn('CVehicle', 'police')
local POLICE_KEY = tostring(GetEntityModel(POLICE))
receive({ [POLICE_KEY] = { x = 0.1, y = 0.2, z = 0.3 } })
if placementsAlias ~= props.placements then
    fail('the receive handler replaced the placements table instead of refilling it')
end
if props.placements[POLICE_KEY] == nil then fail('a server placement was not stored') end

-- ── getPlacement is a COPY with the model resolved ──────────────────────────
--
-- Writing the resolved name back into the live record would give every record
-- that never had a `model` key one, and the editor saves whatever it finds
-- there — so merely READING the data would quietly rewrite data.json.
local view = props.getPlacement(POLICE)
if view == nil then fail('getPlacement did not find the stored placement') end
if view.model ~= 'rdx4000' then
    fail('getPlacement did not resolve the model: ' .. tostring(view.model))
end
if props.placements[POLICE_KEY].model ~= nil then
    fail('getPlacement wrote the resolved model back into the live record')
end
if props.getPlacement(999999) ~= nil then
    fail('getPlacement answered for a vehicle that does not exist')
end

-- ════════════════════════════════════════════════════════════════════════════
--  THE LIFECYCLE PASS
-- ════════════════════════════════════════════════════════════════════════════

local attachedAlias = props.attached

props.tick()
local prop = props.attached[POLICE]
if prop == nil then fail('the lifecycle pass did not attach a prop to a configured vehicle') end
if world[prop].attachedTo ~= POLICE then fail('the prop was created but not attached') end
if world[prop].model ~= 'rdx4000' then
    fail('the wrong model was spawned: ' .. tostring(world[prop].model))
end
if not props.isOwnedProp(prop) then fail('the spawned prop was not marked as ours') end
if props.getAttached(POLICE) ~= prop then fail('getAttached did not answer with the live prop') end

-- Idempotent: a second pass must not bolt a second device to the same car.
props.tick()
if props.attached[POLICE] ~= prop then fail('a second pass replaced the attached prop') end

-- ── Adoption across an unclean restart ──────────────────────────────────────
--
-- The tracking table is gone but the object is still on the windshield. It
-- carries our mark, so it is re-adopted rather than duplicated.
props.attached[POLICE] = nil
props.tick()
if props.attached[POLICE] ~= prop then
    fail('a prop of ours already on the vehicle was not re-adopted; a second one was spawned')
end

-- ── A prop of ours whose model is no longer the configured one ──────────────
--
-- A leftover from before the owner changed the model for this vehicle. It has
-- to go, or the vehicle silently ends up wearing two devices.
props.placements[POLICE_KEY].model = 'arc360'
props.attached[POLICE] = nil
props.tick()
local replacement = props.attached[POLICE]
if replacement == nil then fail('no prop was attached after the model changed') end
if replacement == prop then fail('the stale-model prop was adopted instead of replaced') end
if not world[prop].deleted then fail('the stale-model prop was left on the vehicle') end
if world[replacement].model ~= 'arc360' then
    fail('the new prop is not the newly configured model: ' .. tostring(world[replacement].model))
end

-- ── An object we did not mark is somebody else's problem ────────────────────
--
-- Ownership is the decorator and nothing else: not the model hash, not "it is
-- attached to a vehicle". A model filter reads as a cheap prefilter while there
-- is one prop model and becomes a leak the moment there are two.
local FOREIGN = spawn('CObject', 'arc360', POLICE)
props.reclaimOrphans()
if world[FOREIGN].deleted then
    fail("another resource's object was deleted by the orphan reclaim")
end
if world[replacement].deleted then
    fail('a tracked prop was deleted by the orphan reclaim')
end

-- An orphan of OURS, with no tracking entry, is collected.
local ORPHAN = props.markOwnedProp(spawn('CObject', 'rdx4000', nil))
props.reclaimOrphans()
if not world[ORPHAN].deleted then fail('an orphan carrying our mark was not collected') end

-- ── The vehicle goes away ───────────────────────────────────────────────────
world[POLICE].deleted = true
props.tick()
if props.attached[POLICE] ~= nil then
    fail('the tracking entry survived its vehicle')
end
if not world[replacement].deleted then fail('the prop survived its vehicle') end

-- Still true with NO placements configured at all: a server that removes its
-- last placement must not leak the tracking table forever.
local GHOST = spawn('CVehicle', 'police2')
props.attached[GHOST] = spawn('CObject', 'rdx4000', GHOST)
world[GHOST].deleted = true
props.setPlacements(nil)
props.tick()
if props.attached[GHOST] ~= nil then
    fail('with no placements configured, a dead vehicle kept its tracking entry')
end

-- ── Suppressed while the editor holds a prop ────────────────────────────────
--
-- Otherwise the thread attaches a second prop to the vehicle being edited, or
-- detaches the one the editor is moving on the pass after the editor took it
-- off the tracking table.
local EDITED = spawn('CVehicle', 'police3')
props.setPlacements({ [tostring(GetEntityModel(EDITED))] = { x = 0.0, y = 0.0, z = 0.0, rx = 0.0, ry = 0.0, rz = 0.0 } })
pedVehicle = EDITED
props.editor.open()
if not props.isGizmoActive() then fail('the editor did not report itself active') end
if gizmoSeen.active ~= true then fail('onGizmoChange was not told the editor opened') end
props.tick()
if props.attached[EDITED] ~= nil then
    fail('the lifecycle pass ran while the editor held a prop')
end

-- ── cleanupAll ──────────────────────────────────────────────────────────────
--
-- Including the editor's working prop, which reclaimOrphanProps deliberately
-- skips — without the explicit delete it is the one object that survives a
-- resource stop.
local editorProp = props.gizmoProp()
props.cleanupAll()
if attachedAlias ~= props.attached then
    fail('cleanupAll replaced the attached table instead of emptying it')
end
if next(props.attached) ~= nil then fail('cleanupAll left tracking entries behind') end
if props.isGizmoActive() then fail('cleanupAll left the gizmo flag raised') end
if editorProp and not world[editorProp].deleted then
    fail("cleanupAll left the editor's working prop in the world")
end
if world[FOREIGN].deleted then
    fail("cleanupAll deleted another resource's object")
end

-- ── onResourceStop only fires for US ────────────────────────────────────────
local SURVIVOR = spawn('CVehicle', 'police4')
props.setPlacements({ [tostring(GetEntityModel(SURVIVOR))] = { x = 0.0, y = 0.0, z = 0.0 } })
props.tick()
local survivorProp = props.attached[SURVIVOR]
if survivorProp == nil then fail('precondition broken: nothing to survive the foreign stop') end
TriggerEvent('onResourceStop', 'some_other_resource')
if props.attached[SURVIVOR] ~= survivorProp then
    fail("another resource stopping tore down this resource's props")
end
TriggerEvent('onResourceStop', 'tTest')
if next(props.attached) ~= nil then fail('onResourceStop did not clean up') end

print('PASS vehicleprop')
