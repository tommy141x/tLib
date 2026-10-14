--[[
    tLib — the one writer of a resource's JSON data file (server)

        local store = tlib.jsonstore.open({ log = tlib.logger.create('tDetector') })

        store:section('props')            -- the section, or an empty table
        store:write({ props = placements })

    Design notes: docs/internal/jsonstore.md

]]

local JsonStore = {}

local Store = {}
-- Forward declaration so SCHEMA_KEY below can be published on the module table
-- without the release gate having to hard-code the string a second time.
Store.__index = Store

--- resource .. '|' .. file -> Store. The whole point: one writer per document.
local open = {}

--- Where the per-owner schema versions live inside the document. An object
--- keyed by owner, not a scalar: these documents are co-owned, and one version
--- for the whole thing would let soundstore lock the consumer out of its own
--- file. tAFK's top-level `version` is a different key on purpose.
local SCHEMA_KEY = '__schema'

--- The document's three states, which `read()` deliberately cannot express.
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
    if self._mirror then return self._mirror end

    local _, state, data = self:_probe()
    if state == 'ok' then return data end
    if state == 'unparseable' then
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
--- @param name string
--- @return table
function Store:section(name)
    local value = self:read()[name]
    return type(value) == 'table' and value or {}
end

--- Why writes are refused, or nil when they are not.
---
--- @return string|nil
function Store:locked()
    return self._lock
end

--- Replace one or more top-level sections, leaving every other key alone.
--- Refused once the document is locked, before the re-entrancy merge: a locked
--- document must not accumulate a pending set either.
---
--- @param sections table  { [sectionName] = value }
--- @return boolean ok     false when nothing reached the disk
function Store:write(sections)
    if type(sections) ~= 'table' then return false end

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

    local startedAt = (GetGameTimer and GetGameTimer()) or 0

    local ok, err = pcall(function()
        local data = self:read()
        for name, value in pairs(sections) do data[name] = value end

        local encOk, encoded = pcall(json.encode, data)
        if not encOk then
            self._log(('jsonstore: json.encode failed (%s) — %s NOT written')
                :format(tostring(encoded), self.file), self._levels.ERROR)
            return
        end

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

    tlib.telemetry.record('jsonstore:write', 150, ((GetGameTimer and GetGameTimer()) or 0) - startedAt)

    self._saving = false

    if self._pending then
        local pending = self._pending
        self._pending = nil
        return self:write(pending) and wrote
    end

    return wrote
end

-- Seeding, versioning and migration

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
--- Deliberately NOT `write()`, which merges and so can never remove a key --
--- which a migration declaring `allowRemove` must be able to do. Safe only
--- because `ensure` runs inside `open` and nothing here yields.
---
--- @return boolean ok, string|nil err
function Store:_replace(doc)
    local encOk, encoded = pcall(json.encode, doc)
    if not encOk then return false, ('json.encode failed (%s)'):format(tostring(encoded)) end

    local didWrite, werr = tlib.fs.writeResourceFile(self.file, encoded, self.resource, self._log)
    if not didWrite then return false, tostring(werr) end
    return true
end

--- Set the write-behind mirror when a "successful" write did not reach the disk
--- -- the normal case under `tlib_demo`. Verified by re-probing rather than
--- trusted, because a dropped write is indistinguishable from a real one at the
--- return value.
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

--- Copy the file's raw bytes aside before the first migration touches it. The
--- BYTES, not a re-encode: a decode/encode round trip moves key order, turns an
--- empty list into `{}` and respells numbers.
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

--- Fill in top-level keys the document does not have, and ONLY those, so a
--- partly hand-written data.json is completed rather than overwritten. It must
--- never stamp the schema version: tAFK found that stamping here is what stopped
--- migrations from ever running.
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

--- Validate a schema declaration, loudly and at open time. Raises rather than
--- locking: a malformed schema is a programming error in the consumer and cannot
--- reach a customer without failing on the developer's own machine first.
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

--- Seed the document if absent, or migrate it forward if behind. Called by
--- `open` when `opts.schema` is given, and once per owner; the result is cached
--- so a second `open` hands back the same verdict rather than re-deciding it.
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

--- The body of `ensure`, minus the per-owner memoisation. Split out so every
--- failure branch can simply `return`: threading the cache write through twelve
--- early returns is how one of them ends up missing it.
function Store:_ensure(schema, owner)
    local assume = checkSchema(schema)
    local target = schema.version

    local raw, state, doc = self:_probe()

    if self._mirror then
        state, doc, raw = 'ok', self._mirror, nil
    end

    if state == 'unparseable' then
        local result = self:_refuse(owner, 'unparseable',
            ('%s is present but is not valid JSON. It has NOT been changed and nothing was '
            .. 'seeded over it — a hand-edit that broke the JSON is repairable and a file '
            .. 'replaced by defaults is not. Fix or restore it, then restart the resource.')
            :format(self.file))

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

    -- absent: this is first start
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

    -- present and parseable
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
        local result = self:_refuse(owner, 'refused',
            ('"%s"."%s" in %s must be a non-negative integer (found %s, a %s). Refusing to '
            .. 'read a version this module did not write.')
            :format(SCHEMA_KEY, owner, self.file, tostring(found), type(found)))
        return result
    end
    found = found or assume

    if found > target then
        -- The downgrade. See the header: readable, never written, never reset.
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
        local ok, err = self:_replace(doc)
        if not ok then
            self._log(('jsonstore: could not write the filled-in defaults to %s — %s')
                :format(self.file, tostring(err)), self._levels.ERROR)
        else
            self:_mirrorIfDropped(doc, owner, target)
        end
        return { action = 'current', owner = owner, from = found, to = target, filled = true }
    end

    -- behind: back up, then migrate forward one step at a time
    local backup, berr = '(none — nothing is being written to disk)', nil
    if raw then backup, berr = self:_backup(raw, found) end
    if not backup then
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

        -- Never delete. Enforced, not intended.
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

--- The store for one resource's data file. Memoised: calling this twice with the
--- same file hands back the SAME store, which is what makes "one writer" true
--- rather than aspirational. See docs/internal/jsonstore.md.
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

    if opts.schema then store:ensure(opts.schema) end

    return store
end

--- Published so a suite or a release gate names it from here rather than
--- carrying a second copy of the string.
JsonStore.SCHEMA_KEY = SCHEMA_KEY

--- Forget every memoised store. Tests only.
function JsonStore.reset()
    open = {}
end

return JsonStore
