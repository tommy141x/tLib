-- The model-preservation rule, both shapes of it.
--
-- This is a DATA-LOSS oracle, not a style one. Two resources independently grew
-- the same trap and guarded it in two different places, which is why the shared
-- editor has to hold both guards at once:
--
--   * tRadio guarded it on the WRITE side (`gizmoSavedModel`): the editor saves
--     the model that was already in the record, never the model it resolved, or
--     a position nudge stamps "ztr540" onto every legacy record and that record
--     stops following the server's configured default for good.
--
--   * tRadar guarded it on the READ side (`tradarGetPropPlacement` returns a
--     shallow copy): a convenience reader that fills in the resolved model must
--     not hand back the live record, or merely READING a placement rewrites it
--     in memory and the next save persists the rewrite.
--
-- Neither guard is sufficient alone, and the composition test at the bottom is
-- the one that says so.

local PropEditor = dofile('shared/imports/propeditor/client.lua')

local REGISTERED = { ztr540 = true, kbx2200 = true }
local DEFAULT = 'ztr540'

local function isRegistered(name)
    return type(name) == 'string' and REGISTERED[name:lower()] == true
end

local function resolve(name)
    if isRegistered(name) then return name end
    return DEFAULT
end

-- savedModelFor: the WRITE guard

assert(PropEditor.savedModelFor(nil, isRegistered) == nil,
    'a brand new placement has no model to preserve')

assert(PropEditor.savedModelFor({ x = 1 }, isRegistered) == nil,
    'a legacy record with no model field stays without one -- this is the bug: '
    .. 'resolvePropModel would answer "ztr540" here and writing it back pins the '
    .. 'record away from the server default forever')

assert(PropEditor.savedModelFor({ x = 1, model = 'kbx2200' }, isRegistered) == 'kbx2200',
    'an explicit registered model is kept exactly as found')

assert(PropEditor.savedModelFor({ x = 1, model = 'retired_model' }, isRegistered) == nil,
    'a model the server no longer offers is dropped rather than kept -- keeping '
    .. 'it would pin the record to something that cannot be spawned')

assert(PropEditor.savedModelFor({ x = 1, model = 12345 }, isRegistered) == nil,
    'a non-string model is not a model')

-- The whole point, stated as the comparison that matters: the preserved value
-- and the resolved value are different objects and must never be conflated.
local legacy = { x = 1, y = 2, z = 3 }
assert(resolve(legacy.model) == DEFAULT, 'sanity: resolution does answer for a legacy record')
assert(PropEditor.savedModelFor(legacy, isRegistered) ~= resolve(legacy.model),
    'preservation and resolution must disagree on a legacy record; if they ever '
    .. 'agree here the guard has been inlined away')

-- placementView: the READ guard

local record = { x = 1.5, y = 2.5, z = 3.5, rx = 0.0, ry = 0.0, rz = 0.0 }
local view = PropEditor.placementView(record, resolve)

assert(view ~= record, 'placementView returns a copy, never the live record')
assert(view.model == DEFAULT, 'the view carries the model that will actually be spawned')
assert(record.model == nil,
    'READING a placement must not write to it -- this is how data.json was being '
    .. 'rewritten by a getter')
assert(view.x == 1.5 and view.rz == 0.0, 'every other field is carried across')

view.x = 999
assert(record.x == 1.5, 'mutating the view does not reach the record')

assert(PropEditor.placementView(nil, resolve) == nil, 'no record, no view')

-- The composition: read, then save
--
-- A consumer that reads a placement through placementView and then saves it must
-- still write nil. If placementView returned the live record this would come back
-- as "ztr540"; if savedModelFor resolved instead of preserving, so would it.

local stored = { x = 1, y = 2, z = 3, rx = 0, ry = 0, rz = 0 }
local _ = PropEditor.placementView(stored, resolve)
assert(PropEditor.savedModelFor(stored, isRegistered) == nil,
    'reading a legacy placement and then saving it leaves it legacy')

print('PASS: prop editor preserves a placement\'s model on both the read and the write side')
