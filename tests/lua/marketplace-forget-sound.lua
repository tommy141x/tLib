-- shared/imports/marketplace: `forgetSoundFile`, the sweep that was in five
-- places outside this module and nowhere inside it.
--
-- The duplication: `removeSound` cleared the FLAT tone map and its own comment
-- said "Caller is responsible for any per-model/nested map cleanup". Five call
-- sites took that responsibility with the same eight lines --
--
--   tRadio   radio:removeInstalledSound
--   tRadio   radio:admin:webRemoveSound
--   tRadio   standardTypes sounds.uninstalled
--   tELS     tels:removeInstalledSound
--   tELS     standardTypes sounds.uninstalled
--
-- -- and all five agreed. There was no divergence to resolve, which is the
-- state in which the SIXTH copy, written from one of the other five, quietly
-- leaves a map out. What it costs when that happens is not cosmetic: the NUI
-- builds a download URL per mapping, so one left pointing at a file that is
-- gone 404s instead of falling back to the shipped tone, and the device is
-- silent for that event with nothing in any log.
--
-- The module is pure -- no natives, no resource files -- so this suite needs no
-- host stubs at all. Everything below is the function's own contract.
--
-- ── NEGATIVE CONTROL ───────────────────────────────────────────────────────
--
-- FORGET_CONTROL=1 plants the OLD call shape back: every call drops its
-- `scopedMaps` argument, which is exactly what `removeSound` did before this
-- and exactly what a sixth hand-written copy forgets. Every scoped assertion
-- then has to stop holding, and the suite requires all FIVE to flip. Five of
-- five, not some: an assertion that still holds with the scoped maps unswept is
-- measuring the flat sweep, which was never the thing in doubt.
--
-- It earned its keep during authoring. Two assertions written as flip
-- assertions were refused, and correctly: "an unrelated mapping in the same
-- scope survived" and "an unrelated scope was not emptied" are NEGATIVE
-- properties, and a sweep that never ran satisfies both. They are `must` now.
--
--   bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/marketplace-forget-sound.lua
--   FORGET_CONTROL=1 bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/marketplace-forget-sound.lua   # exits 1
--
-- Run from the tLib resource root.

local CONTROL = os.getenv('FORGET_CONTROL') == '1'

local marketplace = assert(dofile('shared/imports/marketplace/server.lua'),
    'shared/imports/marketplace/server.lua returned nothing')

