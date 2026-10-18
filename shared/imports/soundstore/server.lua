-- The data.json-backed sound registry every t* device panel keeps: which tone
-- keys point at which .wav, which .wav files are installed, and the boot-time
-- reconciliation that keeps both honest against the disk.
--
--
-- Server-only: it writes a resource file and asks tlib.assets to list a
-- directory, and neither works from a client VM.
--
-- THE RECONCILIATION MUST RUN BEFORE THE PHANTOM-MAPPING PASS. An empty folder
-- scan (a sandboxed listing looks exactly like "no files") otherwise empties
-- installedSounds on boot 1, and on boot 2 the phantom pass reads that as "every
-- default mapping points at an uninstalled file" and deletes the map. Nothing
-- but the admin panel ever writes it back, so the device is silent forever. The
-- self-heal step is the other half: it restores a default mapping once its file
-- is confirmed, so a registry already destroyed recovers on the next boot.
--

local soundstore = {}

local Store = {}
Store.__index = Store

--- Persist the tone map and the installed-sound list through tlib.jsonstore,
--- which is THE writer of this document. `jsonstore.open` memoises per
--- resource-and-file, so this store and the consumer's are the SAME object: one
--- re-entrancy flag, one queue, and no two-writer invariant to restate.
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

--- Drop an installed sound by filename and clear every tone that used it: a
--- mapping left pointing at a deleted file 404s in the NUI rather than falling
--- back. Through `tlib.marketplace.forgetSoundFile`, which is the one sweep --
--- it was extracted because the same eight lines existed in five other places.
--- @return boolean
function Store:removeSound(filename)
    if type(filename) ~= "string" or filename == "" then return false end
    for i, s in ipairs(self.installedSounds) do
        if s.filename == filename then
            table.remove(self.installedSounds, i)
            break
        end
    end
    tlib.marketplace.forgetSoundFile(filename, self.toneWavMap)
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
    local phantom = opts.phantom or function(key, filename)
        return keySet[key] == true and filename == key:lower() .. ".wav"
    end

    local levels = tlib.logger
    local file  = opts.file or "data.json"

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

    local dirty = false

    local diskFiles, scanFailure = tlib.assets.scan(dir, {
        resource   = resource,
        extensions = tlib.assets.AUDIO,
    })

    -- An empty result is treated as a failed scan, NOT as an empty folder.
    local scanUsable = diskFiles ~= nil and #diskFiles > 0

    -- nil (not an empty table) whenever the scan is unusable, so the self-heal
    -- below can tell "this file is not on disk" from "I cannot see the disk".
    local diskSet = nil
    if scanUsable then
        diskSet = {}
        for _, filename in ipairs(diskFiles) do diskSet[filename] = true end
    end

    if not scanUsable then
        if diskFiles ~= nil then
            -- DEBUG, not INFO: a device that ships no tones of its own has an
            -- empty folder on every boot of a perfectly healthy server, so this
            -- is a non-event. The unreadable-folder case below stays loud.
            log(dir .. " holds no audio files — nothing to reconcile this boot.",
                levels.DEBUG)
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
    --    only written once the file is confirmed, so it cannot recreate the
    --    phantom entries step 2 removes. When the scan is unusable, confirm with
    --    a direct read -- LoadResourceFile still works where a listing does not.
    for _, key in ipairs(keys) do
        if not self.toneWavMap[key] then
            -- A default sound's file MUST be named in lowercase. This is an
            -- invariant, not a convenience: `diskSet` is keyed by the real
            -- directory entry, so a shipped `KA_BAND.wav` is simply never found
            -- by this lookup on either platform. The fallback below is worse
            -- than that -- `LoadResourceFile` opens case-insensitively on
            -- Windows and case-sensitively on Linux, so a capitalised default
            -- would re-seed on a dev box and silently not re-seed on a Linux
            -- server. Lowercase the file, do not "fix" this by folding case.
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
                -- DEBUG: one line per tone, and a first boot re-seeds them all.
                log("re-seeded missing default sound mapping " .. key .. " -> " .. filename, levels.DEBUG)
            end
        end
    end

    if dirty then self:save() end

    return self
end

return soundstore
