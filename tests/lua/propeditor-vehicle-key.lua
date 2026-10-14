-- The vehicle-key indirection, driven through a real `create()`.
--
-- How a placement is KEYED is the highest-risk parameter in the descriptor,
-- because every candidate answer is a string and every wrong answer indexes a
-- table successfully. A resource that keys by model hash and one that keys by
-- spawn name are using two different namespaces over the same data file; an
-- editor that hardcoded either would read an empty record for every vehicle in
-- the other, offer to place a "new" prop, and then save it under a key nothing
-- else reads. There is no error anywhere in that sequence.
--
-- So this suite asserts the editor never computes a key itself: the same vehicle
-- handle, with two different `vehicleKey` functions, must produce two different
-- keys in the init message AND in the save event. It also re-asserts the
-- model-preservation rule end to end, because the save path is where preserving
-- it actually has to happen.

-- Host stubs
--
-- Deliberately minimal and deliberately inert: Citizen.CreateThread records the
-- body and never runs it, so the per-frame loop and the decor registration do
-- not need a scheduler. Everything the editor calls synchronously is here.

local nuiCallbacks = {}
local nuiMessages = {}
local serverEvents = {}

Citizen = { CreateThread = function() end, Wait = function() end }
function RegisterNUICallback(name, fn) nuiCallbacks[name] = fn end
function SendNUIMessage(msg) nuiMessages[#nuiMessages + 1] = msg end
function TriggerServerEvent(name, ...) serverEvents[#serverEvents + 1] = { name = name, ... } end
function AddEventHandler() end
function GetCurrentResourceName() return 'test_resource' end

tlib = { platform = { setInputMode = function() end, setKeepInputActive = function() end } }
-- The REAL drivenprop, not a stub. The editor asks it which of the two
-- attachment mechanisms a placement needs (`isUnitScale`) and borrows its
-- driver, so a stub here would let the editor take the attached path for a
-- scaled placement and this suite would never notice.
tlib.drivenprop = dofile('shared/imports/drivenprop/shared.lua')

local VEHICLE = 42

function PlayerPedId() return 1 end
function IsPedInAnyVehicle() return true end
function GetVehiclePedIsIn() return VEHICLE end
function GetGameTimer() return 0 end
function DoesEntityExist(e) return e ~= nil and e ~= 0 end
function GetHashKey(s) return #tostring(s) end
function GetGamePool() return {} end
function CreateObject() return 99 end
function DeleteObject() end
function AttachEntityToEntity() end
function DetachEntity() end
function FreezeEntityPosition() end
function IsEntityAttachedToEntity() return false end
function GetEntityModel() return 1234 end
function GetEntityCoords() return { x = 0.0, y = 0.0, z = 0.0 } end
function GetGameplayCamCoord() return { x = 0.0, y = 5.0, z = 2.0 } end
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
function DecorIsRegisteredAsType() return true end
function DecorRegister() end
function DecorSetBool() end
function DecorExistOn() return true end
function DecorGetBool() return true end

local PropEditor = dofile('shared/imports/propeditor/client.lua')

-- Harness

local REGISTERED = { ztr540 = true, kbx2200 = true }

--- Opens the editor once and saves, returning what reached the page and the
--- server. `keyFn` is the only thing that varies between the two runs below.
local function run(prefix, keyFn, store)
    nuiCallbacks, nuiMessages, serverEvents = {}, {}, {}

    local editor = PropEditor.create({
        prefix = prefix,
        decor = prefix .. '_prop',
        saveEvent = prefix .. ':saveVehicleProp',
        removeEvent = prefix .. ':removeVehicleProp',
        vehicleKey = keyFn,
        displayName = function() return 'POLICE' end,
        placements = function() return store end,
        resolvePropModel = function(name)
            if type(name) == 'string' and REGISTERED[name] then return name end
            return 'ztr540'
        end,
        isRegisteredPropModel = function(name)
            return type(name) == 'string' and REGISTERED[name] == true
        end,
        loadPropModel = function() return true end,
    })

    editor.open()
    local init = nuiMessages[1]

    assert(nuiCallbacks[prefix .. ':propEditorSave'], 'the save callback is namespaced by prefix')
    nuiCallbacks[prefix .. ':propEditorSave']({}, function() end)

    local saved
    for _, e in ipairs(serverEvents) do
        if e.name == prefix .. ':saveVehicleProp' then saved = e end
    end
    return { editor = editor, init = init, saved = saved }
end

-- The indirection

local byHash = run('radar', function(veh) return tostring(GetEntityModel(veh)) end, {})
local bySpawnName = run('radio', function() return 'police' end, {})

assert(byHash.init.action == 'radar:propEditorInit', 'the init action carries the prefix')
assert(byHash.init.vehicleModel == '1234', 'a hash-keyed host gets the hash as the key')
assert(bySpawnName.init.vehicleModel == 'police', 'a name-keyed host gets the name as the key')
assert(byHash.init.vehicleModel ~= bySpawnName.init.vehicleModel,
    'the SAME vehicle handle produces two different keys -- the editor is not '
    .. 'computing the key itself')

assert(byHash.saved[1] == '1234', 'the save event is keyed by the descriptor, not by the editor')
assert(bySpawnName.saved[1] == 'police', 'and the other host saves under its own key')
assert(byHash.saved[3] == 'POLICE', 'the display name is passed through untouched')
assert(byHash.saved.name == 'radar:saveVehicleProp', 'the save event name comes from the descriptor')
assert(bySpawnName.saved.name == 'radio:saveVehicleProp', 'not from the prefix alone')

assert(byHash.editor.currentKey() == '', 'the key is cleared once the edit is closed')

-- The key is what is READ, too

local store = { ['police'] = { x = 1.5, y = 2.5, z = 3.5, rx = 10.0, ry = 20.0, rz = 30.0 } }
local hit = run('radio', function() return 'police' end, store)
assert(hit.init.hasExisting == true, 'the existing record was found under the descriptor key')
assert(hit.init.propData.x == 1.5 and hit.init.propData.rz == 30.0,
    'the existing placement is loaded into the editor')

local miss = run('radio', function() return tostring(GetEntityModel(VEHICLE)) end, store)
assert(miss.init.hasExisting == false,
    'the same store read with the wrong key function finds nothing -- this is the '
    .. 'silent failure the parameter exists to prevent')

-- Model preservation, end to end through the save path

local legacy = { ['police'] = { x = 1, y = 2, z = 3, rx = 0, ry = 0, rz = 0 } }
local legacyRun = run('radio', function() return 'police' end, legacy)
assert(legacyRun.saved[2].model == nil,
    'saving a legacy record does not stamp the resolved model onto it')
assert(legacy['police'].model == nil, 'and the stored record was never written to')

local explicit = { ['police'] = { x = 1, y = 2, z = 3, rx = 0, ry = 0, rz = 0, model = 'kbx2200' } }
local explicitRun = run('radio', function() return 'police' end, explicit)
assert(explicitRun.saved[2].model == 'kbx2200', 'an explicit model survives a save')

local retired = { ['police'] = { x = 1, y = 2, z = 3, rx = 0, ry = 0, rz = 0, model = 'gone' } }
local retiredRun = run('radio', function() return 'police' end, retired)
assert(retiredRun.saved[2].model == nil, 'a model the server no longer offers is dropped')

-- Descriptor validation

assert(not pcall(PropEditor.create), 'create requires a descriptor')
assert(not pcall(PropEditor.create, { prefix = 'x' }), 'create requires every string field')
assert(not pcall(PropEditor.create, {
    prefix = 'x', decor = 'x_prop', saveEvent = 'a', removeEvent = 'b',
}), 'create requires vehicleKey and the other callbacks')

print('PASS: prop editor keys placements through the descriptor and preserves the record model')
