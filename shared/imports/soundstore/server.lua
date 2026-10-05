-- The data.json-backed sound registry every t* device panel keeps: which tone
-- keys point at which .wav, which .wav files are installed, and the boot-time
-- reconciliation that keeps both honest against the disk.
--
--   local store = tlib.soundstore.open({
--       keys = DEFAULT_SOUND_KEYS,
--       log  = tlib.logger.create('tRadar'),
--   })
--   store:config()                     -- the panel payload
--   store:setMapping('BEEP', 'x.wav')  -- admin edits; persists
--   store:install(slug)                -- marketplace install; returns a conflict slug
--
-- Server-only: it writes a resource file and asks tlib.assets to list a
-- directory, and neither works from a client VM.
--
-- This exists because tDetector and tRadar carried the same 150 lines twice,
-- including the ordering fix below, which was paid for once in production and
-- would have had to be found twice. The reconciliation MUST run before the
-- phantom-mapping pass:
--
--   boot 1: the folder scan comes back empty (a broken or sandboxed directory
--           listing looks exactly like "no files"), so the reconcile empties
--           installedSounds and writes that.
--   boot 2: installedSounds is now {}, so the phantom pass decides every
--           default mapping points at an uninstalled file, deletes them, and
--           writes the empty map.
--
-- From then on the panel serves an empty map to every client forever -- a
-- silent device, and restarting does not help, because nothing but the admin
-- panel ever writes the map back. Reconciling first means the phantom pass
-- judges mappings against what is actually on disk, which is what it always
-- meant to do. The self-heal step is the other half: it puts a default mapping
-- back once its file is confirmed, so a registry already destroyed by the
-- cascade recovers on the next boot instead of staying dead.

local soundstore = {}

local Store = {}
Store.__index = Store

--- Persist the tone map and the installed-sound list.
---
--- Through tlib.jsonstore, which is THE writer of this document. It used to be
--- one of two: this module owned `soundWavMap` and `installedSounds`, the
--- consumer's own sv_data.lua owned every other section, and the two were safe
--- together only because both were read-modify-write over the whole file with
--- no yield in between. That was true, and it was an invariant restated in
--- prose in two places and tested in two more -- the kind of true a later
--- "simplification" to a plain write destroys silently.
---
--- `jsonstore.open` memoises per resource-and-file, so this store and the
--- consumer's are the SAME object: one re-entrancy flag, one queue. The
--- invariant is removed rather than restated.
function Store:save()
    self._store:write({
        soundWavMap     = self.toneWavMap,
        installedSounds = self.installedSounds,
    })
end

--- The payload the settings panel and every client broadcast carries.
--- @return table
function Store:config()
    return {
        soundWavMap      = self.toneWavMap,
        installedSounds  = self.installedSounds,
        defaultSoundKeys = self.keys,
    }
end

--- Point a tone key at a file, or clear it when the filename is empty.
---
--- Returns false without saving for input that is not a usable key, so a
--- malformed net event cannot write junk into the map.
--- @return boolean
function Store:setMapping(key, filename)
    if type(key) ~= "string" or key == "" then return false end
    if type(filename) == "string" and filename ~= "" then
        self.toneWavMap[key] = filename
    else
        self.toneWavMap[key] = nil
    end
    self:save()
    return true
end

--- Drop an installed sound by filename and clear every tone that used it.
---
--- The map is swept too, because a mapping left pointing at a deleted file 404s
--- in the NUI rather than falling back.
--- @return boolean
function Store:removeSound(filename)
    if type(filename) ~= "string" or filename == "" then return false end
    for i, s in ipairs(self.installedSounds) do
        if s.filename == filename then
            table.remove(self.installedSounds, i)
            break
        end
    end
    for key, fname in pairs(self.toneWavMap) do
        if fname == filename then self.toneWavMap[key] = nil end
    end
    self:save()
    return true
end

--- Record a marketplace-installed sound.
--- @return string|nil the slug already claiming this filename, if any
function Store:install(slug)
    local conflict = tlib.marketplace.upsertSound(self.installedSounds, slug)
    self:save()
    return conflict
end

--- Forget a marketplace-uninstalled sound.
--- @return string|nil the filename that was removed, if it was tracked
function Store:uninstall(slug)
    local removedFilename = tlib.marketplace.removeSound(self.installedSounds, self.toneWavMap, slug)
    if removedFilename then
        self._log("cleared toneWavMap entries for '" .. removedFilename .. "' (sound deleted)", self._levels.INFO)
    end
    self:save()
    return removedFilename
end

