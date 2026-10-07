--[[
    tLib — the one writer of a resource's JSON data file (server)

        local store = tlib.jsonstore.open({ log = tlib.logger.create('tDetector') })

        store:section('props')            -- the section, or an empty table
        store:write({ props = placements })

    ── Why this exists ─────────────────────────────────────────────────────────

    `data.json` is SHARED. tLib's soundstore owns `soundWavMap` and
    `installedSounds`; the consumer owns everything else — `props` in tDetector
    and tRadar, `elements` in tUnit. Each of those carried its own copy of the
    load / merge / encode / report dance, and tDetector's and tRadar's
    `server/sv_data.lua` were identical in all 46 code lines: only their header
    comments differed. tRadar's header already named the problem — it is
    "precisely the duplication that put the same hundred and fifty lines in
    tDetector and tRadar until tlib.soundstore existed".

    ── What changes, and it is not just the line count ─────────────────────────

    Those files were safe because of an INVARIANT, stated in prose in two
    places and tested in two more: two writers cannot truncate each other
    BECAUSE both are read-modify-write over the whole document and neither
    yields between its read and its write. That is true, and it is the kind of
    true that a later "simplification" to a plain write destroys silently — the
    other section's data is gone, and only a restart shows it.

    There is one writer now, so the invariant is not restated, it is removed.
    `open` MEMOISES per resource-and-file: soundstore and the consumer's own
    sections go through the same `Store`, the same re-entrancy flag and the
    same queue. Two saves can no longer interleave at all, rather than being
    safe when they do.

    ── Re-entrancy ─────────────────────────────────────────────────────────────

    Re-entrant rather than queued: a write arriving while one is in flight is
    MERGED into a pending set and replayed once, so a burst of editor saves
    collapses into one extra write rather than a stack of them. Merged by
    section, not last-wins — a burst that touched `props` and then
    `soundWavMap` must not drop the first.

    ── Reading is forgiving on purpose ─────────────────────────────────────────

    Every read failure is an empty table rather than an error. data.json is a
    file on disk that a text editor may have been at, and refusing to boot over
    it would take the whole resource down for a file nobody has to be able to
    read. Unparseable content is said out loud once — tUnit's copy did this and
    the other two did not, and silent recovery is the one that leaves an owner
    with no idea why their placements are gone — and the file is NOT
    overwritten until something deliberately writes a section, so a typo in it
    is still fixable by hand.

    ── Seeding and migration: `schema` ─────────────────────────────────────────

        local store = tlib.jsonstore.open({
            log    = log,
            schema = {
                version  = 3,
                defaults = function() return { props = {}, settings = {} } end,
                migrations = {
                    [2] = function(doc) doc.settings = doc.settings or {} end,
                    [3] = { apply = function(doc) ... end, allowRemove = { 'oldKey' } },
                },
            },
        })
        -- `open` has already seeded or migrated; `store:schemaState()` says which.

    Three properties, which every resource with a data file needs and which five
    of them had each hand-rolled differently:

      1. The file is NEVER SHIPPED, so an update cannot land on a live one.
         That half is a release gate, not this module — see
         `tLib/shared/ts/build/runtime-state-contract.ts`.
      2. It is CREATED ON FIRST START when absent, from `schema.defaults`.
      3. It is MIGRATED FORWARD when `schema.version` rises, rather than being
         clobbered or left stale.

    ── Why `absent`, `ok` and `unparseable` are three states, not two ──────────

    ⛔ THIS IS THE WHOLE SAFETY INTERLOCK, and `read()` alone cannot express it:
    it answers an empty table for an absent file AND for an unparseable one,
    which is right for a reader and catastrophic for a seeder. Seeding on
    `next(doc) == nil` would meet a file whose JSON a hand-edit broke, decide
    this was a brand-new install, and write defaults over the one copy of the
    owner's data that was still repairable by hand.

    tRadio's `loadDataFile` is the prior art and says it in its own words — a
    file that failed to parse "reports `true` here on purpose so a corrupt file
    is never quietly replaced with defaults either". So:

      · absent      → seed from `schema.defaults`, stamp the version, write.
      · ok          → migrate forward if behind; otherwise leave alone.
      · unparseable → DO NOTHING. No seed, no migration, no write. Said out
                      loud, and `write()` is refused for the rest of the session
                      so a later save cannot bury it either.

    Seeding is PER TOP-LEVEL KEY and only into a key that is absent, which is
    tRadio's rule and tELS's: a partial hand-written data.json — the documented
    workflow for an owner whose host gives the server no write access — is
    completed rather than overwritten.

    ── Forward only, and a newer document is a loud refusal ────────────────────

    ⚠️ A document stamped NEWER than this build understands is the DOWNGRADE
    case: an owner rolled a resource back, or restored a resource folder from a
    backup older than their data. The shape on disk is one this code has never
    seen, so resetting it, seeding over it or "migrating" it would destroy data
    that is not broken.

    It is refused rather than reset: the version is left alone, the document
    stays READABLE (reading cannot lose anything, and a resource that cannot
    read looks broken to the owner for no gain), and every `write()` returns
    false with the reason. The resource runs read-only on that document until
    the owner upgrades again or moves the file aside themselves.

    ── Back up before migrating, and never delete ──────────────────────────────

    Before the first migration runs, the file's RAW BYTES are copied to
    `<file>.v<from>.bak` — the bytes, not a re-encode, so the backup is byte
    identical to what the owner had. ⚠️ If that copy cannot be written the
    migration DOES NOT RUN: an unrecoverable migration is worse than a stale
    document, and a disk that refuses the backup is a disk that may refuse the
    half-written result too.

    Deliberately NOT the same artifact as the `data.json.bak` tRadio and tCAD
    rotate on every successful save. That one is a rolling last-known-good and
    a migration-time snapshot would destroy it; this one is a one-off, and the
    `from` version in its name is what makes it findable a month later.

    "Never delete" is ENFORCED rather than intended, matching the `tlib_demo`
    convention of resetting by dropping writes and never deleting: a migration
    whose result is missing a top-level key the document had before is REFUSED
    and nothing is written, unless that migration declares the key in
    `allowRemove`. A rename is therefore a copy plus an explicit `allowRemove`,
    which puts the one destructive act a migration can perform in the diff
    where a reviewer sees it.

    ── Idempotence, and never running twice ────────────────────────────────────

    Two separate guarantees, which the demo convar pulls apart.

    "Never twice" is the stamp plus the memoisation: `ensure` runs once per
    `Store`, and the version it writes leaves the next boot nothing to do.

    "Idempotent" is required of each migration ANYWAY, because with `tlib_demo`
    set `tlib.fs.writeResourceFile` drops the write and reports success — so the
    stamp never reaches the disk and the same migration runs again on every
    single start. A migration that appends rather than assigns would grow the
    document without bound on a demo box, and nothing would say so.
]]

