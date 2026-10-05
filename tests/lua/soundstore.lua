-- The data.json sound registry, and above all the order its boot steps run in.
-- The regression that made this shared: tDetector reconciled installedSounds
-- AFTER judging the tone mappings against it, so one unreadable folder emptied
-- the list on boot 1 and the now-empty list convinced boot 2 that every default
-- mapping was a phantom. The device went silent and no restart brought it back,
-- because nothing but the admin panel ever writes the map. tRadar was carrying
-- a copy of the same code.

-- ── host stubs ──────────────────────────────────────────────────────────────

local function deepcopy(value)
    if type(value) ~= 'table' then return value end
    local out = {}
    for k, v in pairs(value) do out[k] = deepcopy(v) end
    return out
end

-- A json pair that round-trips real tables without a real encoder. Copies on
-- the way in, so a stored blob cannot be mutated through the live table the
-- store is still holding.
local _blobs = {}
json = {
    encode = function(value)
        local id = 'BLOB:' .. tostring(#_blobs + 1)
        _blobs[#_blobs + 1] = deepcopy(value)
        _blobs[id] = _blobs[#_blobs]
        return id
    end,
    decode = function(text)
        local blob = _blobs[text]
        if blob == nil then error('not json: ' .. tostring(text)) end
        return deepcopy(blob)
    end,
}

local files      = {}   -- "<resource>/<path>" -> contents
local scanReply  = nil  -- what ScanResourceFiles answers
local writes     = 0
local writeFails = false

GetCurrentResourceName = function() return 'tRadar' end
LoadResourceFile = function(resource, path) return files[resource .. '/' .. path] end
SaveResourceFile = function(resource, path, contents, _)
    if writeFails then return false end
    writes = writes + 1
    files[resource .. '/' .. path] = contents
    return true
end
-- The Node fs bridge, as the real one answers: `true`, or a NON-EMPTY error
-- string. `bridgeWorks = false` stands for a resource whose server bundle never
-- called registerWriteResourceFile(), which is an error crossing the boundary
-- rather than a returned string.
--
-- It hangs off `exports.tRadar`, not `exports.tLib`, and that placement is the
-- test: FiveM's Node runtime sandboxes each resource to its own directory, so
-- tLib cannot write tRadar's data.json on its behalf. Every resource registers
-- the shared implementation itself and tlib.fs calls the LOCAL one. A stub on
-- `tLib` here would pass while production was being refused.
local bridgeWorks = true
exports = {
    tLib = {
        ScanResourceFiles = function(_, _, _) return scanReply end,
    },
    tRadar = {
        WriteResourceFile = function(_, resource, path, contents)
            -- What FiveM itself raises for an export a resource does not have,
            -- which is the shape tlib.fs has to recognise as "no bridge here".
            if not bridgeWorks then error('No such export WriteResourceFile in resource tRadar') end
            writes = writes + 1
            files[resource .. '/' .. path] = contents
            return true
        end,
    },
}

local function diskListing(names)
    -- ScanResourceFiles answers a json string; our decoder wants a blob id.
    local entries = {}
    for i, name in ipairs(names) do entries[i] = name end
    return json.encode({ ok = true, entries = entries })
end

-- tlib.fs consults demo mode before every write. Off for the whole suite except
-- the section at the end, so every case above keeps asserting that the write
-- really reaches disk.
local demoOn = false

tlib = {
    demo        = {
        active = function() return demoOn end,
        -- The real module's dropWrite is `active()` plus a one-time console
        -- notice. Reproduced rather than dofile'd so this suite stays an oracle
        -- for what fs/server.lua does with the answer, not for how demo mode
        -- reaches it.
        dropWrite = function() return demoOn end,
    },
    logger      = dofile('shared/imports/logger/shared.lua'),
    fs          = dofile('shared/imports/fs/server.lua'),
    assets      = dofile('shared/imports/assets/shared.lua'),
    marketplace = dofile('shared/imports/marketplace/server.lua'),
    -- The real one: soundstore is no longer A writer of data.json, it is a
    -- caller of THE writer, and a stub here would quietly make this suite the
    -- oracle for a second implementation.
    jsonstore   = dofile('shared/imports/jsonstore/server.lua'),
}

local soundstore = dofile('shared/imports/soundstore/server.lua')

local logged = {}
local function log(message, level) logged[#logged + 1] = { message = message, level = level } end
local function loggedAt(level)
    for _, entry in ipairs(logged) do
        if entry.level == level then return entry.message end
    end
end

local function reset()
    files, _blobs, logged, writes, writeFails, scanReply = {}, {}, {}, 0, false, nil
    bridgeWorks = true
    -- tlib.fs memoises "is SaveResourceFile usable here" per target resource for
    -- the life of the server, which is right in production and wrong across
    -- cases here: without a fresh copy, the first case that makes the native
    -- fail pins every later one onto the bridge.
    tlib.fs = dofile('shared/imports/fs/server.lua')
    -- And jsonstore memoises one store per resource-and-file for the life of
    -- the server, which is the whole point of it there and wrong here: a case
    -- that left a write in flight, or that tripped the once-per-store
    -- unparseable-JSON notice, would carry both into the next one.
    tlib.jsonstore.reset()
end

local KEYS = { 'BEEP', 'LOCK', 'FAST_LOCK' }

local function open(opts)
    opts = opts or {}
    opts.keys = opts.keys or KEYS
    opts.log  = log
    return soundstore.open(opts)
end

local function seed(data)
    files['tRadar/data.json'] = json.encode(data)
end

-- ── a first boot seeds only what is genuinely on disk ───────────────────────

reset()
files['tRadar/layouts/sounds/beep.wav'] = 'RIFF'
scanReply = diskListing({ 'beep.wav' })
local store = open()
assert(store.toneWavMap.BEEP == 'beep.wav', 'a shipped file present on disk gets its default mapping')
assert(store.toneWavMap.LOCK == nil, 'a file that is not there is never mapped')
assert(#store.installedSounds == 1 and store.installedSounds[1].slug == 'beep',
    'an untracked file on disk is adopted into installedSounds')
assert(writes == 1, 'the seeded registry is persisted once')
assert(store:config().defaultSoundKeys == KEYS, 'the panel payload carries the key list')

-- ── the two-boot cascade, which is why the order is what it is ──────────────

reset()
seed({ soundWavMap = { BEEP = 'beep.wav' }, installedSounds = { { filename = 'beep.wav', slug = 'beep' } } })
scanReply = nil -- the directory could not be read at all
store = open()
assert(#store.installedSounds == 1, 'an unreadable folder must not prune installedSounds')
assert(store.toneWavMap.BEEP == 'beep.wav', 'nor delete the mappings that list would have justified')
assert(writes == 0, 'and nothing is written, so the next boot starts from the same place')
assert(loggedAt(tlib.logger.WARN), 'the skipped reconciliation is announced, not silent')

-- An empty listing is the same story: it is indistinguishable from a folder we
-- could not read, and only one of the two readings is worth losing data over.
reset()
seed({ soundWavMap = { BEEP = 'beep.wav' }, installedSounds = { { filename = 'beep.wav', slug = 'beep' } } })
scanReply = diskListing({})
store = open()
assert(#store.installedSounds == 1 and store.toneWavMap.BEEP == 'beep.wav',
    'an empty scan is treated as a failed scan, not as an empty folder')

-- ...but it is not REPORTED as one. A device that ships no tones of its own --
-- tRadar does not, and says so in layouts/sounds/README.md -- would otherwise
-- print a warning about an unreadable directory on every boot of a perfectly
-- healthy server, which is how a real warning stops being read. The behaviour
-- above is deliberately identical; only the level and the wording differ.
assert(not loggedAt(tlib.logger.WARN),
    'a folder that was read and holds no audio is not a warning')
local empty = loggedAt(tlib.logger.INFO)
assert(empty and empty:find('holds no audio files', 1, true),
    'it is still stated, so an operator who expected tones knows where they go')

-- With the folder readable, the phantom pass judges mappings against the disk
-- rather than against a list the previous step may have just emptied.
reset()
seed({ soundWavMap = { BEEP = 'beep.wav', LOCK = 'lock.wav' }, installedSounds = {} })
files['tRadar/layouts/sounds/beep.wav'] = 'RIFF'
scanReply = diskListing({ 'beep.wav' })
store = open()
assert(store.toneWavMap.BEEP == 'beep.wav', 'a default mapping whose file is present survives')
assert(store.toneWavMap.LOCK == nil, 'a default mapping whose file is gone is cleared')
assert(#store.installedSounds == 1, 'the file on disk is tracked even though data.json had nothing')

-- ── the phantom rule only ever touches auto-seeded mappings ─────────────────

reset()
seed({ soundWavMap = { BEEP = 'operator-choice.wav', SIREN = 'siren.wav' }, installedSounds = {} })
files['tRadar/layouts/sounds/other.wav'] = 'RIFF'
scanReply = diskListing({ 'other.wav' })
store = open()
assert(store.toneWavMap.BEEP == 'operator-choice.wav',
    'a filename the admin chose is theirs, present on disk or not')
assert(store.toneWavMap.SIREN == 'siren.wav',
    'a key this device does not know is none of the default rule\'s business')

-- A consumer whose seeded names do not follow the key rule passes its own
-- predicate; tDetector's legacy auto-seeds could land under any key.
reset()
seed({ soundWavMap = { BEEP = 'gps_connected.wav', LOCK = 'keep.wav' }, installedSounds = {} })
files['tRadar/layouts/sounds/other.wav'] = 'RIFF'
scanReply = diskListing({ 'other.wav' })
store = open({ phantom = function(_, filename) return filename == 'gps_connected.wav' end })
assert(store.toneWavMap.BEEP == nil, 'the consumer predicate decides, and it matched on filename alone')
assert(store.toneWavMap.LOCK == 'keep.wav', 'a mapping it did not accept is left alone')

-- ── self-heal falls back to a direct read when the listing is unavailable ───
--
-- The environment where the directory cannot be listed is exactly the one that
-- needs healing most, and LoadResourceFile still works there.

reset()
files['tRadar/layouts/sounds/lock.wav'] = 'RIFF'
scanReply = nil
store = open()
assert(store.toneWavMap.LOCK == 'lock.wav', 'a file confirmed by direct read is mapped')
assert(store.toneWavMap.BEEP == nil, 'a file that fails the read is not')

-- ── saving is a read-modify-write, not a truncation ─────────────────────────

reset()
seed({ soundWavMap = {}, installedSounds = {}, hudLayout = 'compact', beamRange = 300 })
scanReply = diskListing({})
store = open()
assert(store:setMapping('BEEP', 'beep.wav'), 'a well-formed mapping is accepted')
local onDisk = json.decode(files['tRadar/data.json'])
assert(onDisk.hudLayout == 'compact' and onDisk.beamRange == 300,
    'settings this module knows nothing about survive its writes')
assert(onDisk.soundWavMap.BEEP == 'beep.wav', 'and the mapping really landed')

assert(not store:setMapping('', 'x.wav'), 'an empty key is rejected')
assert(not store:setMapping(nil, 'x.wav'), 'a missing key is rejected')
assert(store:setMapping('BEEP', ''), 'an empty filename is the documented way to clear')
assert(store.toneWavMap.BEEP == nil, 'and it clears')

-- ── removing a sound sweeps every tone that pointed at it ───────────────────

reset()
seed({
    soundWavMap = { BEEP = 'horn.wav', LOCK = 'horn.wav', FAST_LOCK = 'other.wav' },
    installedSounds = { { filename = 'horn.wav', slug = 'horn' }, { filename = 'other.wav', slug = 'other' } },
})
scanReply = nil
store = open()
assert(store:removeSound('horn.wav'))
assert(store.toneWavMap.BEEP == nil and store.toneWavMap.LOCK == nil,
    'a mapping left pointing at a deleted file 404s in the NUI')
assert(store.toneWavMap.FAST_LOCK == 'other.wav', 'unrelated mappings are untouched')
assert(#store.installedSounds == 1, 'the record is gone')
assert(not store:removeSound(''), 'a malformed filename is rejected outright')

-- ── marketplace install / uninstall ─────────────────────────────────────────

reset()
seed({ soundWavMap = {}, installedSounds = { { filename = 'siren.wav', slug = 'old-pack' } } })
scanReply = nil
store = open()
local conflict = store:install('siren')
assert(conflict == 'old-pack', 'the slug already claiming that filename is reported')
store:setMapping('BEEP', 'siren.wav')
local removed = store:uninstall('siren')
assert(removed == 'siren.wav', 'the removed filename is reported back')
assert(store.toneWavMap.BEEP == nil, 'and its mappings are cleared')
assert(loggedAt(tlib.logger.INFO), 'the clearing is logged, since the admin did not ask for it')

-- ── a refused native write falls back, and is never swallowed ───────────────
--
-- FiveM for GTAV Enhanced refuses SaveResourceFile outright for some resources
-- while Node's fs writes the identical path, so a refusal is not the end of the
-- story: tlib.fs retries through the resource's own bridge and the settings
-- still land. That
-- is the case this suite has to hold, because the symptom it replaces --
-- "data.json never changes and nothing says why" -- is invisible until a
-- restart.

reset()
seed({ soundWavMap = {}, installedSounds = {} })
scanReply = nil
store = open()
-- open() already logged the unreadable-directory warning; what is under test is
-- what the WRITE says, and loggedAt answers with the first entry at a level.
logged = {}
writeFails = true
store:setMapping('BEEP', 'beep.wav')
assert(json.decode(files['tRadar/data.json']).soundWavMap.BEEP == 'beep.wav',
    'a native refusal is retried through the bridge, and the mapping still lands')
assert(not loggedAt(tlib.logger.ERROR),
    'a write that succeeded through the bridge is not an error')
local diverted = loggedAt(tlib.logger.WARN)
assert(diverted and diverted:find('Node fs bridge', 1, true),
    'the diversion is announced once, so a later failure can be read in context')

-- And when the bridge is not there either -- a consumer whose own server bundle
-- never registered the export -- there is nothing left to try, so it has to be
-- said out loud.

reset()
seed({ soundWavMap = {}, installedSounds = {} })
scanReply = nil
store = open()
logged = {}
writeFails, bridgeWorks = true, false
store:setMapping('BEEP', 'beep.wav')
local err = loggedAt(tlib.logger.ERROR)
assert(err and err:find('will not survive a restart', 1, true),
    'a write nothing can complete is reported, not swallowed')
assert(err:find('bridge is unavailable', 1, true),
    'and it names the bridge rather than blaming file permissions')

-- ── a log handle is not optional ────────────────────────────────────────────

reset()
scanReply = nil
local ok = pcall(soundstore.open, { keys = KEYS })
assert(not ok, 'every branch here is destructive or corrective; none of them may run silently')

-- ── demo mode drops the write, and reports success ─────────────────────────
--
-- The half of demo mode that keeps a showroom server pristine. Two properties
-- matter and they pull in opposite directions: nothing may reach disk, and the
-- caller must not be told the save failed. Every caller of tlib.fs treats a
-- failure as data loss and says so to the player, so returning false here would
-- put a red error behind every settings change on a working demo.

reset()
seed({ soundWavMap = { BEEP = 'old.wav' }, installedSounds = {} })
scanReply = nil
store = open()
logged = {}
local before = files['tRadar/data.json']
demoOn = true
store:setMapping('BEEP', 'beep.wav')
assert(files['tRadar/data.json'] == before, 'demo mode leaves the file on disk exactly as it was')
-- `toneWavMap` in memory, `soundWavMap` on disk -- the two names are the same
-- map and the asymmetry is easy to assert past by accident.
assert(store.toneWavMap.BEEP == 'beep.wav', 'while the in-memory mapping is live for this session')
assert(not loggedAt(tlib.logger.ERROR), 'and the caller is not told its save failed')

-- The native must not even be attempted: tlib.fs memoises "is SaveResourceFile
-- usable here" per target, and letting a dropped write through to a stubbed-out
-- or refusing native would poison that verdict for the rest of the session.
local writesBefore = writes
writeFails = true
store:setMapping('LOCK', 'lock.wav')
assert(writes == writesBefore, 'no native write is attempted at all')
assert(not loggedAt(tlib.logger.ERROR), 'and a refusing native is never reached, so never reported')

demoOn = false
writeFails = false
store:setMapping('BEEP', 'real.wav')
assert(json.decode(files['tRadar/data.json']).soundWavMap.BEEP == 'real.wav',
    'and writes land again the moment demo mode is off')

print('PASS soundstore')
