-- The one writer of a resource's JSON data file.
--
-- What this suite is really pinning is that there IS one. tDetector, tRadar and
-- tUnit each carried their own copy of the load / merge / encode / report dance,
-- alongside tLib's soundstore writing two sections of the same document, and the
-- four were safe together only because of an invariant: every writer is
-- read-modify-write over the WHOLE file and none yields between its read and its
-- write. That invariant was stated in prose in two headers and tested in two
-- suites. It is gone now, because `open` memoises and there is one Store.
--
-- So the assertions below are mostly about the things that go wrong SILENTLY:
-- a write that truncates a section it does not know about, a burst that drops
-- one, a refused write that nobody is told about, and an unparseable file that
-- gets overwritten instead of reported.
--
-- Run via `bun run test:lua`.

local function fail(message) error(message, 2) end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local files = {}
function LoadResourceFile(resource, name) return files[resource .. '|' .. name] end
function GetCurrentResourceName() return 'tProbe' end

-- A real encoder is not needed, but encode/decode must round-trip for any of
-- this to mean anything. Storing by identity cannot introduce an encoding bug
-- of its own -- which matters, because what is under test is whether the RIGHT
-- DOCUMENT is written, not whether Lua can serialise.
local encoded = {}
local encodeFails = false
json = {
    encode = function(v)
        if encodeFails then error('cannot serialise') end
        encoded[#encoded + 1] = v
        return '\0json:' .. tostring(#encoded)
    end,
    decode = function(s)
        local n = tostring(s):match('^%z?json:(%d+)$') or tostring(s):match('^\0json:(%d+)$')
        if not n then error('not encoded by this stub: ' .. tostring(s)) end
        return encoded[tonumber(n)]
    end,
}

local logged = {}
local function log(message, level) logged[#logged + 1] = { message = message, level = level } end
local function loggedContains(needle)
    for _, e in ipairs(logged) do
        if tostring(e.message):find(needle, 1, true) then return true end
    end
    return false
end

local writeOk, writeErr = true, nil
local writes = 0
local function defaultWrite(file, contents, resource)
    writes = writes + 1
    if not writeOk then return false, writeErr end
    files[resource .. '|' .. file] = contents
    return true
end
tlib = {
    logger = { DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4 },
    fs = { writeResourceFile = defaultWrite },
}

local JsonStore = dofile('shared/imports/jsonstore/server.lua')

local function reset()
    files, encoded, logged, writes = {}, {}, {}, 0
    writeOk, writeErr, encodeFails = true, nil, false
    -- Two cases below swap the bridge out entirely; without this the next case
    -- inherits it and asserts against the wrong thing.
    tlib.fs.writeResourceFile = defaultWrite
    JsonStore.reset()
end

-- ── One document, one writer ────────────────────────────────────────────────
--
-- The memoisation IS the feature. Two `open` calls for the same file must hand
-- back the same object, or the re-entrancy flag and the pending queue are
-- per-caller and the whole point is lost.

reset()
local a = JsonStore.open({ log = log })
local b = JsonStore.open({ log = log })
if a ~= b then
    fail('two opens of the same document produced two stores; the re-entrancy '
        .. 'guard is then per-caller and two writers can interleave again')
end
if JsonStore.open({ log = log, file = 'other.json' }) == a then
    fail('two different files share one store')
end
if JsonStore.open({ log = log, resource = 'tOther' }) == a then
    fail('two different resources share one store')
end
if pcall(JsonStore.open, {}) then fail('a store was opened with no logger') end

-- ── Reading ─────────────────────────────────────────────────────────────────

reset()
local store = JsonStore.open({ log = log })

-- An absent file is the ordinary first-boot case, not an error.
if next(store:read()) ~= nil then fail('an absent file did not read as an empty document') end
if next(store:section('props')) ~= nil then fail('an absent section did not read as empty') end
if #logged ~= 0 then fail('an absent file was reported as a problem') end

-- A section that is present but is not a table reads as empty, because every
-- caller iterates the result immediately.
files['tProbe|data.json'] = json.encode({ props = 'not a table' })
if next(store:section('props')) ~= nil then fail('a non-table section was handed back') end

-- Unparseable content is SAID OUT LOUD -- tUnit's copy did this and the other
-- two recovered silently, which leaves an owner with no idea why their saved
-- data is gone -- and the file is NOT overwritten, so a typo is still fixable
-- by hand.
reset()
store = JsonStore.open({ log = log })
files['tProbe|data.json'] = '{ this is not json'
if next(store:read()) ~= nil then fail('unparseable content did not read as empty') end
if not loggedContains('is not valid JSON') then
    fail('unparseable content was recovered from silently')
end
if files['tProbe|data.json'] ~= '{ this is not json' then
    fail('reading an unparseable file overwrote it')
end
-- Once per store, not once per read: `section` is called at file scope by
-- several consumers and the same line four times at boot reads as four faults.
local before = #logged
store:read(); store:read(); store:section('props')
if #logged ~= before then fail('the unparseable-JSON notice repeated on every read') end

-- ── Writing is read-modify-write over the WHOLE document ────────────────────
--
-- The one that matters. A write must not truncate a section it does not know
-- about -- which is exactly what a "simplification" to a plain write does, and
-- it does it silently until a restart.

reset()
store = JsonStore.open({ log = log })
files['tProbe|data.json'] = json.encode({
    soundWavMap     = { BLIP = 'blip.wav' },
    installedSounds = { { filename = 'ka_band.wav' } },
})

if store:write({ props = { ['123'] = { x = 1.0 } } }) ~= true then
    fail('a successful write did not report success')
end
local after = store:read()
if after.props == nil or after.props['123'].x ~= 1.0 then fail('the section was not written') end
if after.soundWavMap == nil or after.soundWavMap.BLIP ~= 'blip.wav' then
    fail('writing `props` truncated `soundWavMap`; a sound registry is lost on '
        .. 'every placement save')
end
if after.installedSounds == nil then fail('writing `props` truncated `installedSounds`') end

-- And the other direction, which is the same bug seen from the sound side.
store:write({ soundWavMap = { KA = 'ka.wav' }, installedSounds = {} })
after = store:read()
if after.props == nil or after.props['123'] == nil then
    fail('a sound write truncated the placements')
end
if after.soundWavMap.BLIP ~= nil then fail('the section was merged rather than replaced') end

-- Several sections in one call land together, as soundstore's save does.
if writes ~= 2 then fail('expected one disk write per write() call, got ' .. writes) end

-- ── A burst collapses, and loses nothing ────────────────────────────────────
--
-- Re-entrant rather than queued: a write arriving while one is in flight is
-- merged and replayed once. Merged BY SECTION, not last-wins -- a burst that
-- touched `props` and then `soundWavMap` must not drop the first.

reset()
store = JsonStore.open({ log = log })
local reentered = false
tlib.fs.writeResourceFile = function(file, contents, resource)
    writes = writes + 1
    files[resource .. '|' .. file] = contents
    if not reentered then
        reentered = true
        -- Mid-write, exactly as a second editor save arriving would be.
        store:write({ props = { ['9'] = true } })
        store:write({ soundWavMap = { X = 'x.wav' } })
    end
    return true
end

store:write({ elements = { ['1'] = true } })
after = store:read()
if after.elements == nil then fail('the first write was lost') end
if after.props == nil then fail('a write queued during a write was dropped') end
if after.soundWavMap == nil then
    fail('the pending set was last-wins; a queued write to another section was dropped')
end
if writes ~= 2 then
    fail('a burst of three writes should collapse to two disk writes, got ' .. writes)
end

-- ── Failures are said out loud ──────────────────────────────────────────────
--
-- Swallowing a refusal leaves an admin looking at an edit that vanishes on
-- restart with nothing in the console to explain it.

reset()
store = JsonStore.open({ log = log })
writeOk, writeErr = false, 'EACCES: permission denied'
if store:write({ props = {} }) ~= false then fail('a refused write reported success') end
if not loggedContains('will not survive a restart') then
    fail('a refused write was swallowed')
end
if not loggedContains('EACCES') then
    fail("the bridge's errno was dropped; it is what names the thing to fix")
end
if not loggedContains('props') then fail('the message does not name the lost section') end

reset()
store = JsonStore.open({ log = log })
encodeFails = true
if store:write({ props = {} }) ~= false then fail('an unencodable document reported success') end
if not loggedContains('NOT written') then fail('an encode failure was swallowed') end
if writes ~= 0 then fail('an unencodable document was written anyway') end

-- A throw anywhere inside is contained: a save path that raises would otherwise
-- take out the event handler that called it.
reset()
store = JsonStore.open({ log = log })
tlib.fs.writeResourceFile = function() error('bridge exploded') end
local ok = pcall(store.write, store, { props = {} })
if not ok then fail('a throw inside the write escaped to the caller') end
if not loggedContains('bridge exploded') then fail('a throw inside the write was swallowed') end

-- A non-table is refused rather than written.
if store:write('props') ~= false then fail('a non-table section set was accepted') end

print('PASS jsonstore')