local JsonStore = {}

local Store = {}
-- Forward declaration so SCHEMA_KEY below can be published on the module table
-- without the release gate having to hard-code the string a second time.
Store.__index = Store

--- resource .. '|' .. file -> Store. The whole point: one writer per document.
local open = {}

--- Where the per-owner schema versions live inside the document.
---
--- An OBJECT keyed by owner, not a bare `version` scalar, because every one of
--- these documents is co-owned. tELS's `vehicles` section belongs to tLib
--- Discovery while its scalars and sound maps belong to tELS; tAFK's
--- `vehicleConfigs` belongs to Discovery and its `settings`/`sequences` to
--- tAFK; tDetector's `props` is its own while `soundWavMap` and
--- `installedSounds` belong to tlib.soundstore.
---
--- ⚠️ One scalar `version` for the whole document would therefore be a lie:
--- soundstore bumping its shape would make the consumer's version read as
--- newer-than-known and lock the consumer out of its own file. The owners
--- version INDEPENDENTLY, and each migrates only its own sections.
---
--- tAFK's existing top-level `version` number is the prior art and is a
--- DIFFERENT key on purpose: it already means "tAFK's shape", and converging it
--- is a per-resource migration rather than something this module may silently
--- reinterpret.
local SCHEMA_KEY = '__schema'

