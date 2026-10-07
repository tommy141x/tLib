-- Seeding, versioning and migration of a resource's JSON data file.
--
-- `tests/lua/jsonstore.lua` is the oracle for the WRITER -- one store per
-- document, read-modify-write over the whole file, a burst that loses nothing.
-- This one is the oracle for the LIFECYCLE: the file is created on first start,
-- migrated forward when the shape changes, and never clobbered on the way.
--
-- Separate rather than appended, for a reason that is about the stub and not
-- about tidiness. ⚠️ The other suite's codec stores tables BY IDENTITY --
-- `encode` keeps the live table and `decode` hands the same one back -- which is
-- right there, because what it tests is whether the correct DOCUMENT was
-- written. It is wrong here: the pre-migration backup would then be the very
-- table the migration goes on to mutate, so "the backup holds the old shape"
-- would pass with no backup at all. The codec below SNAPSHOTS on encode and
-- again on decode, so a backup is a real copy and an on-disk document cannot be
-- changed by mutating something a reader was handed.
--
-- What is assertion-worthy here is, in every case, something that fails
-- SILENTLY and destroys live customer data when it does:
--
--   · seeding defaults over a file whose JSON a hand-edit broke
--   · migrating without a backup, so a failed migration is unrecoverable
--   · a migration that runs twice, or that runs again on the next boot
--   · a document from a NEWER build being reset, or written in the old shape
--   · a migration quietly dropping a top-level key
--   · a migration "succeeding" in demo mode while every reader sees the old shape
--
-- Run via `bun run test:lua`.

local function fail(message) error(message, 2) end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local files = {}
function LoadResourceFile(resource, name) return files[resource .. '|' .. name] end
function GetCurrentResourceName() return 'tProbe' end

-- A snapshotting codec. Not a real JSON serialiser -- what is under test is the
-- lifecycle, not whether Lua can serialise -- but it has the one property a
-- real one has and identity does not: a round trip produces a table that is
-- EQUAL TO and NOT IDENTICAL WITH the one that went in. tCAD's json-adapter
-- suite makes the same choice for the same reason.
local function snapshot(value)
    if type(value) ~= 'table' then return value end
    local copy = {}
    for k, v in pairs(value) do copy[k] = snapshot(v) end
    return copy
end

