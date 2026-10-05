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
]]

local JsonStore = {}

local Store = {}
Store.__index = Store

--- resource .. '|' .. file -> Store. The whole point: one writer per document.
local open = {}

--- The whole document, or an empty table.
--- @return table
function Store:read()
    local ok, raw = pcall(LoadResourceFile, self.resource, self.file)
    if not ok or type(raw) ~= 'string' or raw == '' then return {} end

    local decoded, data = pcall(json.decode, raw)
    if not decoded or type(data) ~= 'table' then
        -- Once per store, not once per read: `section` is called from file
        -- scope by several consumers and a per-read message would be the same
        -- line four times at boot, which reads as four problems.
        if not self._warnedUnparseable then
            self._warnedUnparseable = true
            self._log(('%s is present but is not valid JSON — falling back to the '
                .. 'shipped configuration. The file has NOT been overwritten; fix or '
                .. 'delete it.'):format(self.file), self._levels.ERROR)
        end
        return {}
    end
    return data
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

--- Replace one or more top-level sections, leaving every other key alone.
---
--- @param sections table  { [sectionName] = value }
--- @return boolean ok     false when nothing reached the disk
function Store:write(sections)
    if type(sections) ~= 'table' then return false end

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
--- @return table store
function JsonStore.open(opts)
    opts = opts or {}
    assert(type(opts.log) == 'function', 'tlib.jsonstore.open: opts.log is required')

    local resource = opts.resource or GetCurrentResourceName()
    local file = opts.file or 'data.json'
    local key = resource .. '|' .. file

    local store = open[key]
    if store then return store end

    store = setmetatable({
        resource = resource,
        file     = file,
        _log     = opts.log,
        _levels  = tlib.logger,
        _saving  = false,
        _pending = nil,
    }, Store)

    open[key] = store
    return store
end

--- Forget every memoised store. Tests only: a suite that drove one document and
--- then another would otherwise inherit the first one's in-flight state.
function JsonStore.reset()
    open = {}
end

return JsonStore