--- The document's three states, which `read()` deliberately cannot express.
---
--- `read()` answers an empty table for both `absent` and `unparseable`, which is
--- right for a reader and catastrophic for a seeder -- see the header. Nothing
--- but `ensure` needs this, so it stays internal.
---
--- @return string|nil raw      the bytes on disk, or nil when absent
--- @return string state        'absent' | 'ok' | 'unparseable'
--- @return table|nil doc       the decoded document, only when state is 'ok'
function Store:_probe()
    local ok, raw = pcall(LoadResourceFile, self.resource, self.file)
    if not ok or type(raw) ~= 'string' or raw == '' then return nil, 'absent' end

    local decoded, data = pcall(json.decode, raw)
    if not decoded or type(data) ~= 'table' then return raw, 'unparseable' end
    return raw, 'ok', data
end

--- The whole document, or an empty table.
--- @return table
function Store:read()
    -- The write-behind mirror, when there is one. Set only after `ensure`
    -- discovered that its own write did not reach the disk -- which on a server
    -- with `tlib_demo` set is the NORMAL case, because tlib.fs drops the write
    -- and reports success. Without this, a migration "succeeds" and then every
    -- reader for the rest of the session sees the pre-migration shape, which is
    -- the worst of the three possible outcomes: the code believes it is on the
    -- new shape and the data is on the old one.
    --
    -- tRadio reached the same arrangement independently and calls it the same
    -- thing: it "keeps a complete in-memory mirror of data.json and treats the
    -- file as write-behind".
    if self._mirror then return self._mirror end

    local _, state, data = self:_probe()
    if state == 'ok' then return data end
    if state == 'unparseable' then
        -- Once per store, not once per read: `section` is called from file
        -- scope by several consumers and a per-read message would be the same
        -- line four times at boot, which reads as four problems.
        if not self._warnedUnparseable then
            self._warnedUnparseable = true
            self._log(('%s is present but is not valid JSON — falling back to the '
                .. 'shipped configuration. The file has NOT been overwritten; fix or '
                .. 'delete it.'):format(self.file), self._levels.ERROR)
        end
    end
    return {}
end

--- One top-level section, or an empty table.
---
--- An empty table rather than nil, because every caller iterates the result
--- immediately.
--- @param name string
--- @return table
function Store:section(name)
    local value = self:read()[name]
    return type(value) == 'table' and value or {}
end