local stored = {}
local encodeFails = false
json = {
    encode = function(v)
        if encodeFails then error('cannot serialise') end
        stored[#stored + 1] = snapshot(v)
        return '\0json:' .. tostring(#stored)
    end,
    decode = function(s)
        local n = tostring(s):match('^%z?json:(%d+)$') or tostring(s):match('^\0json:(%d+)$')
        if not n then error('not encoded by this stub: ' .. tostring(s)) end
        return snapshot(stored[tonumber(n)])
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

-- `refuseWrites` names the paths that must fail; `droppedWrites` is demo mode,
-- which reports SUCCESS and writes nothing. Those two being different is the
-- whole reason the mirror exists.
local refuseWrites, droppedWrites = {}, false
local writes = {}
local function defaultWrite(file, contents, resource)
    writes[#writes + 1] = file
    if droppedWrites then return true end
    if refuseWrites[file] then return false, refuseWrites[file] end
    files[resource .. '|' .. file] = contents
    return true
end

tlib = {
    logger = { DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4 },
    fs = { writeResourceFile = defaultWrite },
}

local JsonStore = dofile('shared/imports/jsonstore/server.lua')
local SCHEMA_KEY = JsonStore.SCHEMA_KEY
if type(SCHEMA_KEY) ~= 'string' or SCHEMA_KEY == '' then
    fail('JsonStore.SCHEMA_KEY is not published; the gate and this suite would each '
        .. 'have to hard-code the key, which is two places to get it wrong')
end

--- `stored` is deliberately NOT cleared. Several cases below carry a file's
--- bytes across a reset to stand in for "the next boot", and those bytes are a
--- token into this table — clearing it makes the second boot read a file that
--- cannot be decoded, which looks exactly like the thing under test failing.
local function reset()
    files, logged, writes = {}, {}, {}
    refuseWrites, droppedWrites, encodeFails = {}, false, false
    tlib.fs.writeResourceFile = defaultWrite
    JsonStore.reset()
end

--- Put a document on "disk" as the owner's build would have left it.
local function onDisk(doc, versions)
    if versions then doc[SCHEMA_KEY] = versions end
    files['tProbe|data.json'] = json.encode(doc)
end

local function diskDoc(name)
    local raw = files['tProbe|' .. (name or 'data.json')]
    return raw and json.decode(raw) or nil
end

local function countWrites(file)
    local n = 0
    for _, f in ipairs(writes) do if f == file then n = n + 1 end end
    return n
end

-- ── 1. Created on first start ───────────────────────────────────────────────
--
-- Property 2 of the three the module exists for. The release never ships the
-- file (that half is a build gate), so an absent file is the ORDINARY state of
-- a fresh install and not an error.

reset()
local store = JsonStore.open({
    log = log,
    schema = {
        version  = 1,
        defaults = function() return { props = {}, settings = { volume = 0.5 } } end,
        migrations = { [0] = function() end },
    },
})

local state = store:schemaState()
if state == nil then fail('open with a schema did not run ensure') end
if state.action ~= 'seeded' then
    fail('an absent file was not seeded; action was ' .. tostring(state.action))
end
if diskDoc() == nil then fail('the seed never reached the disk') end
if diskDoc().settings.volume ~= 0.5 then fail('the seeded defaults are not in the file') end
if diskDoc()[SCHEMA_KEY].tProbe ~= 1 then fail('the seed did not stamp the schema version') end
if store:locked() ~= nil then fail('a successful seed locked the document') end

-- The second boot has nothing to do, and must not write. A seed that rewrites
-- the file every start is a seed that can lose a save on every start.
local seededFile = files['tProbe|data.json']
reset()
files['tProbe|data.json'] = seededFile
store = JsonStore.open({
    log = log,
    schema = { version = 1, defaults = { props = {} }, migrations = { [0] = function() end } },
})
if store:schemaState().action ~= 'current' then
    fail('an already-seeded file was not recognised as current')
end
if #writes ~= 0 then fail('a current document was rewritten at boot: ' .. #writes .. ' write(s)') end

-- ── 2. ⛔ An unparseable file is NEVER seeded over ───────────────────────────
--
-- The single most destructive thing this module could do. `read()` answers an
-- empty table for an absent file AND for an unparseable one, so a seeder that
-- decides on `next(doc) == nil` meets a file whose JSON a hand-edit broke,
-- concludes "fresh install", and writes defaults over the one copy of the
-- owner's data that was still repairable by hand. tRadio's loadDataFile calls
-- this out in its own words and reports a corrupt file as PRESENT on purpose.

reset()
files['tProbe|data.json'] = '{ "props": { oops'
store = JsonStore.open({
    log = log,
    schema = {
        version    = 1,
        quarantine = true,
        defaults   = function() return { props = { seeded = true } } end,
        migrations = { [0] = function() end },
    },
})

if store:schemaState().action ~= 'unparseable' then
    fail('an unparseable file was not reported as unparseable; action was '
        .. tostring(store:schemaState().action))
end
if files['tProbe|data.json'] ~= '{ "props": { oops' then
    fail('⛔ an unparseable data.json was OVERWRITTEN. This is the branch that destroys '
        .. 'a repairable file and replaces it with defaults.')
end
if not loggedContains('not valid JSON') then fail('an unparseable file was not said out loud') end
if store:locked() == nil then
    fail('writes were not locked on an unparseable file; a later admin save would bury it')
end
if store:write({ props = {} }) ~= false then
    fail('⛔ a write was accepted against an unparseable document')
end
if files['tProbe|data.json'] ~= '{ "props": { oops' then
    fail('⛔ the refused write still reached the disk')
end

-- The copy parked aside is a COPY. The original stays exactly where it is, so
-- the admin can still repair the file they already know the path of.
local quarantine = store:schemaState().quarantine
if not quarantine then fail('quarantine was requested but nothing was parked') end
if files['tProbe|' .. quarantine] ~= '{ "props": { oops' then
    fail('the quarantined copy does not hold the original bytes')
end

-- ── 3. Migrated forward, with a backup first ────────────────────────────────

reset()
onDisk({ props = { a = 1 }, legacySettings = { volume = 0.4 } }, { tProbe = 1 })

store = JsonStore.open({
    log = log,
    schema = {
        version    = 3,
        -- An unstamped document in this fixture is already a v1 document, so
        -- there is no [0] step and `assume` is what says so. Leaving `assume`
        -- at its default of 0 is what FORCES a consumer to decide what a
        -- pre-versioning file means rather than guess -- see case 8.
        assume     = 1,
        migrations = {
            -- Keyed by the version it migrates FROM, which is tAFK's existing
            -- convention. v1 → v2 adds a section; v2 → v3 renames one, which is
            -- a copy plus an explicit allowRemove.
            [1] = function(doc) doc.alerts = doc.alerts or {} end,
            [2] = {
                apply = function(doc)
                    doc.settings = doc.legacySettings
                    doc.legacySettings = nil
                end,
                allowRemove = { 'legacySettings' },
            },
        },
    },
})

state = store:schemaState()
if state.action ~= 'migrated' then
    fail('a behind document was not migrated; action was ' .. tostring(state.action))
end
if state.from ~= 1 or state.to ~= 3 then
    fail(('migration reported %s → %s, expected 1 → 3'):format(tostring(state.from), tostring(state.to)))
end
if #state.applied ~= 2 or state.applied[1] ~= 1 or state.applied[2] ~= 2 then
    fail('the migration steps did not run in order, one at a time')
end

local after = diskDoc()
if after[SCHEMA_KEY].tProbe ~= 3 then fail('the migrated document was not stamped v3') end
if after.alerts == nil then fail('the v1 → v2 step did not land') end
if after.settings == nil or after.settings.volume ~= 0.4 then
    fail('the v2 → v3 rename lost the value it was renaming')
end
if after.legacySettings ~= nil then fail('the declared allowRemove key was not removed') end
if after.props == nil or after.props.a ~= 1 then
    fail('migration dropped a section no step mentioned')
end

-- ⛔ The backup, and that it holds the document AS IT WAS. A migration with no
-- way back is the one that cannot be undone when it turns out to be wrong.
if not state.backup then fail('no pre-migration backup was recorded') end
if not state.backup:find('v1', 1, true) then
    fail('the backup name does not carry the version it was taken at: ' .. tostring(state.backup))
end
local backupDoc = diskDoc(state.backup)
if backupDoc == nil then fail('the backup file does not exist') end
if backupDoc.legacySettings == nil or backupDoc.legacySettings.volume ~= 0.4 then
    fail('⛔ the backup does not hold the PRE-migration shape — it is a copy of the result, '
        .. 'which recovers nothing')
end
if backupDoc.alerts ~= nil then fail('the backup was taken after a step had already run') end
if files['tProbe|data.json'] == nil then fail('the migrated document is not on disk') end

-- ── 4. A migration never runs twice, and is idempotent anyway ───────────────
--
-- Two separate guarantees. "Never twice" is the stamp plus the memoisation.
-- "Idempotent" is required ANYWAY, because in demo mode the stamp never reaches
-- the disk and the same migration runs again on every single start.

local migrated = files['tProbe|data.json']
local runs = 0
local function countingSchema()
    return {
        version    = 2,
        assume     = 1,
        migrations = { [1] = function(doc)
            runs = runs + 1
            doc.touched = (doc.touched or 0) + 1
        end },
    }
end

reset()
onDisk({ props = {} }, { tProbe = 1 })
store = JsonStore.open({ log = log, schema = countingSchema() })
if runs ~= 1 then fail('the migration ran ' .. runs .. ' times on one open, expected 1') end

-- A second open of the same document -- which happens for real, because
-- soundstore opens the consumer's file too -- must not re-run it.
JsonStore.open({ log = log, schema = countingSchema() })
if runs ~= 1 then fail('a second open re-ran the migration (' .. runs .. ' runs)') end

-- And the next boot has nothing to do, because the stamp is on disk.
local once = files['tProbe|data.json']
reset()
runs = 0
files['tProbe|data.json'] = once
store = JsonStore.open({ log = log, schema = countingSchema() })
if runs ~= 0 then fail('a stamped document was migrated again on the next boot') end
if store:schemaState().action ~= 'current' then fail('a v2 document did not read as current') end
if diskDoc().touched ~= 1 then
    fail('the document was touched ' .. tostring(diskDoc().touched) .. ' times across two '
        .. 'boots; the stamp did not stop the second')
end

-- Idempotence proper: running the same step twice over its own output must
-- produce the same document. Asserted on the STEP, because that is the thing a
-- consumer writes and the thing demo mode will run repeatedly.
local function idempotentStep(doc)
    doc.settings = doc.settings or {}
    if doc.settings.volume == nil then doc.settings.volume = 0.5 end
end
local probe = { props = {} }
idempotentStep(probe)
local firstPass = snapshot(probe)
idempotentStep(probe)
if probe.settings.volume ~= firstPass.settings.volume then
    fail('the idempotence fixture is not idempotent, so it proves nothing')
end

-- ── 5. ⛔ A newer document is refused, never reset ───────────────────────────
--
-- The downgrade: an owner rolled the resource back, or restored a resource
-- folder from a backup older than their data. The shape on disk is one this
-- build has never seen.

reset()
onDisk({ props = { keep = 'me' }, futureSection = { 1, 2, 3 } }, { tProbe = 7 })
local newerFile = files['tProbe|data.json']

store = JsonStore.open({
    log = log,
    schema = {
        version    = 2,
        defaults   = function() return { props = { seeded = true } } end,
        migrations = { [0] = function() end, [1] = function() end },
    },
})

state = store:schemaState()
if state.action ~= 'refused' then
    fail('a newer document was not refused; action was ' .. tostring(state.action))
end
if state.from ~= 7 then fail('the refusal did not record the version it found') end
if files['tProbe|data.json'] ~= newerFile then
    fail('⛔ a document from a NEWER build was WRITTEN. A rollback must not cost the owner '
        .. 'the data the newer build wrote.')
end
if not loggedContains('NEWER version') then
    fail('the refusal does not say that the file came from a newer build, which is the one '
        .. 'thing an owner needs to know to fix it')
end
-- Readable, because reading cannot lose anything and a resource that refuses to
-- read looks broken to the owner for no gain.
if store:section('props').keep ~= 'me' then
    fail('a refused document became unreadable; the resource would present as empty')
end
-- But not writable, because writing the old shape over the new one is the part
-- that destroys data.
if store:write({ props = {} }) ~= false then
    fail('⛔ a write was accepted against a newer-than-known document')
end
if files['tProbe|data.json'] ~= newerFile then fail('⛔ the refused write reached the disk') end
if diskDoc().futureSection == nil then fail('the newer build\'s own section was lost') end

-- A version that is not a number is not a version. Coercing it would pick a
-- shape at random; tAFK refuses it and so does this.
reset()
onDisk({ props = {} }, { tProbe = 'two' })
local badVersionFile = files['tProbe|data.json']
store = JsonStore.open({
    log = log,
    schema = { version = 1, migrations = { [0] = function() end } },
})
if store:schemaState().action ~= 'refused' then fail('a non-numeric version was accepted') end
if files['tProbe|data.json'] ~= badVersionFile then
    fail('a document with an unreadable version was written')
end

-- ── 6. ⛔ A migration may not delete, unless it says so ─────────────────────
--
-- "Never delete" enforced rather than intended, matching the tlib_demo
-- convention of resetting by dropping writes and never deleting. A removal that
-- is deliberate is declared, which puts the one destructive act a migration can
-- perform in the diff where a reviewer sees it.

reset()
onDisk({ props = { a = 1 }, soundWavMap = { BLIP = 'blip.wav' } }, { tProbe = 1 })
local beforeDelete = files['tProbe|data.json']

store = JsonStore.open({
    log = log,
    schema = {
        version    = 2,
        assume     = 1,
        -- Does NOT declare soundWavMap in allowRemove -- and soundWavMap is not
        -- even this owner's section, it is tlib.soundstore's, which is exactly
        -- how this mistake happens for real.
        migrations = { [1] = function(doc) doc.soundWavMap = nil end },
    },
})

state = store:schemaState()
if state.action ~= 'refused' then
    fail('⛔ a migration that deleted an undeclared top-level key was allowed')
end
if files['tProbe|data.json'] ~= beforeDelete then
    fail('⛔ the deleting migration was WRITTEN. Nothing may reach the disk once a step '
        .. 'has been refused.')
end
if not loggedContains('allowRemove') then
    fail('the refusal does not name allowRemove, so a developer cannot act on it')
end
if store:locked() == nil then
    fail('writes were not locked after a refused migration; the half-migrated in-memory '
        .. 'document could still be persisted by the next save')
end

-- A step that raises is the same shape of failure, and must also write nothing.
reset()
onDisk({ props = { a = 1 } }, { tProbe = 1 })
local beforeThrow = files['tProbe|data.json']
store = JsonStore.open({
    log = log,
    schema = {
        version = 2, assume = 1,
        migrations = { [1] = function() error('bad migration') end },
    },
})
if store:schemaState().action ~= 'refused' then fail('a migration that raised was not refused') end
if files['tProbe|data.json'] ~= beforeThrow then
    fail('⛔ a document was written after its migration raised')
end
if not loggedContains('bad migration') then fail('the migration error was swallowed') end

-- ── 7. ⛔ No backup, no migration ───────────────────────────────────────────
--
-- A disk that refuses the backup is a disk that may refuse the half-written
-- result too, and an unrecoverable migration is worse than a stale document.

reset()
onDisk({ props = { a = 1 } }, { tProbe = 1 })
local beforeNoBackup = files['tProbe|data.json']
refuseWrites['data.json.v1.bak'] = 'EACCES: permission denied'

local ran = false
store = JsonStore.open({
    log = log,
    schema = { version = 2, assume = 1, migrations = { [1] = function() ran = true end } },
})
if store:schemaState().action ~= 'refused' then
    fail('a migration ran with no recoverable backup')
end
if ran then fail('⛔ the migration step ran even though the backup had failed') end
if files['tProbe|data.json'] ~= beforeNoBackup then
    fail('⛔ the document was written without a backup')
end
if not loggedContains('EACCES') then
    fail("the disk's own errno was dropped; it is what names the thing to fix")
end

-- ── 8. The schema is validated loudly, at open ──────────────────────────────
--
-- A gap in the migration list is the quiet one: without this, v1 → v3 with only
-- a [1] step would stamp the document v3 while its shape is v2, and nothing
-- would ever say so again.

reset()
local function opening(schema)
    return pcall(JsonStore.open, { log = log, schema = schema })
end
if opening({ version = 3, migrations = { [1] = function() end } }) then
    fail('⛔ a schema with no step for v2 was accepted; the document would be stamped with '
        .. 'a shape it does not have')
end
JsonStore.reset()
if opening({ version = -1 }) then fail('a negative version was accepted') end
JsonStore.reset()
if opening({ version = 1.5, migrations = { [0] = function() end } }) then
    fail('a fractional version was accepted')
end
JsonStore.reset()
if opening({ version = 1, assume = 2, migrations = { [0] = function() end } }) then
    fail('assume above version was accepted; an unstamped document cannot be ahead of the '
        .. 'build reading it')
end
JsonStore.reset()
if opening({ version = 2, migrations = { [1] = function() end }, assume = 1 }) == false then
    fail('a correct schema was rejected, so the rejections above prove nothing')
end

-- ── 9. Two owners version one document independently ───────────────────────
--
-- Every one of these documents is co-owned: tELS's `vehicles` belongs to tLib
-- Discovery, tDetector's `soundWavMap` to tlib.soundstore. One scalar version
-- for the whole file would make soundstore bumping its shape lock the consumer
-- out of its own sections.

reset()
onDisk({ props = { a = 1 }, soundWavMap = { BLIP = 'b.wav' } }, { tProbe = 1, soundstore = 1 })

local consumer = JsonStore.open({
    log = log,
    schema = { version = 2, assume = 1, migrations = { [1] = function(doc) doc.bolo = {} end } },
})
local sounds = JsonStore.open({
    log = log,
    schema = {
        owner      = 'soundstore',
        version    = 1,
        -- The ordinary adoption shape: this owner's existing documents in the
        -- field have no stamp and are already at v1, so `assume` says so and
        -- there is no step to write.
        assume     = 1,
        migrations = {},
    },
})
if consumer ~= sounds then fail('two opens of one document produced two stores') end
if consumer:schemaState().action ~= 'migrated' then fail('the consumer did not migrate') end
if consumer:schemaState('soundstore').action ~= 'current' then
    fail('the second owner was not evaluated independently')
end
after = diskDoc()
if after[SCHEMA_KEY].tProbe ~= 2 then fail('the consumer version was not stamped') end
if after[SCHEMA_KEY].soundstore ~= 1 then
    fail('stamping one owner dropped the other owner\'s version')
end
if after.soundWavMap == nil or after.soundWavMap.BLIP ~= 'b.wav' then
    fail('the consumer migration truncated the other owner\'s section')
end

-- An owner behind while the OTHER owner is ahead of this build is still a
-- refusal for that owner alone -- it must not lock the whole document for an
-- owner whose own version is fine.
reset()
onDisk({ props = {} }, { tProbe = 1, soundstore = 9 })
store = JsonStore.open({ log = log, schema = { version = 1, assume = 1, migrations = {} } })
if store:schemaState().action ~= 'current' then
    fail('an owner at its own current version was affected by another owner being ahead')
end
if store:locked() ~= nil then
    fail('a document was locked because a DIFFERENT owner was ahead of this build')
end

-- ── 10. Defaults fill absent keys without stamping ──────────────────────────
--
-- tAFK wrote the rule down after it cost them the whole mechanism: "stamping
-- the current version here is what stopped migrations from ever running".
-- Filling and versioning are separate acts.

reset()
onDisk({ props = { a = 1 }, settings = { volume = 0.2 } })  -- no stamp at all
store = JsonStore.open({
    log = log,
    schema = {
        version  = 1,
        assume   = 1,   -- an unstamped legacy document is already at v1 here
        defaults = function() return { props = {}, settings = { volume = 0.9 }, alerts = {} } end,
        migrations = {},
    },
})
after = diskDoc()
if after.settings.volume ~= 0.2 then
    fail('⛔ defaults overwrote a key the owner had already set. Seeding is per key and '
        .. 'only into an ABSENT key, so a part-written file is completed, not replaced.')
end
if after.alerts == nil then fail('a newly added default key did not arrive') end
if after.props.a ~= 1 then fail('an existing section was replaced by its default') end

-- ── 11. Demo mode: a migration that cannot land must not look landed ───────
--
-- `tlib.fs.writeResourceFile` DROPS the write and reports SUCCESS when
-- `tlib_demo` is set. Without the write-behind mirror the migration reports
-- success, the file keeps the old shape, and every reader for the rest of the
-- session is handed the old shape while the code believes it is on the new one.

reset()
onDisk({ props = { a = 1 }, legacy = { v = 1 } }, { tProbe = 1 })
local beforeDemo = files['tProbe|data.json']
droppedWrites = true

store = JsonStore.open({
    log = log,
    schema = {
        version    = 2,
        assume     = 1,
        migrations = { [1] = {
            apply = function(doc) doc.modern = doc.legacy; doc.legacy = nil end,
            allowRemove = { 'legacy' },
        } },
    },
})

if store:schemaState().action ~= 'migrated' then
    fail('demo mode turned a migration into a failure; a demo box must still run')
end
if files['tProbe|data.json'] ~= beforeDemo then
    fail('demo mode did not keep the file as it shipped')
end
if store:read().modern == nil then
    fail('⛔ the session is reading the PRE-migration document while the code believes it '
        .. 'migrated. This is the worst of the three outcomes: shape and code disagree '
        .. 'with nothing to say so.')
end
if store:read().legacy ~= nil then fail('the mirror still holds the pre-migration key') end
if not loggedContains('in-memory copy') then
    fail('a session running on a mirror did not say so; an owner has no way to know why '
        .. 'nothing persists')
end
-- And a write during that session stays coherent with the mirror, rather than
-- reverting the reader to the on-disk shape.
store:write({ props = { a = 2 } })
if store:read().props.a ~= 2 then fail('a write was invisible to the mirror') end
if store:read().modern == nil then fail('a write reverted the mirror to the on-disk shape') end

-- ── 12. A first-start seed that cannot be written is not a lock ────────────
--
-- There is nothing on disk to protect and the consumer's own shipped
-- configuration is still the live answer, so a read-only resource directory
-- must still boot. It is said out loud, because an owner watching settings
-- vanish on every restart needs the reason in the console.

reset()
refuseWrites['data.json'] = 'EROFS: read-only file system'
store = JsonStore.open({
    log = log,
    schema = { version = 1, defaults = { props = {} }, migrations = { [0] = function() end } },
})
if store:schemaState().action ~= 'refused' then fail('a failed seed was reported as success') end
if not loggedContains('EROFS') then fail('the errno was dropped from a failed first seed') end
if not loggedContains('nothing will survive a restart') then
    fail('a failed first seed did not say that nothing persists')
end

-- ── 13. Nothing is written when there is nothing to do ─────────────────────
--
-- A boot that rewrites the file for no reason is a boot that can lose a save
-- for no reason, and it is also how a release that must never ship the file
-- ends up with one in a developer's working tree.

reset()
onDisk({ props = { a = 1 } }, { tProbe = 2 })
JsonStore.open({
    log = log,
    schema = {
        version = 2, assume = 1,
        defaults = { props = {} }, migrations = { [1] = function() end },
    },
})
if countWrites('data.json') ~= 0 then
    fail('a document that was already current and complete was rewritten')
end

print('PASS jsonstore-schema')
