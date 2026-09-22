-- Reconciles a stored registry of dropped-in asset files against what is
-- actually on disk.
--
--   local files, reason = tlib.assets.scan('layouts/sounds', { extensions = tlib.assets.AUDIO })
--   local list, changed = tlib.assets.reconcile(installedSounds, files)
--
--   -- or both at once, which refuses to prune when the folder cannot be read:
--   local list, changed, reason = tlib.assets.sync(installedSounds, 'layouts/sounds',
--                                                  { extensions = tlib.assets.AUDIO })
--
-- Only scan (and therefore sync) is server-only; it needs a directory listing,
-- which comes from tLib's Node bundle. reconcile is pure and runs anywhere.
--
-- This exists because every resource shipping an operator-droppable asset
-- folder wrote the same loop, and two of them wrote the same bug into it: they
-- adopted the reconciled list only when its *length* changed, so removing one
-- file and adding another in the same restart cancelled out and neither was
-- applied. Membership is what changed; the count is not the question.

local assets = {}

assets.AUDIO = { "wav", "ogg", "mp3" }

local function extensionSet(list)
    if not list then return nil end
    local set = {}
    for _, ext in ipairs(list) do
        if type(ext) == "string" then set[ext:lower()] = true end
    end
    return set
end

--- Strip the extension: `siren.wav` -> `siren`.
function assets.slug(filename)
    return tostring(filename):match("^(.+)%.[^%.]+$") or tostring(filename)
end

--- Filenames directly under `subdir`, sorted, or nil plus a reason.
---
--- nil is never an empty table, and the difference is load-bearing: reconcile
--- deletes anything the scan does not confirm, so a scan that failed and
--- reported "no files" rather than "I could not look" is indistinguishable
--- from the operator having deleted everything.
---
--- The pcalls stay deliberately. An export missing because tLib's bundle has
--- not registered yet must read as "I could not look", never as "empty".
--- @return string[]|nil, string|nil
function assets.scan(subdir, opts)
    opts = opts or {}
    local resourceName = opts.resource or GetCurrentResourceName()

    local ok, encoded = pcall(function()
        return exports.tLib:ScanResourceFiles(resourceName, subdir)
    end)
    if not ok or type(encoded) ~= "string" then
        return nil, "unavailable"
    end

    local decodeOk, result = pcall(json.decode, encoded)
    if not decodeOk or type(result) ~= "table" then
        return nil, "undecodable"
    end
    if not result.ok then
        return nil, type(result.reason) == "string" and result.reason or "unknown"
    end

    local names = result.entries
    if type(names) ~= "table" then return nil, "undecodable" end

    local allowed = extensionSet(opts.extensions)
    local files = {}
    for _, name in ipairs(names) do
        if type(name) == "string" then
            local ext = name:match("%.([^%.]+)$")
            if not allowed or (ext and allowed[ext:lower()]) then
                files[#files + 1] = name
            end
        end
    end
    table.sort(files)
    return files
end

--- Prune tracked records whose file is gone, append records for untracked
--- files, and report whether membership actually moved.
---
--- Retained records are carried through untouched and in their existing order,
--- so slugs, labels and any other consumer-owned fields on them survive; only
--- genuinely new files get a fresh record, from `opts.record` or the default
--- `{ filename = ..., slug = ... }`.
--- @return table, boolean
function assets.reconcile(tracked, diskFiles, opts)
    opts = opts or {}
    tracked = type(tracked) == "table" and tracked or {}
    diskFiles = type(diskFiles) == "table" and diskFiles or {}

    local onDisk = {}
    for _, filename in ipairs(diskFiles) do onDisk[filename] = true end

    local result, kept = {}, 0
    for _, record in ipairs(tracked) do
        if record and onDisk[record.filename] then
            result[#result + 1] = record
            kept = kept + 1
        end
    end

    local isTracked = {}
    for _, record in ipairs(result) do isTracked[record.filename] = true end

    local added = 0
    for _, filename in ipairs(diskFiles) do
        if not isTracked[filename] then
            result[#result + 1] = opts.record and opts.record(filename)
                or { filename = filename, slug = assets.slug(filename) }
            added = added + 1
        end
    end

    -- Membership, not length. Retained records keep their order and identity,
    -- so the list is unchanged exactly when nothing was dropped and nothing
    -- added — a swap of one file for another moves neither count but is very
    -- much a change.
    return result, kept ~= #tracked or added > 0
end

--- scan + reconcile, refusing to prune when the folder could not be read.
---
--- On a scan failure the caller's existing list is returned unchanged with
--- `changed = false` and the reason, so a boot where tLib started late cannot
--- wipe a registry off disk.
--- @return table, boolean, string|nil
function assets.sync(tracked, subdir, opts)
    local files, reason = assets.scan(subdir, opts)
    if not files then return tracked, false, reason end
    local result, changed = assets.reconcile(tracked, files, opts)
    return result, changed
end

return assets