--- Load the registry and reconcile it against the disk. See the header for why
--- the three steps run in this order.
---
--- `opts.keys`    the tone keys this device knows; their lowercased names plus
---                `.wav` are the shipped defaults the self-heal restores.
--- `opts.log`     a tlib.logger.create handle. Required: every branch below is
---                destructive or corrective, and one that happens silently is
---                the failure this module exists to end.
--- `opts.phantom` `(key, filename) -> boolean`, "this mapping was auto-seeded
---                and must be confirmed on disk". Defaults to the shipped-name
---                rule; a consumer with its own history of seeded names passes
---                its own. Only mappings it accepts are ever deleted.
--- `opts.dir`, `opts.file`, `opts.resource` override the usual locations.
--- @return table
function soundstore.open(opts)
    opts = opts or {}
    local resource = opts.resource or GetCurrentResourceName()
    local dir      = opts.dir or "layouts/sounds"
    local keys     = opts.keys or {}
    local log      = opts.log
    if type(log) ~= "function" then
        error("tlib.soundstore.open: opts.log is required (pass tlib.logger.create('<resource>'))", 2)
    end

    local keySet = {}
    for _, key in ipairs(keys) do keySet[key] = true end

    -- Only a mapping that still reads as the shipped default for its own key is
    -- treated as auto-seeded. A filename the admin chose is theirs, and a key
    -- this device does not know is none of our business.
    local phantom = opts.phantom or function(key, filename)
        return keySet[key] == true and filename == key:lower() .. ".wav"
    end

    local levels = tlib.logger
    local file  = opts.file or "data.json"

    -- The one writer of this document; see Store:save. Reading the WHOLE file
    -- rather than our two keys is still the rule, because the consumer keeps
    -- unrelated sections in it.
    local store = tlib.jsonstore.open({ resource = resource, file = file, log = log })
    local data = store:read()

    local self = setmetatable({
        resource        = resource,
        file            = file,
        dir             = dir,
        keys            = keys,
        toneWavMap      = type(data.soundWavMap) == "table" and data.soundWavMap or {},
        installedSounds = type(data.installedSounds) == "table" and data.installedSounds or {},
        _log            = log,
        _levels         = levels,
        _store          = store,
    }, Store)

    local dirty = tlib.marketplace.migrateBuiltinSlugs(self.installedSounds)

    local diskFiles, scanFailure = tlib.assets.scan(dir, {
        resource   = resource,
        extensions = tlib.assets.AUDIO,
    })

    -- An empty result is treated as a failed scan, NOT as an empty folder.
    -- Every step below is destructive, and there is no benign reading of "this
    -- resource ships sounds and I can see none of them": the honest options are
    -- "the directory could not be read" and "the operator deleted every sound
    -- file", and only one of those is worth losing data over. Skipping costs
    -- nothing -- the entries stay as they are until a scan succeeds.
    local scanUsable = diskFiles ~= nil and #diskFiles > 0

    -- nil (not an empty table) whenever the scan is unusable, so the self-heal
    -- below can tell "this file is not on disk" from "I cannot see the disk".
    local diskSet = nil
    if scanUsable then
        diskSet = {}
        for _, filename in ipairs(diskFiles) do diskSet[filename] = true end
    end

    if not scanUsable then
        -- The two readings of "unusable" are NOT the same event, and saying so
        -- is the whole of this branch. `diskFiles ~= nil` means the listing
        -- succeeded and held no audio — which is the shipped state of any device
        -- that does not bundle tones of its own (tRadar says exactly that in
        -- layouts/sounds/README.md), so it is normal and gets INFO. Only a scan
        -- that genuinely could not look is a WARN. They were one line for a
        -- while, and the result was a boot-time warning on a healthy server
        -- pointing at a directory that was fine, which is how a real one stops
        -- being read.
        --
        -- The BEHAVIOUR is identical in both cases and must stay that way: an
        -- empty listing is still treated as a failed scan for every destructive
        -- step below, because "this resource ships sounds and I can see none of
        -- them" has no benign reading, and skipping costs nothing.
        if diskFiles ~= nil then
            log(dir .. " holds no audio files — nothing to reconcile this boot. " ..
                "Drop tones in that folder, or install them from the marketplace, " ..
                "to map them in the panel.", levels.INFO)
        else
            log(dir .. " could not be enumerated (" .. (scanFailure or "unknown") ..
                ") — skipping sound reconciliation this boot so the installed-sound " ..
                "list and tone mappings are preserved", levels.WARN)
        end
    else
        -- 1. Reconcile installedSounds against disk. `changed` is membership,
        --    not length: swapping one sound for another leaves the count alone
        --    and used to discard the whole reconciliation.
        local cleaned, changed = tlib.assets.reconcile(self.installedSounds, diskFiles)
        if changed then
            self.installedSounds = cleaned
            dirty = true
        end

        -- 2. Clear auto-seeded mappings whose file is not there; those 404 in
        --    the NUI. installedSounds now mirrors the disk, so "not installed"
        --    here really does mean "not present".
        for key, fname in pairs(self.toneWavMap) do
            if phantom(key, fname) and not diskSet[fname] then
                self.toneWavMap[key] = nil
                dirty = true
            end
        end
    end

    -- 3. Self-heal the default mappings. Strictly evidence-based: a mapping is
    --    only written once the file is confirmed, so this cannot recreate the
    --    phantom entries step 2 exists to remove. When the scan is unusable we
    --    confirm with a direct read instead, because LoadResourceFile still
    --    works in the environments where a directory listing does not -- which
    --    is exactly the case that needs healing most.
    for _, key in ipairs(keys) do
        if not self.toneWavMap[key] then
            local filename = key:lower() .. ".wav"
            local present
            if diskSet then
                present = diskSet[filename] == true
            else
                local ok, raw = pcall(LoadResourceFile, resource, dir .. "/" .. filename)
                present = ok and type(raw) == "string" and raw ~= ""
            end
            if present then
                self.toneWavMap[key] = filename
                dirty = true
                log("re-seeded missing default sound mapping " .. key .. " -> " .. filename, levels.INFO)
            end
        end
    end

    if dirty then self:save() end

    return self
end

return soundstore