local failures = {}
local function fail(message)
    failures[#failures + 1] = message
    print('FAIL  ' .. message)
end
local function must(condition, message)
    if not condition then fail(message) end
end

--- A SCOPED-sweep property: required normally, required to be ABSENT under the
--- control, which drops the scoped maps from every call.
local flipped = 0
local function sweepsScoped(condition, message)
    if CONTROL then
        if condition then
            fail('CONTROL: still holds with the scoped maps never handed in, so this check is '
                .. 'not measuring the scoped sweep -- ' .. message)
        else
            flipped = flipped + 1
        end
    elseif not condition then
        fail(message)
    end
end

--- Every call goes through here so the control can strip one argument in one
--- place. Passing it `nil` is not a hypothetical: it is the signature that
--- shipped, and it is what every caller used.
local function scoped(maps)
    if CONTROL then return nil end
    return maps
end

-- ── forgetSoundFile: the flat map ──────────────────────────────────────────

do
    local flat = { HORN = 'horn.wav', YELP = 'yelp.wav', ALSO_HORN = 'horn.wav' }
    local changed = marketplace.forgetSoundFile('horn.wav', flat)
    must(changed == true, 'a sweep that removed two mappings reported no change')
    must(flat.HORN == nil and flat.ALSO_HORN == nil,
        'the flat sweep cleared only the first mapping pointing at the file. Two keys CAN point '
        .. 'at one file -- that is what makes a shared tone shared')
    must(flat.YELP == 'yelp.wav', 'the flat sweep cleared an unrelated mapping')
end

do
    local flat = { HORN = 'horn.wav' }
    must(marketplace.forgetSoundFile('absent.wav', flat) == false,
        'a sweep that matched nothing reported a change, which makes every "did anything '
        .. 'change" caller save on every call')
    must(flat.HORN == 'horn.wav', 'a sweep for an absent file cleared a live mapping')
end

-- Malformed input is refused rather than interpreted. `nil` and `''` both reach
-- here from a net event, and a sweep for `''` would clear every mapping whose
-- value had been cleared to '' rather than removed.
do
    local flat = { HORN = 'horn.wav', BROKEN = '' }
    must(marketplace.forgetSoundFile(nil, flat) == false, 'a nil filename was not refused')
    must(marketplace.forgetSoundFile('', flat) == false, 'an empty filename was not refused')
    must(flat.BROKEN == '', 'a sweep for the empty string cleared an empty mapping')
    must(marketplace.forgetSoundFile(42, flat) == false, 'a non-string filename was not refused')
    must(flat.HORN == 'horn.wav', 'a refused sweep still mutated the map')
end

-- No flat map at all: tELS's per-vehicle maps are swept on their own in one of
-- its paths, and a nil `flatMap` must not be an error.
do
    local byModel = { police = { HORN = 'horn.wav' } }
    must(marketplace.forgetSoundFile('horn.wav', nil, { byModel }) == true,
        'a sweep with no flat map reported no change')
    must(byModel.police == nil, 'a sweep with no flat map did not reach the scoped map')
end

-- ── forgetSoundFile: the scoped maps ───────────────────────────────────────

do
    local flat = { HORN = 'horn.wav' }
    local byModel = {
        police  = { HORN = 'horn.wav', YELP = 'yelp.wav' },
        -- Every key points at the removed file, so this scope is emptied.
        sheriff = { HORN = 'horn.wav' },
        ambulance = { WAIL = 'wail.wav' },
    }

    local changed = marketplace.forgetSoundFile('horn.wav', flat, scoped({ byModel }))
    must(changed == true, 'the sweep reported no change')
    must(flat.HORN == nil, 'the flat map was not swept')

    sweepsScoped(byModel.police ~= nil and byModel.police.HORN == nil,
        'a scoped mapping pointing at the removed file survived. The NUI builds a download URL '
        .. 'per mapping, so that one 404s and the device is silent for that event')
    -- `must`, not a flip assertion, and the CONTROL is what settled that: it is
    -- a NEGATIVE property, so it holds whether or not the sweep ran. Written as
    -- a flip assertion it was refused -- "still holds with the scoped maps never
    -- handed in", which is the whole point of counting the flips.
    must(byModel.police ~= nil and byModel.police.YELP == 'yelp.wav',
        'the scoped sweep cleared an unrelated mapping in the same scope')
    sweepsScoped(byModel.sheriff == nil,
        'a scope left with no keys was kept as an EMPTY table. Every consumer tests these with '
        .. '`next(map)`, and an empty table answers "yes, this model has overrides" -- so the '
        .. 'model stays in the payload and in the panel forever')
    -- Negative again, so `must`; see above.
    must(byModel.ambulance ~= nil and byModel.ambulance.WAIL == 'wail.wav',
        'the scoped sweep emptied an unrelated scope')
end

-- More than one scoped map, because the signature takes a list and nothing else
-- in the tree exercises the second element yet. tRadio has one today
-- (modelToneWavMap) and tELS has one (vehicleToneWavMap); a device with both a
-- per-model and a per-vehicle override is the obvious next shape.
do
    local a = { police = { HORN = 'horn.wav' } }
    local b = { ['police2'] = { HORN = 'horn.wav', WAIL = 'wail.wav' } }
    marketplace.forgetSoundFile('horn.wav', nil, scoped({ a, b }))
    sweepsScoped(a.police == nil, 'the FIRST scoped map in the list was not swept')
    sweepsScoped(b.police2 ~= nil and b.police2.HORN == nil and b.police2.WAIL == 'wail.wav',
        'the SECOND scoped map in the list was not swept -- a list that only ever reads its '
        .. 'first element is indistinguishable from a single-map signature')
end

-- Junk in the list is skipped rather than raising. These maps come off a
-- customer-editable data.json, so a scope whose value is a string is reachable.
do
    local byModel = { police = 'not a map', sheriff = { HORN = 'horn.wav' } }
    local ok, err = pcall(marketplace.forgetSoundFile, 'horn.wav', nil,
        { byModel, 'not a map at all', nil })
    must(ok, 'a malformed scoped map raised instead of being skipped: ' .. tostring(err))
    must(byModel.police == 'not a map',
        'a scope whose value is not a table was rewritten rather than left alone')
end

-- ── removeSound delegates, and still returns the filename ──────────────────

do
    local installed = {
        { filename = 'horn.wav', slug = 'horn' },
        { filename = 'yelp.wav', slug = 'yelp' },
    }
    local flat = { HORN = 'horn.wav', YELP = 'yelp.wav' }
    local byModel = { police = { HORN = 'horn.wav' }, ambulance = { YELP = 'yelp.wav' } }

    local removed = marketplace.removeSound(installed, flat, 'horn', scoped({ byModel }))
    must(removed == 'horn.wav', 'removeSound did not return the filename it removed. Its callers '
        .. 'log that name and evict it from the client runtime')
    must(#installed == 1 and installed[1].slug == 'yelp',
        'removeSound removed the wrong entry, or none')
    must(flat.HORN == nil and flat.YELP == 'yelp.wav', 'removeSound did not sweep the flat map')
    sweepsScoped(byModel.police == nil,
        'removeSound did not sweep the scoped maps it was handed. That argument exists because '
        .. 'FIVE call sites were doing this by hand')
    must(byModel.ambulance ~= nil and byModel.ambulance.YELP == 'yelp.wav',
        'removeSound swept a scope belonging to a different sound')
end

-- A slug that is not installed: nothing is swept, because nothing identifies
-- WHICH file to sweep. Sweeping on a miss is how an uninstall of a slug the
-- server never had would clear a live mapping.
do
    local installed = { { filename = 'horn.wav', slug = 'horn' } }
    local flat = { HORN = 'horn.wav' }
    local byModel = { police = { HORN = 'horn.wav' } }
    must(marketplace.removeSound(installed, flat, 'never-installed', scoped({ byModel })) == nil,
        'removeSound claimed to remove a slug that was not installed')
    must(flat.HORN == 'horn.wav' and byModel.police ~= nil,
        'removeSound swept the maps for a slug it did not find')
end

-- The old three-argument call still means what it meant, because tDetector,
-- tRadar and tlib.soundstore all use it and have no scoped maps.
do
    local installed = { { filename = 'horn.wav', slug = 'horn' } }
    local flat = { HORN = 'horn.wav' }
    must(marketplace.removeSound(installed, flat, 'horn') == 'horn.wav',
        'the three-argument form stopped working')
    must(flat.HORN == nil, 'the three-argument form stopped sweeping the flat map')
end

-- ── Verdict ────────────────────────────────────────────────────────────────

if CONTROL then
    local expected = 5
    if flipped ~= expected or #failures > 0 then
        print(('CONTROL FAILED: %d of %d scoped-sweep assertions flipped with the scoped maps '
            .. 'never handed in.'):format(flipped, expected))
        print('An assertion that still holds is measuring the flat sweep, not the scoped one.')
        os.exit(1)
    end
    print(('CONTROL OK: all %d scoped-sweep assertions flipped with the old call shape planted '
        .. 'back, so the gate above is capable of failing.'):format(expected))
    os.exit(1)
end

if #failures > 0 then
    print(('\n%d assertion(s) failed'):format(#failures))
    os.exit(1)
end

print('marketplace-forget-sound: ok')