--- Why writes are refused, or nil when they are not.
---
--- Set by `ensure` and never cleared, because every reason it is set for is one
--- a restart has to resolve: the shape on disk is newer than this build, or the
--- file does not parse. tAFK's `writesLocked` is the same device and states the
--- principle it buys -- "a bad boot degrades to `runs on defaults, keeps your
--- file` rather than `runs on defaults, ate your file`".
--- @return string|nil
function Store:locked()
    return self._lock
end

--- Replace one or more top-level sections, leaving every other key alone.
---
--- @param sections table  { [sectionName] = value }
--- @return boolean ok     false when nothing reached the disk
function Store:write(sections)
    if type(sections) ~= 'table' then return false end

    -- ⛔ Before anything else, including the re-entrancy merge. A locked
    -- document must not accumulate a pending set either: replaying it later
    -- would be the same write, just delayed past the explanation.
    if self._lock then
        if not self._warnedLocked then
            self._warnedLocked = true
            self._log(('jsonstore: refusing every write to %s — %s')
                :format(self.file, self._lock), self._levels.ERROR)
        end
        return false
    end

    if self._saving then
        self._pending = self._pending or {}
        for name, value in pairs(sections) do self._pending[name] = value end
        return true
    end

    self._saving = true
    local wrote = false

    local ok, err = pcall(function()
        local data = self:read()
        for name, value in pairs(sections) do data[name] = value end

        local encOk, encoded = pcall(json.encode, data)
        if not encOk then
            self._log(('jsonstore: json.encode failed (%s) — %s NOT written')
                :format(tostring(encoded), self.file), self._levels.ERROR)
            return
        end

        -- Through tlib.fs rather than SaveResourceFile directly, for two
        -- reasons.
        --
        -- One: the native answers false rather than raising on FiveM for GTAV
        -- Enhanced, where it is refused for some resources outright, and
        -- tlib.fs falls back to THAT RESOURCE's own Node fs bridge -- its own,
        -- because FiveM's Node runtime sandboxes each resource to its own
        -- directory, so tLib cannot write this file on a consumer's behalf.
        -- `self.resource` is the consumer, never tLib, for that reason.
        --
        -- Two: tlib.fs consults demo mode. On a server with `tlib_demo` set the
        -- write is dropped and reported as a success, which is what keeps a
        -- demo box resetting on restart without this file knowing anything
        -- about it.
        --
        -- A failure the bridge cannot fix either is still said out loud, with
        -- its errno -- which names which of EACCES / EROFS / ENOSPC to actually
        -- fix. Swallowing it leaves an admin looking at an edit that vanishes on
        -- restart with nothing in the console to explain it.
        local didWrite, werr = tlib.fs.writeResourceFile(self.file, encoded, self.resource, self._log)
        if not didWrite then
            local names = {}
            for name in pairs(sections) do names[#names + 1] = tostring(name) end
            table.sort(names)
            self._log(('jsonstore: could not write %s — the "%s" section(s) will not '
                .. 'survive a restart. %s')
                :format(self.file, table.concat(names, '", "'), tostring(werr)),
                self._levels.ERROR)
            return
        end
        wrote = true
    end)

    if not ok then self._log('jsonstore: ' .. tostring(err), self._levels.ERROR) end

    self._saving = false

    if self._pending then
        local pending = self._pending
        self._pending = nil
        return self:write(pending) and wrote
    end

    return wrote
end

-- ── Seeding, versioning and migration ───────────────────────────────────────

--- Lock the document and say why, exactly once.
---
--- @return table result  the `ensure` result for this failure
function Store:_refuse(owner, action, reason, extra)
    self._lock = reason
    self._warnedLocked = true
    self._log(('jsonstore: %s — %s'):format(self.file, reason), self._levels.ERROR)

    local result = { action = action, reason = reason, owner = owner }
    for k, v in pairs(extra or {}) do result[k] = v end
    return result
end

--- The whole document written in one go, replacing it rather than merging.
---
--- ⚠️ Deliberately NOT `write()`. `write` is a read-modify-write that MERGES
--- the named sections, so it can add a key and change a key but it can never
--- remove one -- and a migration that declares `allowRemove` must be able to.
---
--- Safe only because `ensure` runs inside `open`, before the consumer's first
--- read, and nothing between here and the disk yields. Same NO-YIELD INVARIANT
--- tRadio and tCAD both write out at their own save paths.
---
--- @return boolean ok, string|nil err
function Store:_replace(doc)
    local encOk, encoded = pcall(json.encode, doc)
    if not encOk then return false, ('json.encode failed (%s)'):format(tostring(encoded)) end

    local didWrite, werr = tlib.fs.writeResourceFile(self.file, encoded, self.resource, self._log)
    if not didWrite then return false, tostring(werr) end
    return true
end

--- Set the write-behind mirror when a "successful" write did not reach the disk.
---
--- Verified by re-probing rather than trusted, because the one caller that
--- reports success without writing -- demo mode -- is indistinguishable from a
--- real write at the return value. See `read()` for why the mirror matters.
function Store:_mirrorIfDropped(doc, owner, version)
    local _, state, onDisk = self:_probe()
    local landed = state == 'ok' and type(onDisk) == 'table'
        and type(onDisk[SCHEMA_KEY]) == 'table'
        and onDisk[SCHEMA_KEY][owner] == version
    if landed then return false end

    self._mirror = doc
    self._log(('jsonstore: %s was not changed on disk (demo mode, or a write bridge that '
        .. 'reported success without writing) — this session runs on an in-memory copy of '
        .. 'the migrated document and the next start will migrate again. Migrations must be '
        .. 'idempotent for exactly this reason.'):format(self.file), self._levels.WARN)
    return true
end

--- Copy the file's raw bytes aside before the first migration touches it.
---
--- The BYTES, not a re-encode: the backup is then byte-identical to what the
--- owner had, which a round trip through `json.decode`/`json.encode` is not --
--- key order moves, an empty list becomes `{}`, and a number's spelling changes.
---
--- @return string|nil name, string|nil err
function Store:_backup(raw, fromVersion)
    local name = ('%s.v%s.bak'):format(self.file, tostring(fromVersion))
    local ok, err = tlib.fs.writeResourceFile(name, raw, self.resource, self._log)
    if not ok then return nil, tostring(err) end
    return name
end

--- Top-level key names of a document, sorted. For the never-delete check.
local function topLevelKeys(doc)
    local names = {}
    for name in pairs(doc) do names[#names + 1] = tostring(name) end
    table.sort(names)
    return names
end

--- Fill in top-level keys the document does not have, and ONLY those.
---
--- Per key and only into an ABSENT key, which is tRadio's rule and tELS's: a
--- partially hand-written data.json -- the documented workflow for an owner
--- whose host gives the server process no write access -- is COMPLETED rather
--- than overwritten.
---
--- ⚠️ It must never stamp the schema version. tAFK learned this the hard way and
--- wrote it down: "stamping the current version here is what stopped migrations
--- from ever running". A defaults pass that also stamps makes every legacy
--- document look current.
---
--- @return boolean changed
local function applyDefaults(doc, defaults)
    local changed = false
    for name, value in pairs(defaults) do
        if name ~= SCHEMA_KEY and doc[name] == nil then
            doc[name] = value
            changed = true
        end
    end
    return changed
end

--- Validate a schema declaration, loudly and at open time.
---
--- A malformed schema is a programming error in the consumer, so it raises
--- rather than locking: it cannot reach a customer without the resource failing
--- to start on the developer's own machine first.
local function checkSchema(schema)
    assert(type(schema) == 'table', 'jsonstore: schema must be a table')
    assert(type(schema.version) == 'number' and schema.version >= 0
        and schema.version == math.floor(schema.version),
        'jsonstore: schema.version must be a non-negative integer')
    assert(schema.defaults == nil or type(schema.defaults) == 'table'
        or type(schema.defaults) == 'function',
        'jsonstore: schema.defaults must be a table or a function returning one')
    assert(schema.migrations == nil or type(schema.migrations) == 'table',
        'jsonstore: schema.migrations must be a table keyed by the version it migrates FROM')
    assert(schema.owner == nil or (type(schema.owner) == 'string' and schema.owner ~= ''),
        'jsonstore: schema.owner must be a non-empty string')

    local assume = schema.assume or 0
    assert(type(assume) == 'number' and assume >= 0 and assume == math.floor(assume),
        'jsonstore: schema.assume must be a non-negative integer')
    assert(assume <= schema.version,
        'jsonstore: schema.assume may not exceed schema.version — an unstamped document '
        .. 'cannot already be ahead of the build reading it')

    -- Keyed by the version it migrates FROM, which is tAFK's existing
    -- convention and therefore the estate's. Keying by the target reads more
    -- naturally and is WRONG to adopt now: two spellings of the same table is
    -- how one of them ends up off by one.
    for from = assume, schema.version - 1 do
        local step = (schema.migrations or {})[from]
        assert(step ~= nil, ('jsonstore: schema.migrations has no step for version %d. '
            .. 'Every version from %d to %d needs one, keyed by the version it migrates '
            .. 'FROM. A missing step would otherwise be silently skipped and the document '
            .. 'would be stamped with a shape it does not have.'):format(from, assume, schema.version - 1))
        assert(type(step) == 'function' or (type(step) == 'table' and type(step.apply) == 'function'),
            ('jsonstore: schema.migrations[%d] must be a function, or a table with an '
            .. '`apply` function and an optional `allowRemove` list'):format(from))
    end
    return assume
end

--- Seed the document if absent, or migrate it forward if behind.
---
--- Called by `open` when `opts.schema` is given, and ONCE PER OWNER. The result
--- is cached so a second `open` carrying the same owner's schema hands back the
--- same verdict rather than re-deciding it — which is also what makes "a
--- migration never runs twice" true inside one server lifetime.
---
--- @return table result
---   action  'seeded' | 'current' | 'migrated' | 'refused' | 'unparseable'
---   owner   string       whose version this is
---   from    number|nil   version found on disk (nil when seeded)
---   to      number|nil   version now recorded
---   applied table|nil    the migration steps that ran, in order
---   backup  string|nil   where the pre-migration bytes went
---   reason  string|nil   why, when the action is a refusal
function Store:ensure(schema)
    assert(type(schema) == 'table', 'tlib.jsonstore: ensure needs a schema table')
    local owner = schema.owner or self.resource

    self._schemaResults = self._schemaResults or {}
    if self._schemaResults[owner] then return self._schemaResults[owner] end

    local result = self:_ensure(schema, owner)
    self._schemaResults[owner] = result
    return result
end

--- The body of `ensure`, minus the per-owner memoisation.
---
--- Split out so every failure branch can simply `return`: threading the cache
--- write through twelve early returns is how one of them ends up missing it, and
--- a missing one means the migration is re-decided on the next `open`.
function Store:_ensure(schema, owner)
    local assume = checkSchema(schema)
    local target = schema.version

    local raw, state, doc = self:_probe()

    -- ⚠️ When a mirror exists, IT is the document, not the file.
    --
    -- A second owner's `ensure` runs after the first has already seeded or
    -- migrated. Normally it re-reads the file and sees that work. In demo mode
    -- the file still holds the pre-migration bytes, so re-reading would hand
    -- owner two a stale document, and stamping it would bury owner one's
    -- migration — in memory, on the one configuration where memory is all
    -- there is.
    --
    -- `raw` is deliberately left nil: there is nothing on disk that differs, so
    -- there is nothing to back up, and the backup step below knows to skip
    -- rather than fail closed.
    if self._mirror then
        state, doc, raw = 'ok', self._mirror, nil
    end

    -- ── unparseable: do nothing at all ──────────────────────────────────────
    --
    -- Not a seed, not a migration, not a write. The file is the owner's to fix
    -- and it is still fixable; the moment anything here writes, it is not.
    if state == 'unparseable' then
        local result = self:_refuse(owner, 'unparseable',
            ('%s is present but is not valid JSON. It has NOT been changed and nothing was '
            .. 'seeded over it — a hand-edit that broke the JSON is repairable and a file '
            .. 'replaced by defaults is not. Fix or restore it, then restart the resource.')
            :format(self.file))

        -- Park a copy aside as well, when asked. tAFK does this and names the
        -- reason: an admin gets a file they can diff against whatever they
        -- reconstruct. It is a COPY -- the original is left exactly where it is.
        if schema.quarantine then
            local name = ('%s.corrupt.%d'):format(self.file, os.time())
            local ok = tlib.fs.writeResourceFile(name, raw, self.resource, self._log)
            if ok then
                result.quarantine = name
                self._log(('jsonstore: a copy of the unparseable %s was parked at %s')
                    :format(self.file, name), self._levels.WARN)
            end
        end

        return result
    end

    -- ── absent: this is first start ─────────────────────────────────────────
    if state == 'absent' then
        local defaults = schema.defaults
        if type(defaults) == 'function' then
            local ok, produced = pcall(defaults)
            if not ok then
                local result = self:_refuse(owner, 'refused',
                    ('schema.defaults raised (%s), so nothing could be seeded')
                        :format(tostring(produced)))
                return result
            end
            defaults = produced
        end
        if type(defaults) ~= 'table' then defaults = {} end

        local seed = {}
        for name, value in pairs(defaults) do
            if name ~= SCHEMA_KEY then seed[name] = value end
        end
        seed[SCHEMA_KEY] = { [owner] = target }

        local ok, err = self:_replace(seed)
        if not ok then
            -- NOT a lock. There is nothing on disk to protect, the consumer's
            -- own shipped configuration is still the live answer, and a server
            -- whose resource directory is read-only must still run. Said out
            -- loud so an owner is not left wondering why nothing persists.
            self._log(('jsonstore: %s does not exist and could not be created — %s. This '
                .. 'session runs on the shipped configuration and nothing will survive a '
                .. 'restart.'):format(self.file, tostring(err)), self._levels.ERROR)
            local result = { action = 'refused', owner = owner, to = target, reason = err }
            return result
        end

        self:_mirrorIfDropped(seed, owner, target)
        self._log(('jsonstore: created %s at schema v%d for "%s"')
            :format(self.file, target, owner), self._levels.INFO)
        local result = { action = 'seeded', owner = owner, to = target }
        return result
    end

    -- ── present and parseable ───────────────────────────────────────────────
    local stamps = doc[SCHEMA_KEY]
    if stamps ~= nil and type(stamps) ~= 'table' then
        local result = self:_refuse(owner, 'refused',
            ('"%s" in %s is a %s, not an object of owner-to-version. This module writes it '
            .. 'and nothing else should; refusing to touch the file rather than guess what '
            .. 'the shape on disk is.'):format(SCHEMA_KEY, self.file, type(stamps)))
        return result
    end

    local found = stamps and stamps[owner] or nil
    if found ~= nil and (type(found) ~= 'number' or found < 0 or found ~= math.floor(found)) then
        -- tAFK's rule, kept: a version that is not a number is not a version,
        -- and coercing it would pick a shape at random.
        local result = self:_refuse(owner, 'refused',
            ('"%s"."%s" in %s must be a non-negative integer (found %s, a %s). Refusing to '
            .. 'read a version this module did not write.')
            :format(SCHEMA_KEY, owner, self.file, tostring(found), type(found)))
        return result
    end
    found = found or assume

    if found > target then
        -- ⛔ The downgrade. See the header: readable, never written, never reset.
        local result = self:_refuse(owner, 'refused',
            ('%s records schema v%d for "%s" but this build only understands up to v%d. '
            .. 'That file was written by a NEWER version of this resource — most likely a '
            .. 'rollback, or a resource folder restored from a backup older than the data. '
            .. 'It is being READ as-is and every write is refused, because writing the old '
            .. 'shape over the new one would destroy data that is not broken. Upgrade the '
            .. 'resource again, or move the file aside yourself.')
            :format(self.file, found, owner, target),
            { from = found, to = target })
        return result
    end

    -- Defaults fill absent keys whatever the version is, including at the
    -- current one: a key added to `defaults` in a build that needed no shape
    -- change still has to arrive. It does NOT stamp -- see applyDefaults.
    local defaults = schema.defaults
    if type(defaults) == 'function' then
        local ok, produced = pcall(defaults)
        defaults = ok and produced or nil
        if not ok then
            self._log(('jsonstore: schema.defaults raised (%s) — no missing keys were '
                .. 'filled in %s'):format(tostring(produced), self.file), self._levels.ERROR)
        end
    end
    local filled = type(defaults) == 'table' and applyDefaults(doc, defaults) or false

    if found == target then
        if not filled then
            return { action = 'current', owner = owner, from = found, to = target }
        end
        -- Nothing structural changed, so no backup: the only difference is keys
        -- that were not there at all, and a backup of a document missing them
        -- recovers nothing a reinstall would not.
        local ok, err = self:_replace(doc)
        if not ok then
            self._log(('jsonstore: could not write the filled-in defaults to %s — %s')
                :format(self.file, tostring(err)), self._levels.ERROR)
        else
            self:_mirrorIfDropped(doc, owner, target)
        end
        return { action = 'current', owner = owner, from = found, to = target, filled = true }
    end

    -- ── behind: back up, then migrate forward one step at a time ────────────
    -- `raw == nil` here means the document came from the mirror, so the bytes on
    -- disk are not what is being migrated and copying them aside would archive
    -- the wrong thing under a reassuring name.
    local backup, berr = '(none — nothing is being written to disk)', nil
    if raw then backup, berr = self:_backup(raw, found) end
    if not backup then
        -- ⛔ No backup, no migration. An unrecoverable migration is worse than a
        -- stale document, and a disk that refuses the backup is a disk that may
        -- refuse the half-written result too.
        local result = self:_refuse(owner, 'refused',
            ('cannot migrate %s from v%d to v%d because the pre-migration backup could not '
            .. 'be written (%s). Nothing was changed. Fix the write permission on the '
            .. 'resource directory and restart; a migration with no way back is not worth '
            .. 'the risk.'):format(self.file, found, target, tostring(berr)),
            { from = found, to = target })
        return result
    end

    local before = topLevelKeys(doc)
    local applied = {}

    for from = found, target - 1 do
        local step = schema.migrations[from]
        local apply = type(step) == 'function' and step or step.apply
        local allowRemove = {}
        if type(step) == 'table' then
            for _, name in ipairs(step.allowRemove or {}) do allowRemove[name] = true end
        end

        local keysBefore = topLevelKeys(doc)
        local ok, err = pcall(apply, doc, { from = from, to = from + 1, owner = owner })
        if not ok then
            local result = self:_refuse(owner, 'refused',
                ('migration v%d → v%d of %s raised (%s). NOTHING was written; the file is '
                .. 'exactly as it was and a copy of it is at %s. Every write is refused '
                .. 'until this is fixed, so a later save cannot persist the half-migrated '
                .. 'document this left in memory.')
                    :format(from, from + 1, self.file, tostring(err), backup),
                { from = found, to = target, backup = backup, applied = applied })
            return result
        end

        -- ── Never delete. Enforced, not intended. ───────────────────────────
        local present = {}
        for _, name in ipairs(topLevelKeys(doc)) do present[name] = true end
        for _, name in ipairs(keysBefore) do
            if not present[name] and not allowRemove[name] then
                local result = self:_refuse(owner, 'refused',
                    ('migration v%d → v%d of %s removed the top-level key "%s", which it '
                    .. 'does not declare in `allowRemove`. NOTHING was written; the file is '
                    .. 'exactly as it was and a copy of it is at %s. If the removal is '
                    .. 'deliberate, name the key in that migration\'s `allowRemove` list so '
                    .. 'the one destructive act a migration can perform is visible in the '
                    .. 'diff. A rename is a copy plus an `allowRemove`.')
                        :format(from, from + 1, self.file, name, backup),
                    { from = found, to = target, backup = backup, applied = applied })
                return result
            end
        end

        applied[#applied + 1] = from
    end

    doc[SCHEMA_KEY] = type(doc[SCHEMA_KEY]) == 'table' and doc[SCHEMA_KEY] or {}
    doc[SCHEMA_KEY][owner] = target

    local ok, err = self:_replace(doc)
    if not ok then
        -- The migration itself worked and is in memory, but it is not on disk.
        -- Lock: a consumer that now writes one section in the NEW shape over a
        -- document still in the OLD shape produces a mixture neither version
        -- can read, and that mixture is what no backup helps with.
        local result = self:_refuse(owner, 'refused',
            ('%s was migrated from v%d to v%d in memory but could not be written (%s). '
            .. 'Every write is refused, because persisting one new-shaped section into a '
            .. 'document still in the old shape would leave a mixture neither version can '
            .. 'read. A copy of the original is at %s.')
                :format(self.file, found, target, tostring(err), backup),
            { from = found, to = target, backup = backup, applied = applied })
        return result
    end

    self:_mirrorIfDropped(doc, owner, target)
    self._log(('jsonstore: migrated %s from schema v%d to v%d for "%s" (%d step(s)); the '
        .. 'file as it was before is at %s')
        :format(self.file, found, target, owner, #applied, backup), self._levels.INFO)

    local result = {
        action = 'migrated', owner = owner, from = found, to = target,
        applied = applied, backup = backup, before = before,
    }
    return result
end

--- What `ensure` decided for one owner, or nil when that owner declared nothing.
--- @param owner string?  default the resource that opened the store
--- @return table|nil
function Store:schemaState(owner)
    return (self._schemaResults or {})[owner or self.resource]
end

--- The store for one resource's data file. Memoised: calling this twice with
--- the same file hands back the SAME store, which is what makes "one writer"
--- true rather than aspirational.
---
--- @param opts table
---   log       function  a tlib.logger.create handle. Required: every recovery
---                       branch below is silent without it, and a silent
---                       recovery is the failure this module exists to end.
---   file      string?   default 'data.json'
---   resource  string?   default the calling resource
---   schema    table?    seed-and-migrate declaration; see the header and
---                       `Store:ensure`. Applied once, on the open that carries
---                       it, whether or not that is the first open of the file.
--- @return table store
function JsonStore.open(opts)
    opts = opts or {}
    assert(type(opts.log) == 'function', 'tlib.jsonstore.open: opts.log is required')

    local resource = opts.resource or GetCurrentResourceName()
    local file = opts.file or 'data.json'
    local key = resource .. '|' .. file

    local store = open[key]
    if not store then
        store = setmetatable({
            resource = resource,
            file     = file,
            _log     = opts.log,
            _levels  = tlib.logger,
            _saving  = false,
            _pending = nil,
        }, Store)
        open[key] = store
    end

    -- Applied here rather than only on a first open, because the memoisation
    -- makes the ORDER of the opens an accident of load order: soundstore opens
    -- tDetector's document from tLib's own module, and whether that happens
    -- before or after sv_data.lua did is not something either file controls. A
    -- schema that only took effect on the first open would therefore work or
    -- not work depending on which chunk the manifest happened to list first.
    if opts.schema then store:ensure(opts.schema) end

    return store
end

--- Where the per-owner schema versions live. Published so a suite or a release
--- gate names it from here rather than carrying a second copy of the string.
JsonStore.SCHEMA_KEY = SCHEMA_KEY

--- Forget every memoised store. Tests only: a suite that drove one document and
--- then another would otherwise inherit the first one's in-flight state.
function JsonStore.reset()
    open = {}
end

return JsonStore
