-- The Sounds tab of a settings dialog: the fields it draws, and the refresh
-- that keeps an open one current.
--
-- tDetector and tRadar each had this. The field builder was 86 lines identical
-- in both; the refresh handler was identical in its body. The two hazards the
-- module exists to make un-forgettable are both ordering ones that raise
-- nothing when you get them wrong -- the refresh must key off what was DRAWN
-- rather than off the current config, and it must be a no-op once the dialog is
-- closed -- so this suite asserts them through their observable consequences.
--
-- NEGATIVE CONTROLS are at the bottom. Each re-implements one thing the
-- module does correctly, the wrong way, and the suite asserts the wrong body
-- FAILS the scenario. A scenario the control also passes cannot discriminate
-- and is worth nothing; the control is how that gets noticed.
--
-- Run via `bun run test:lua`.

local realPrint = print

local function fail(message) error(message, 2) end

-- Host stubs

local SoundFields = dofile('shared/imports/soundfields/client.lua')

--- A sound config as the server sends it.
local function config(keys, installed, map)
    return {
        defaultSoundKeys = keys or {},
        installedSounds  = installed or {},
        soundWavMap      = map or {},
    }
end

local function sound(filename) return { filename = filename } end

--- Collects UpdateDialogField calls instead of reaching the export.
local function recorder()
    local calls = {}
    return calls, function(dialogId, fieldId, patch)
        calls[#calls + 1] = { dialog = dialogId, field = fieldId, patch = patch }
    end
end

local function ids(fields)
    local out = {}
    for i, f in ipairs(fields) do out[i] = f.id end
    return out
end

local function optionValues(field)
    local out = {}
    for i, o in ipairs(field.options) do out[i] = o.value end
    return out
end

local function concatTable(t)
    local parts = {}
    for i, v in ipairs(t) do parts[i] = tostring(v) end
    return table.concat(parts, ',')
end

local function sameList(got, want, what)
    if concatTable(got) ~= concatTable(want) then
        fail(('%s: got [%s], wanted [%s]'):format(what, concatTable(got), concatTable(want)))
    end
end

-- Field ids carry the key, and survive a colon in it

if SoundFields.fieldId('siren') ~= 'sound:siren' then fail('fieldId did not prefix the key') end
if SoundFields.keyOf('sound:siren') ~= 'siren' then fail('keyOf did not recover the key') end
-- The key is whatever FOLLOWS the prefix, so a key containing a colon
-- round-trips. A `:`-split implementation gets this wrong and nothing says so.
if SoundFields.keyOf(SoundFields.fieldId('bank:2')) ~= 'bank:2' then
    fail('a sound key containing a colon did not round-trip')
end
-- A dialog's FIXED fields must not be mistaken for ours -- onChange branches on
-- this, so a false positive here writes a sound mapping for `volume`.
if SoundFields.keyOf('volume') ~= nil then fail('a fixed field id was read as a sound key') end
if SoundFields.keyOf('sound:') ~= nil then fail('an empty sound key was accepted') end
if SoundFields.keyOf(nil) ~= nil then fail('a nil field id was accepted') end
if SoundFields.keyOf(42) ~= nil then fail('a non-string field id was accepted') end

-- append: a key per field, sorted, one section heading

SoundFields.clear()
local fields = {}
local drawn = SoundFields.append(fields, {
    config = config({ 'siren', 'airhorn', 'horn' }, { sound('a.wav'), sound('b.wav') },
        { siren = 'a.wav' }),
    noun = 'detector',
})

sameList(drawn, { 'airhorn', 'horn', 'siren' }, 'append did not sort the keys')
sameList(ids(fields), { 'sound:airhorn', 'sound:horn', 'sound:siren' },
    'append drew the wrong fields')

-- One heading, on the FIRST field only: drawn above every row it is noise.
local sections = 0
for _, f in ipairs(fields) do if f.section then sections = sections + 1 end end
if sections ~= 1 then fail('append drew ' .. sections .. ' section headings, wanted 1') end
if not fields[1].section:find('detector events', 1, true) then
    fail('the section heading did not carry the device noun it was given')
end

-- The empty option IS the Clear button; a select cannot express "no value"
-- without an option carrying it.
sameList(optionValues(fields[1]), { '', 'a.wav', 'b.wav' }, 'the empty option is missing')
if fields[3].defaultValue ~= 'a.wav' then fail('a mapped key did not default to its file') end
if fields[1].defaultValue ~= '' then fail('an unmapped key did not default to empty') end
for _, f in ipairs(fields) do
    if f.tab ~= 'sounds' then fail('a field landed outside the sounds tab') end
    if f.type ~= 'dropdown' then fail('a sound field was not a dropdown') end
end

-- A mapping can outlive the file it names
--
-- An admin removes a sound and the key still points at it. Rendered blank the
-- select reads as "unmapped", which is a lie: the server still has the mapping
-- and the layout still tries to play it.

local stale = {}
SoundFields.append(stale, { config = config({ 'siren' }, { sound('a.wav') }, { siren = 'gone.wav' }) })
sameList(optionValues(stale[1]), { '', 'a.wav', 'gone.wav' },
    'a mapping naming a missing file was dropped from the options')
if not stale[1].options[3].label:find('(missing)', 1, true) then
    fail('a missing file was offered without being labelled as the problem it is')
end
if stale[1].defaultValue ~= 'gone.wav' then fail('a stale mapping was silently cleared') end

-- Duplicates in installedSounds, and a malformed entry, must not produce
-- duplicate or nil options -- the server's list is not guaranteed clean.
local dupes = {}
SoundFields.append(dupes, {
    config = config({ 'siren' },
        { sound('a.wav'), sound('a.wav'), { filename = '' }, { filename = 42 }, 'a.wav' }),
})
sameList(optionValues(dupes[1]), { '', 'a.wav' }, 'the options list was not deduplicated')

-- No keys: a disabled control, not an empty tab

local empty = {}
local emptyDrawn = SoundFields.append(empty, { config = config({}) })
if #emptyDrawn ~= 0 then fail('append claimed to draw keys it had none of') end
if #empty ~= 1 or empty[1].id ~= 'soundsEmpty' then
    fail('an empty sound config drew no explanation; the tab reads as a broken menu')
end
if not empty[1].disabled then fail('the empty-state field was editable') end

-- A missing config is the same case, not a crash: the client may open the
-- dialog before the server's sound config has arrived.
local noConfig = {}
SoundFields.append(noConfig, {})
if #noConfig ~= 1 or noConfig[1].id ~= 'soundsEmpty' then
    fail('a dialog opened before the sound config arrived did not degrade to the empty state')
end
if pcall(SoundFields.append, nil, {}) then fail('append accepted a nil field list') end

-- refresh keys off what was DRAWN, not off the config
--
-- A sound key added server-side AFTER the dialog opened has no control to
-- patch. Refreshing from the arriving config instead addresses a field that
-- does not exist -- which UpdateDialogField cannot report, because the dialog
-- is live and the id is well-formed.

SoundFields.clear()
local opened = {}
SoundFields.append(opened, { config = config({ 'siren' }, { sound('a.wav') }) })

local calls, patch = recorder()
local n = SoundFields.refresh('tdet_settings', config({ 'siren', 'added_later' },
    { sound('a.wav'), sound('new.wav') }, { siren = 'new.wav' }), patch)

if n ~= 1 then fail('refresh patched ' .. n .. ' fields, wanted 1') end
sameList({ calls[1].field }, { 'sound:siren' }, 'refresh patched the wrong field')
if calls[1].dialog ~= 'tdet_settings' then fail('refresh used the wrong dialog id') end

-- Options and value in the SAME patch: UpdateDialogField validates the value
-- against the options it is given, so a filename installed since the dialog
-- opened is REJECTED if the two go separately. That is the whole ordering rule.
if calls[1].patch.defaultValue ~= 'new.wav' then fail('refresh did not push the new mapping') end
if not calls[1].patch.options then
    fail('refresh sent a value with no options; a newly-installed file is rejected')
end
local seenNew = false
for _, v in ipairs(optionValues(calls[1].patch)) do if v == 'new.wav' then seenNew = true end end
if not seenNew then fail('the patch validated its own value against a stale option list') end

-- refresh is a no-op once the dialog is closed

SoundFields.clear()
local afterClose, patch2 = recorder()
if SoundFields.refresh('tdet_settings', config({ 'siren' }), patch2) ~= 0 then
    fail('refresh ran after clear(); it patches a dialog that is not open')
end
if #afterClose ~= 0 then fail('refresh touched the export with no dialog open') end

-- Garbage from the wire is ignored rather than raising inside a net handler.
SoundFields.clear()
SoundFields.append({}, { config = config({ 'siren' }) })
local junk, patch3 = recorder()
if SoundFields.refresh('tdet_settings', 'not a table', patch3) ~= 0 then
    fail('refresh accepted a non-table payload')
end
if SoundFields.refresh('tdet_settings', nil, patch3) ~= 0 then
    fail('refresh accepted a nil payload')
end
if SoundFields.refresh('', config({ 'siren' }), patch3) ~= 0 then
    fail('refresh accepted an empty dialog id')
end
if #junk ~= 0 then fail('a rejected refresh still reached the export') end

-- `drawn()` hands back a COPY: a consumer that sorted it in place would
-- otherwise silently re-order what refresh patches.
SoundFields.clear()
SoundFields.append({}, { config = config({ 'a', 'b' }) })
local copy = SoundFields.drawn()
copy[1] = 'mutated'
sameList(SoundFields.drawn(), { 'a', 'b' }, 'drawn() exposed the internal list')

-- NEGATIVE CONTROLS
--
-- Each is one wrong implementation. The assertion is that it FAILS the scenario
-- above that is supposed to catch it. Asserted as a SET OF NAMES rather than a
-- count, so adding a control cannot leave a stale total refusing its own run.

local controls = {}

--- A `:`-split keyOf, which is the obvious way to write it.
controls['keyOf by colon split'] = function()
    local function keyOfSplit(fieldId)
        if type(fieldId) ~= 'string' then return nil end
        local prefix, key = fieldId:match('^([^:]+):([^:]*)$')
        if prefix ~= 'sound' or key == '' then return nil end
        return key
    end
    -- The discriminating case: a key that itself contains a colon.
    return keyOfSplit('sound:bank:2') == 'bank:2'
end

--- A refresh driven by the ARRIVING config rather than by what was drawn.
controls['refresh from the arriving config'] = function()
    local lastDrawn = { 'siren' }
    local function refreshFromConfig(dialogId, data, patch)
        local n = 0
        for _, key in ipairs(data.defaultSoundKeys or {}) do
            patch(dialogId, 'sound:' .. key, {})
            n = n + 1
        end
        return n
    end
    local seen, p = recorder()
    local n = refreshFromConfig('d', config({ 'siren', 'added_later' }), p)
    -- Correct behaviour is to patch exactly the one field that exists.
    return n == 1 and #seen == 1 and seen[1].field == 'sound:' .. lastDrawn[1]
end

--- A refresh that coerces a bad payload to an empty config instead of refusing.
---
--- This is the shape a net handler invites: `data = data or {}` reads as
--- defensive and is the opposite. Every remembered key then gets patched with
--- an empty mapping, so a malformed push from the wire CLEARS the open tab and
--- the next save writes those blanks back.
controls['refresh coerces a bad payload to empty'] = function()
    local remembered = { 'siren' }
    local function refreshCoercing(dialogId, data, patch)
        data = type(data) == 'table' and data or {}
        local map = type(data.soundWavMap) == 'table' and data.soundWavMap or {}
        local n = 0
        for _, key in ipairs(remembered) do
            patch(dialogId, 'sound:' .. key, { options = {}, defaultValue = map[key] or '' })
            n = n + 1
        end
        return n
    end
    local seen, p = recorder()
    -- Correct behaviour on garbage is to do nothing at all.
    return refreshCoercing('d', 'not a table', p) == 0 and #seen == 0
end

--- Options sent in a separate patch from the value.
controls['options and value in separate patches'] = function()
    local function refreshSplit(dialogId, data, patch)
        local map = data.soundWavMap or {}
        for _, key in ipairs({ 'siren' }) do
            patch(dialogId, 'sound:' .. key, { options = { { value = '' } } })
            patch(dialogId, 'sound:' .. key, { defaultValue = map[key] })
        end
        return 1
    end
    local seen, p = recorder()
    refreshSplit('d', config({ 'siren' }, { sound('new.wav') }, { siren = 'new.wav' }), p)
    -- One patch carrying both, or nothing. Two patches is the bug.
    if #seen ~= 1 then return false end
    return seen[1].patch.options ~= nil and seen[1].patch.defaultValue ~= nil
end

--- A builder that drops a mapping naming a file that is no longer installed.
controls['options built from installedSounds only'] = function()
    local function buildNaive(sc, mapped)
        local opts = { { value = '' } }
        for _, s in ipairs(sc.installedSounds or {}) do
            opts[#opts + 1] = { value = s.filename }
        end
        return opts
    end
    local opts = buildNaive(config({ 'siren' }, { sound('a.wav') }, { siren = 'gone.wav' }),
        'gone.wav')
    for _, o in ipairs(opts) do if o.value == 'gone.wav' then return true end end
    return false
end

local EXPECTED_BROKEN = {
    ['keyOf by colon split'] = true,
    ['refresh from the arriving config'] = true,
    ['refresh coerces a bad payload to empty'] = true,
    ['options and value in separate patches'] = true,
    ['options built from installedSounds only'] = true,
}

local brokenNames, passedNames = {}, {}
for name, fn in pairs(controls) do
    local ok, satisfied = pcall(fn)
    if (not ok) or satisfied ~= true then
        brokenNames[#brokenNames + 1] = name
    else
        passedNames[#passedNames + 1] = name
    end
end
table.sort(brokenNames)
table.sort(passedNames)

-- Every control must FAIL. One that passes is a control that cannot
-- discriminate -- the scenario it stands for is not actually being tested, and
-- a count would have hidden which one.
for _, name in ipairs(passedNames) do
    fail(('⚠️ negative control "%s" PASSED. It re-implements a known bug, so the '
        .. 'scenario meant to catch it is not discriminating.'):format(name))
end
local wantNames = {}
for name in pairs(EXPECTED_BROKEN) do wantNames[#wantNames + 1] = name end
table.sort(wantNames)
sameList(brokenNames, wantNames, 'the set of controls that failed is not the set declared')

realPrint('PASS soundfields (' .. #brokenNames .. ' negative controls, all refused)')
