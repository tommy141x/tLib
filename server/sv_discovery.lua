-- Scans resources for tagged configs, loads and saves them, resolves hash↔name
-- aliases, edits manifests and picks up resources that start late.

local log = Logger.create('tLib/discovery')

Discovery = {}

-- The resource whose VM issues the file-writing natives below. Every write in
-- this file runs from tLib's runtime regardless of which resource asked, since
-- Discovery.create is reached across an export boundary.
local TLIB_RESOURCE = _TLIB_IS_FIVEM and GetCurrentResourceName() or 'tLib'

-- No server.cfg line lifts the cross-resource write refusal -- `add_filesystem_
-- permission tLib write *` sat in server.cfg across many restarts and writes
-- were still refused. The sandbox objects to WHICH resource is writing, not to
-- a missing permission: FiveM's Node runtime confines each resource to its own
-- directory. Cross-resource writes ARE possible though (see _saveFile): the
-- write has to originate in the target, via the target's own `WriteResourceFile`
-- export. Only a target with no server bundle at all (a plain vehicle asset
-- pack) is genuinely unwritable -- STAGING covers that case (stagingPath/_stageFile).

-- Where a refused export leaves the file it could not deliver.
--
-- tLib's own directory is the one place a write from tLib's VM is ALWAYS
-- allowed, so it is the default and the fallback. A consumer that has its own
-- Node fs bridge can take delivery itself instead -- see `stagingResource` /
-- `stagingDir` on Discovery.create -- which keeps a product's exports inside
-- that product rather than in the shared library's directory.
local function stagingPath(dir, targetResource, targetPath)
    return tostring(dir) .. tostring(targetResource) .. '/' .. tostring(targetPath)
end

local function manifestLineFor(metadataKey, targetPath)
    return tostring(metadataKey) .. " '" .. tostring(targetPath) .. "'"
end

local function _loadFile(resource, path)
    if _TLIB_IS_FIVEM then
        return LoadResourceFile(resource, path)
    else
        log('_loadFile: host has no file-read API (resource=' .. tostring(resource) .. ' path=' .. tostring(path) .. ')', 3)
        return nil
    end
end

--- A resource's JSON file, decoded. `json.decode` RAISES on text that is not JSON -- a hand
--- edit with a stray comma, a write cut short -- and these are files other people edit, so
--- nothing in this file calls it bare.
---
--- `doc, state, detail`:
---   doc, 'ok'              the decoded object
---   nil, 'empty', kind     absent or blank (kind nil), or valid JSON that is not an object
---                          (kind is its Lua type; 'nil' for a JSON null)
---   nil, 'corrupt', why    present and unparseable; never written over, see readForRewrite
local function readJson(resource, path)
    local raw = _loadFile(resource, path)
    if not raw or raw == "" then return nil, 'empty' end
    local ok, decoded = pcall(json.decode, raw)
    if not ok then return nil, 'corrupt', tostring(decoded) end
    if type(decoded) ~= "table" then
        return nil, 'empty', type(decoded)
    end
    return decoded, 'ok'
end

--- The object in a file about to be REWRITTEN with one entry changed, or nil plus why it
--- must not be. An absent file is rewritten from nothing. An unparseable one is left alone:
--- a hand edit that broke the JSON is repairable, a file replaced by one model is not.
local function readForRewrite(resource, path)
    local doc, state, detail = readJson(resource, path)
    if state == 'corrupt' then
        return nil, tostring(resource) .. "/" .. tostring(path) .. " is not valid JSON ("
            .. tostring(detail) .. "). It has NOT been changed; fix or delete it."
    end
    return doc or {}
end

-- Measured from one resource's VM:
--   SaveResourceFile(<own resource>,   …) → 1
--   SaveResourceFile(<other resource>, …) → false        -- sandbox refusal
--   SaveResourceFile(<unknown resource>,…) → THROWS       -- "Resource X not found."
--   LoadResourceFile(<anything>,       …) → works         -- reads are unrestricted
-- Three distinguishable outcomes; the return value below is the contract so a
-- caller can't report success over a silently discarded write.
--
-- `ok, err, kind` where `kind` is:
--   'denied'  the sandbox refused a cross-resource write (the actionable one)
--   'missing' the target resource does not exist (the native raised)
--   'nohost'  not running on FiveM at all
local function _saveFile(resource, path, content)
    if not _TLIB_IS_FIVEM then
        local err = 'host has no file-write API (resource=' .. tostring(resource) .. ' path=' .. tostring(path) .. ')'
        log('_saveFile: ' .. err, 3)
        return false, err, 'nohost'
    end
    -- pcall because an unknown target resource RAISES rather than returning
    -- false, and that error unwinds through every caller below.
    local called, res = pcall(SaveResourceFile, resource, path, content, -1)
    if not called then
        return false, tostring(res), 'missing'
    end
    if res ~= false and res ~= nil and res ~= 0 then
        return true
    end

    -- Cross-resource writes work by having the write originate IN the target:
    -- `exports[resource]:WriteResourceFile`, not `exports[tLib]`. Every resource
    -- bundling tLib's shared/ts calls `registerWriteResourceFile()` in its own
    -- server/main.ts.
    local bridged, bridgeRes = pcall(function()
        return exports[resource]:WriteResourceFile(resource, path, content)
    end)
    if bridged and bridgeRes == true then return true end

    -- A string is the bridge's own error (an errno, or its EPERM refusal); any
    -- other shape, or a raise, means the target has no bridge to ask.
    if bridged and type(bridgeRes) == 'string' and bridgeRes ~= '' then
        return false, bridgeRes, 'denied'
    end

    return false,
        "'" .. tostring(resource) .. "' refused the write to '" .. tostring(path)
        .. "' and has no Node fs bridge of its own to fall back on",
        'denied'
end

-- ServerSettings writes a consumer's file from this VM too, and must not grow a second
-- copy of the three-outcome contract above.
Discovery.saveFile = _saveFile
Discovery.readJson = readJson

--- Write a staged file into `resource`, falling back to tLib.
---
--- Goes through the Node export rather than SaveResourceFile because it
--- creates missing parent directories; the staging tree is nested.
---
--- The fallback is not belt-and-braces: a write from tLib's VM into another
--- resource only lands if that resource registered its own bridge, and a
--- consumer configured for self-staging that somehow has not is still owed the
--- file. Losing a refused export because its STAGING was also refused would
--- discard the one copy the customer has.
local function _stageFile(writer, writerResource, relPath, content)
    if not _TLIB_IS_FIVEM then
        return false, 'host has no file-write API'
    end

    -- The consumer's own writer, when it supplied one. A Lua function passed
    -- through CreateDiscovery runs in the VM that DEFINED it, so this write
    -- originates inside the consumer -- which is the only thing the sandbox
    -- cares about, and the reason no `add_filesystem_permission` is involved.
    --
    -- Calling the consumer's fs export from here instead would not work and
    -- should not: tLS guards its bridge on the invoking resource precisely so
    -- that no other resource can use it to write arbitrary files.
    if writer then
        local called, res, werr = pcall(writer, relPath, content)
        if called and res == true then return true, nil, writerResource end
        local why = called and (werr or 'the consumer writer declined') or tostring(res)
        -- Fall through to tLib rather than lose the file: a refused export whose
        -- staging is also refused leaves the customer with no copy at all.
        local fb, fbErr = pcall(function()
            return exports[TLIB_RESOURCE]:WriteResourceFile(TLIB_RESOURCE, relPath, content)
        end)
        if fb and fbErr == true then return true, nil, TLIB_RESOURCE end
        return false, tostring(why) .. '; tLib fallback also failed: ' .. tostring(fbErr)
    end

    local called, res = pcall(function()
        return exports[TLIB_RESOURCE]:WriteResourceFile(TLIB_RESOURCE, relPath, content)
    end)
    if not called then return false, tostring(res) end
    -- WriteResourceFile answers `true`, or a string describing the failure.
    if res ~= true then return false, tostring(res) end
    return true, nil, TLIB_RESOURCE
end

local function _getResourceMeta(resource, key)
    if _TLIB_IS_FIVEM then
        return GetResourceMetadata(resource, key, 0)
    else
        return nil
    end
end

local function _getResourceCount()
    if _TLIB_IS_FIVEM then
        return GetNumResources()
    else
        return 0
    end
end

local function _getResourceAtIndex(i)
    if _TLIB_IS_FIVEM then
        return GetResourceByFindIndex(i)
    else
        return nil
    end
end

local function _getResourceState(resource)
    if _TLIB_IS_FIVEM then
        return GetResourceState(resource)
    else
        return 'unknown'
    end
end

local function _hashKey(key)
    if _TLIB_IS_FIVEM then
        return GetHashKey(key)
    else
        return key
    end
end

local function _chatMessage(src, tag, message)
    if _TLIB_IS_FIVEM then
        Platform.TriggerClientEvent("chat:addMessage", src, { args = { tag, message } })
    end
end

local function _onResourceStart(cb)
    if _TLIB_IS_FIVEM then
        return AddEventHandler("onResourceStart", cb)
    end
end

local function _onResourceStop(cb)
    if _TLIB_IS_FIVEM then
        return AddEventHandler("onResourceStop", cb)
    end
end

-- Every handler here lives in tLib's resource state, not the consumer's, since
-- Discovery.create runs across an export boundary -- so a consumer `restart`
-- used to register a SECOND config_request handler over the old one, and the
-- client kept whichever reply landed last. An edit to data.json could be on
-- disk and correctly loaded, yet never reach a client. Instances are now
-- tracked and disposed on both restart and onResourceStop; disposal removes the
-- handlers and trips a flag the handler bodies check too, since
-- RemoveEventHandler isn't guaranteed on every build.

local LIVE = {}

local MANIFEST_SIBLINGS = {}

--- Group a metadata key with its siblings when a manifest is rewritten. Called
--- automatically by Discovery.create.
function Discovery.addManifestSibling(key)
    for _, k in ipairs(MANIFEST_SIBLINGS) do
        if k == key then return end
    end
    MANIFEST_SIBLINGS[#MANIFEST_SIBLINGS + 1] = key
    pcall(function() exports['tLib']:RegisterManifestSibling(key) end)
end

--- Ensure a resource's fxmanifest.lua carries a metadata line for `metadataKey`.
--- The Node bundle does the write — it has cross-resource fs access.
--- Node `fs` is sandboxed per resource exactly as SaveResourceFile is, so this
--- succeeds only where a write into the target is permitted at all. It must
--- never be the thing that unwinds an otherwise-successful export, hence pcall.
local function appendToManifest(resourceName, metadataKey, filePath)
    local ok, res = pcall(function()
        return exports[TLIB_RESOURCE]:AppendToManifest(resourceName, metadataKey, filePath)
    end)
    if not ok then
        log('AppendToManifest raised for ' .. tostring(resourceName) .. ': ' .. tostring(res), 4)
        return false
    end
    return res == true
end

function Discovery.create(opts)
    local metadataKey   = opts.metadataKey
    local defaultFile   = opts.defaultFileName
    local localFile     = opts.localFile or "data.json"
    local localSection  = opts.localSection   -- optional: read/write only this key within localFile
    local ownerResource = opts.resourceName or Platform.getPackageName()
    -- Staging destination. Defaults to tLib's own directory, which every
    -- consumer had before this was configurable and which is the only place
    -- always writable from tLib's VM.
    -- `stageWriter(relPath, content)` -> true | false, err. Supplied by a
    -- consumer that wants its own undelivered exports, written by its own VM.
    local stageWriter   = opts.stageWriter
    local stagingRes    = (stageWriter and opts.stagingResource) or TLIB_RESOURCE
    local stagingDir    = (stageWriter and opts.stagingDir) or 'export-staging/'
    local tag           = opts.logTag or metadataKey
    local chatTag       = opts.chatTag or ("[" .. ownerResource .. "]")

    -- Metadata keys this channel still reads but no longer writes. A consumer
    -- renaming its metadata key can't rename it in other people's fxmanifest.lua
    -- -- those packs declare `<key> 'file.json'` for a vehicle we've never seen,
    -- and a bare rename makes every one of them go invisible with no error. Reads
    -- accept these; a re-exported pack gets the current key appended to its
    -- manifest, so the old spelling drains away as packs are touched.
    local legacyKeys = opts.legacyMetadataKeys or {}

    Discovery.addManifestSibling(metadataKey)

    --- The config path a resource declares, under the current key or a retired one.
    --- Returns the path and the key it was found under, so a caller can say which.
    local function declaredConfigPath(resName)
        local path = _getResourceMeta(resName, metadataKey)
        if path and path ~= "" then return path, metadataKey end
        for _, key in ipairs(legacyKeys) do
            local legacy = _getResourceMeta(resName, key)
            if legacy and legacy ~= "" then return legacy, key end
        end
        return nil, nil
    end

    -- One live instance per (owner, event namespace). A consumer that restarts
    -- calls in here again, and this is where its previous instance dies.
    local liveKey = tostring(ownerResource) .. "|" .. tostring(opts.eventPrefix or metadataKey)
    local previous = LIVE[liveKey]
    if previous then
        log("[" .. tag .. "] '" .. tostring(ownerResource) .. "' created a second Discovery for '"
            .. liveKey .. "'; disposing the previous one so it stops answering with its old configs", 2)
        previous:dispose()
    end

    local disposed        = false
    local handles         = {}   -- event cookies owned by THIS instance
    local configs         = {}   -- { [model] = configData }
    local externalSources = {}   -- { [model] = { resource, filePath } }
    local hashToName      = {}   -- { [hashString] = spawnName }
    local unreadable      = {}   -- { [localFilePath] = decode error } while that file is unparseable

    local inst = {}

    local function track(handle)
        if handle ~= nil then handles[#handles + 1] = handle end
        return handle
    end

    --- Register a net event that goes quiet, and is unregistered, on disposal.
    local function netHandler(name, fn)
        track(Platform.AddNetEventHandler(name, function(...)
            if disposed then return end
            return fn(...)
        end))
    end

    --- Stop serving. Idempotent: onResourceStop and a re-create can both fire.
    function inst:dispose()
        if disposed then return end
        disposed = true
        for i = #handles, 1, -1 do
            Platform.RemoveEventHandler(handles[i])
            handles[i] = nil
        end
        if LIVE[liveKey] == self then LIVE[liveKey] = nil end
    end

    function inst:isDisposed()
        return disposed
    end

    -- Every walk over `configs` type-guards its values: without `localSection`,
    -- loadLocal adopts the owner's whole data file as the model→config map, and
    -- owners legitimately park scalars at its top level (tLS keeps bloom, paRange,
    -- envQuality, hudVisible there). A stray scalar reaching pairs() unwound out of
    -- CreateDiscovery before any handler registered and took the resource offline.

    -- `skipAutoSave`: the owning resource writes its own file instead of
    -- SaveResourceFile reaching in from tLib's runtime.
    --- Returns ok, err, kind. `kind == 'skipped'` is not a failure: the owner
    --- writes its own file and is expected to. Any other falsey return IS one,
    --- and callers must not report success over it.
    local function persistLocal(reason)
        if opts.skipAutoSave then
            log("[" .. tag .. "] " .. reason .. ": skipAutoSave set — leaving the file to '"
                .. tostring(ownerResource) .. "'", 1)
            return false, nil, 'skipped'
        end
        return inst:saveLocal()
    end

    local function registerAlias(key)
        if tonumber(key) == nil then
            hashToName[tostring(_hashKey(key))] = key
        end
    end

    local function resolveModel(model)
        return hashToName[tostring(model)] or model
    end

    function inst:getConfigs()
        return configs
    end

    function inst:setConfigs(c)
        configs = c
    end

    --- Locally-owned configs only, with `_local` stripped — for a caller that
    --- does its own file write.
    function inst:getLocalConfigs()
        local result = {}
        for model, cfg in pairs(configs) do
            if not externalSources[model] then
                if type(cfg) ~= "table" then
                    -- Owner data, not a config. Passed through so a caller that
                    -- rewrites the file from this result doesn't erase it.
                    result[model] = cfg
                else
                    local copy = {}
                    for k, v in pairs(cfg) do
                        if k ~= "_local" then copy[k] = v end
                    end
                    result[model] = copy
                end
            end
        end
        return result
    end

    function inst:getExternalSource(model)
        model = resolveModel(model)
        return externalSources[model]
    end

    function inst:resolveModel(model)
        return resolveModel(model)
    end

    function inst:loadLocal(filePath)
        filePath = filePath or localFile
        local decoded, state, detail = readJson(ownerResource, filePath)
        if state == 'corrupt' then
            -- Remembered, not just reported: this instance now holds none of what is in
            -- that file, so its next save would replace the lot with one model.
            unreadable[filePath] = detail
            log("[" .. tag .. "] '" .. tostring(ownerResource) .. "/" .. tostring(filePath)
                .. "' is not valid JSON (" .. tostring(detail) .. "), so none of its configs loaded."
                .. " It has NOT been changed, and nothing will be saved over it. Fix the file and"
                .. " restart " .. tostring(ownerResource) .. ".", 4)
            return
        end
        unreadable[filePath] = nil
        if not decoded then
            if not detail then return end
            if detail ~= 'nil' then
                log("[" .. tag .. "] loadLocal: '" .. tostring(ownerResource) .. "/" .. tostring(filePath)
                    .. "' decoded to a " .. detail .. ", expected an object — ignoring it", 4)
            end
            decoded = {}
        end
        if localSection then
            configs = (type(decoded[localSection]) == "table") and decoded[localSection] or {}
        else
            configs = decoded
        end
        -- Only config tables get a hash alias — deduplicateConfigs indexes
        -- both sides of an alias as tables.
        for key, value in pairs(configs) do
            if type(value) == "table" then registerAlias(key) end
        end
    end

    function inst:saveLocal(filePath)
        filePath = filePath or localFile
        log("[" .. tag .. "] saveLocal: resource='" .. tostring(ownerResource) .. "' file='" .. tostring(filePath) .. "' section='" .. tostring(localSection) .. "'", 1)

        -- Both halves are needed. The file as it is NOW decides whether sibling sections
        -- can be merged; the file as it was at LOAD decides whether this instance ever
        -- held its configs. An operator who repairs the JSON without restarting has a
        -- readable file and an instance that would still overwrite it with one model.
        local fileData, state, detail = readJson(ownerResource, filePath)
        if state == 'corrupt' or unreadable[filePath] then
            local where = tostring(ownerResource) .. "/" .. tostring(filePath)
            local err = state == 'corrupt'
                and (where .. " is not valid JSON (" .. tostring(detail) .. "), so it is not being overwritten.")
                or (where .. " was not valid JSON when it was loaded (" .. tostring(unreadable[filePath])
                    .. "), so none of its configs are held here and it is not being overwritten.")
            log("[" .. tag .. "] saveLocal REFUSED — " .. err .. " This change is in effect until a restart"
                .. " and is not saved. Fix the file and restart " .. tostring(ownerResource) .. ".", 4)
            return false, err, 'corrupt'
        end
        local localOnly = {}
        for model, cfg in pairs(configs) do
            if type(cfg) ~= "table" then
                -- Owner data. Copied verbatim — dropping it would delete their
                -- settings from disk on this write.
                localOnly[model] = cfg
            elseif not externalSources[model] or cfg._local then
                local copy = {}
                for k, v in pairs(cfg) do
                    if k ~= "_local" then copy[k] = v end
                end
                localOnly[model] = copy
            end
        end
        local modelList = {}
        for k in pairs(localOnly) do modelList[#modelList + 1] = tostring(k) end
        log("[" .. tag .. "] saveLocal: writing " .. #modelList .. " model(s): " .. table.concat(modelList, ", "), 1)
        local encoded
        if localSection then
            -- Merge, so sibling sections of the same file survive.
            fileData = fileData or {}
            fileData[localSection] = localOnly
            encoded = json.encode(fileData)
        else
            encoded = json.encode(localOnly)
        end

        local ok, err, kind = _saveFile(ownerResource, filePath, encoded)
        if ok then
            log("[" .. tag .. "] saveLocal: wrote " .. tostring(#encoded) .. " bytes to " .. ownerResource .. "/" .. filePath, 1)
            return true
        end

        local advice = ""
        if kind == 'denied' then
            -- The owner can always write its own folder; skipAutoSave hands it the write.
            advice = " '" .. tostring(ownerResource) .. "' should pass skipAutoSave = true to CreateDiscovery and"
                .. " write its own data file (tlib.fs.writeResourceFile runs inside its VM and is always allowed)."
        end
        log("[" .. tag .. "] saveLocal FAILED for " .. tostring(ownerResource) .. "/" .. tostring(filePath)
            .. " — " .. tostring(err) .. " Nothing was written; these settings will be gone after a restart."
            .. advice, 4)
        return false, err, kind
    end

    function inst:loadExternalFromResource(resName)
        local configPath = declaredConfigPath(resName)
        if not configPath or configPath == "" then return 0 end

        local extConfigs, state, detail = readJson(resName, configPath)
        if not extConfigs then
            -- One pack's bad file costs that pack, not the scan: a raise here used to end
            -- scanExternal for every resource after it in the index.
            if state == 'corrupt' then
                log("[" .. tag .. "] '" .. resName .. "/" .. configPath .. "' is not valid JSON ("
                    .. tostring(detail) .. ") — none of its configs loaded. Fix the file and restart "
                    .. resName .. ".", 3)
            elseif detail and detail ~= 'nil' then
                log("[" .. tag .. "] '" .. resName .. "/" .. configPath .. "' is not a JSON object — ignoring", 3)
            end
            return 0
        end

        local count = 0
        for model, cfg in pairs(extConfigs) do
            if type(cfg) ~= "table" then
                log("[" .. tag .. "] '" .. resName .. "/" .. configPath .. "' entry '" .. tostring(model)
                    .. "' is a " .. type(cfg) .. ", expected an object — skipped", 3)
            else
                registerAlias(model)
                local prevSource = externalSources[model]
                if not prevSource then
                    externalSources[model] = { resource = resName, filePath = configPath }
                end
                local existing = configs[model]
                -- Re-registration by the SAME external resource is not a shadow.
                -- scanExternal() adopts not-yet-started resources (their folder
                -- is already on disk); their onResourceStart then re-registers
                -- the identical file. Without this guard that read as a local
                -- override shadowing a file that never contained the model, and
                -- fired a false warning every boot. Refresh in place instead.
                if existing and prevSource
                    and prevSource.resource == resName
                    and prevSource.filePath == configPath
                    and not (type(existing) == "table" and existing._local)
                then
                    configs[model] = cfg
                elseif not existing then
                    configs[model] = cfg
                    count = count + 1
                elseif type(existing) == "table" then
                    -- A shipped config wins over an unmarked local copy. Only reporting
                    -- the shadow (old behaviour) left a stale local entry in place forever,
                    -- since it's only dropped when somebody saves that exact model -- a
                    -- vehicle nobody edits kept the stale copy regardless of pack updates.
                    -- A shipped config is the author's current intent; an unmarked local
                    -- copy is a leftover. `_local` still wins -- that's the one exception,
                    -- marking a config an admin deliberately took ownership of.
                    local shadowPath = tostring(ownerResource) .. "/" .. tostring(localFile)
                        .. (localSection and (" (section '" .. tostring(localSection) .. "')") or "")
                    if existing._local then
                        -- Permanent: saveLocal keeps `_local` entries forever, so every restart reloads the override.
                        log("[" .. tag .. "] '" .. tostring(model) .. "' shipped by '" .. resName .. "/" .. configPath
                            .. "' is NOT being used. " .. shadowPath .. " contains a saved local override for '"
                            .. tostring(model) .. "' (marked _local), and local always wins. The override is "
                            .. "rewritten on every save, so this will not resolve on its own — the settings in '"
                            .. resName .. "' can never load while it is there. To use the ones '" .. resName
                            .. "' ships, delete the '" .. tostring(model) .. "' entry from " .. shadowPath
                            .. " and restart the server.", 3)
                    else
                        configs[model] = cfg
                        log("[" .. tag .. "] '" .. tostring(model) .. "' from '" .. resName
                            .. "' has replaced an older copy in " .. shadowPath
                            .. "; the shipped config is the one in use. The stale entry is "
                            .. "dropped from " .. shadowPath .. " on the next save.", 1)
                    end
                end
            end
        end
        if count > 0 then
            log("[" .. tag .. "] Loaded " .. count .. " config(s) from '" .. resName .. "/" .. configPath .. "'", 1)
        end
        return count
    end

    function inst:scanExternal()
        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= ownerResource then
                inst:loadExternalFromResource(resName)
            end
        end
    end

    --- Collapse hash-keyed entries onto their spawn-name equivalents. Returns
    --- true when the map changed, so a skipAutoSave owner can persist it itself.
    function inst:deduplicateConfigs()
        local dirty = false
        for model, cfg in pairs(configs) do
            if type(cfg) == "table" and tonumber(model) ~= nil then
                local canonical = hashToName[model]
                if canonical and type(configs[canonical]) == "table" then
                    if externalSources[canonical] then
                        configs[canonical] = configs[model]
                        configs[canonical]._local = true
                        externalSources[canonical] = nil
                        -- Both DEBUG: one line per affected model on every boot.
                        log("[" .. tag .. "] Local hash '" .. model .. "' promoted to '" .. canonical .. "'", 1)
                    else
                        log("[" .. tag .. "] Removed duplicate hash '" .. model .. "' (canonical: " .. canonical .. ")", 1)
                    end
                    configs[model] = nil
                    dirty = true
                end
            end
        end
        if dirty then persistLocal("deduplicateConfigs") end
        return dirty
    end

    function inst:saveModelConfig(model, config)
        -- config_save hands this straight off the wire, so a client could
        -- otherwise plant a scalar that throws on every later walk — including
        -- during the next boot's Discovery.create.
        if type(config) ~= "table" then
            log("[" .. tag .. "] saveModelConfig: refused '" .. tostring(model) .. "' — config is a "
                .. type(config) .. ", expected a table", 3)
            return false
        end
        model = resolveModel(model)
        configs[model] = config

        local ext = externalSources[model]
        if ext then
            local extData, unreadableErr = readForRewrite(ext.resource, ext.filePath)
            if not extData then
                -- Not staged either: a staged copy holding this one model would read as the
                -- finished file, and copying it into place is the overwrite being refused.
                log("[" .. tag .. "] Could NOT save '" .. tostring(model) .. "' — " .. unreadableErr
                    .. " The change is in effect here until a restart.", 4)
                return false, unreadableErr, 'corrupt'
            end
            extData[model] = config
            local encodedExt = json.encode(extData)
            local ok, err, kind = _saveFile(ext.resource, ext.filePath, encodedExt)
            if not ok then
                -- No server.cfg grant fixes this -- see _saveFile. _saveFile has already
                -- tried the target's own fs bridge; reaching here means the target has
                -- no server bundle to host one (a plain asset pack), which is structural.
                -- Stage the finished file instead, same as the export path below.
                local staged = stagingPath(stagingDir, ext.resource, ext.filePath)
                -- `stagedIn`, not TLIB_RESOURCE: staging is configurable now and
                -- can fall back, so the only honest path to print is the one the
                -- write actually landed in. Naming the wrong directory in a
                -- recovery instruction is worse than printing none.
                local stagedOk, stageErr, stagedIn = _stageFile(stageWriter, stagingRes, staged, encodedExt)

                if stagedOk then
                    log("[" .. tag .. "] Could not write '" .. model .. "' into '" .. ext.resource
                        .. "' (" .. tostring(err) .. "), so the finished file was written to "
                        .. stagedIn .. "/" .. staged .. " instead.", 3)
                    log("[" .. tag .. "]   1. Copy " .. stagedIn .. "/" .. staged
                        .. "  ->  " .. ext.resource .. "/" .. ext.filePath, 3)
                    log("[" .. tag .. "]   2. Restart " .. ext.resource .. " (or the server).", 3)
                    log("[" .. tag .. "]   Until then the calling resource's own copy is what is used,"
                        .. " which is why the change is still in effect in game.", 3)
                else
                    log("[" .. tag .. "] Could NOT save '" .. model .. "' to " .. ext.resource .. "/"
                        .. ext.filePath .. " — " .. tostring(err)
                        .. " The staging copy could not be written either (" .. tostring(stageErr)
                        .. "), so this change exists only in memory here.", 4)
                end

                -- Still false: tLib did not write the owning resource's file.
                -- The caller (tLS) persists its own copy, which is why the
                -- setting survives a restart -- but that is the CALLER's doing,
                -- not something this function may claim.
                return false, err, kind
            end
            -- DEBUG: fires on every lightbar save, and every failure above
            -- already reports itself at WARN or ERROR.
            log("[" .. tag .. "] Saved '" .. model .. "' → " .. ext.resource .. "/" .. ext.filePath, 1)
        else
            config._local = true
            local ok, err, kind = persistLocal("saveModelConfig ('" .. tostring(model) .. "')")
            if not ok and kind ~= 'skipped' then
                return false, err, kind
            end
            log("[" .. tag .. "] Saved '" .. model .. "' → local", 1)
        end
        return true
    end

    function inst:removeModelConfig(model)
        model = resolveModel(model)
        local ext = externalSources[model]
        local warning = nil
        if ext then
            local extData, err = readForRewrite(ext.resource, ext.filePath)
            local ok = false
            if extData then
                extData[model] = nil
                ok, err = _saveFile(ext.resource, ext.filePath, json.encode(extData))
            end
            if not ok then
                -- Gone from memory but still on disk, so it reappears on the next scan.
                -- Deleting the entry by hand is the only way to remove it from a resource that can't write itself.
                warning = "'" .. tostring(model) .. "' was removed here but could NOT be removed from "
                    .. ext.resource .. "/" .. ext.filePath .. " — " .. tostring(err)
                    .. " It will reappear when that resource is next scanned. Delete the '" .. tostring(model)
                    .. "' entry from " .. ext.resource .. "/" .. ext.filePath .. " by hand to make it stick."
                log("[" .. tag .. "] " .. warning, 4)
            end
            externalSources[model] = nil
        end
        configs[model] = nil
        local ok, err, kind = persistLocal("removeModelConfig ('" .. tostring(model) .. "')")
        if not ok and kind ~= 'skipped' then
            return false, err, kind
        end
        return true, warning
    end

    function inst:getExportTargets()
        local targets = {}
        table.insert(targets, { name = ownerResource, hasMetadata = true, isLocal = true })

        -- `hasMetadata`: the resource declares the metadata key in its fxmanifest,
        -- not whether it currently serves a config -- a vehicle with an empty file
        -- or a shadowed model is still a valid export target.
        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= ownerResource and _getResourceState(resName) == "started" then
                local declared = declaredConfigPath(resName)
                table.insert(targets, {
                    name = resName,
                    hasMetadata = (declared ~= nil and declared ~= ""),
                    configPath = (declared ~= nil and declared ~= "") and declared or nil,
                })
            end
        end

        local externals = {}
        for i = 2, #targets do externals[#externals + 1] = targets[i] end
        table.sort(externals, function(a, b)
            if a.hasMetadata ~= b.hasMetadata then return a.hasMetadata end
            return a.name < b.name
        end)
        for i, t in ipairs(externals) do targets[i + 1] = t end

        return targets
    end

    --- Remove one model from a file another resource owns.
    --- Returns ok, err. Never throws: the target may not even exist any more.
    local function clearFromExternal(ext, model)
        local extData, err = readForRewrite(ext.resource, ext.filePath)
        if not extData then return false, err end
        if extData[model] == nil then return true end   -- already absent
        extData[model] = nil
        return _saveFile(ext.resource, ext.filePath, json.encode(extData))
    end

    --- Move `model` back into the owner's own data file. The move stands even
    --- if the external copy can't be deleted -- `_local` outranks anything a
    --- resource ships -- but the leftover is reported since it resurfaces if the local entry is later deleted.
    local function moveBackToLocal(model, config)
        local info = { status = 'local', warnings = {} }
        local oldExt = externalSources[model]

        if oldExt then
            local ok, err = clearFromExternal(oldExt, model)
            if not ok then
                info.leftovers = { resource = oldExt.resource, filePath = oldExt.filePath }
                local warning = "'" .. tostring(model) .. "' is now local, but the copy in "
                    .. oldExt.resource .. "/" .. oldExt.filePath .. " could NOT be deleted — " .. tostring(err)
                    .. " The local copy takes priority so the right settings are in use, but delete the '"
                    .. tostring(model) .. "' entry from that file by hand to finish the move."
                info.warnings[#info.warnings + 1] = warning
                log("[" .. tag .. "] " .. warning, 4)
            end
        end

        externalSources[model] = nil
        -- `_local` makes the entry survive saveLocal and outrank the external copy on the next boot.
        config._local = true

        local ok, err, kind = persistLocal("exportConfig (moved '" .. tostring(model) .. "' back to local)")
        if not ok and kind ~= 'skipped' then
            info.status = 'failed'
            info.message = "Could not write '" .. tostring(model) .. "' into " .. tostring(ownerResource)
                .. "/" .. tostring(localFile) .. " — " .. tostring(err)
            return false, nil, info
        end

        return true, nil, info
    end

    --- Export `model` into `targetResource`, or back to the owner.
    ---
    --- Returns `ok, targetPath, info`. `info.status` is one of:
    ---   'exported' written into the target resource
    ---   'staged'   the write was refused; the file is in tLib, with instructions
    ---   'local'    moved back to the owner's own data file
    ---   'failed'   nothing was written anywhere
    ---   'no-config' there is no such model
    ---
    --- Ordering: nothing that could lose the config happens before the
    --- destination write succeeds. Committing first risked a refused write
    --- leaving the entry marked local-but-unowned while the picker claimed an
    --- export that never happened.
    function inst:exportConfig(model, targetResource)
        model = resolveModel(model)
        local config = configs[model]
        if type(config) ~= "table" then
            return false, nil, { status = 'no-config', warnings = {},
                message = "There is no config named '" .. tostring(model) .. "' to export." }
        end

        if targetResource == ownerResource then
            return moveBackToLocal(model, config)
        end

        local targetPath = declaredConfigPath(targetResource)
        if not targetPath or targetPath == "" then
            targetPath = defaultFile
        end

        local info = {
            status = 'failed',
            warnings = {},
            resource = targetResource,
            filePath = targetPath,
            manifestLine = manifestLineFor(metadataKey, targetPath),
        }

        -- The file the target should end up with: whatever it already ships,
        -- plus this model. Reads are never sandboxed, so this is accurate even
        -- when the write that follows is refused — which is what makes the
        -- staged copy something an operator can simply drop into place.
        local targetData, unreadableErr = readForRewrite(targetResource, targetPath)
        if not targetData then
            -- Nothing committed, same as a refused write: still local, still served.
            info.error = unreadableErr
            info.errorKind = 'corrupt'
            info.message = "Could not export into '" .. tostring(targetResource) .. "' — " .. unreadableErr
                .. " Nothing was exported; the config is unchanged and still local."
            log("[" .. tag .. "] EXPORT NOT COMPLETED: " .. info.message, 4)
            return false, targetPath, info
        end
        local cleanConfig = {}
        for k, v in pairs(config) do
            if k ~= "_local" then cleanConfig[k] = v end
        end
        targetData[model] = cleanConfig
        local encoded = json.encode(targetData)

        local wrote, err, kind = _saveFile(targetResource, targetPath, encoded)

        if not wrote then
            -- Nothing committed: config is still local, marked `_local`, still served.
            info.status = 'staged'
            info.error = err
            info.errorKind = kind

            local staged = stagingPath(stagingDir, targetResource, targetPath)
            local stagedOk, stageErr, stagedIn = _stageFile(stageWriter, stagingRes, staged, encoded)
            if stagedOk then
                info.stagedResource = stagedIn
                info.stagedPath = staged
                info.steps = {
                    "1. Copy " .. stagedIn .. "/" .. staged
                        .. "  ->  " .. targetResource .. "/" .. targetPath,
                    "2. Add this line to " .. targetResource .. "/fxmanifest.lua:  " .. info.manifestLine,
                    "3. Restart " .. targetResource .. " (or the server).",
                }
                info.message = "Could not write into '" .. targetResource .. "' (" .. tostring(err)
                    .. "), so the finished file was written to " .. stagedIn .. "/" .. staged .. " instead."
            else
                info.status = 'failed'
                info.stageError = stageErr
                info.message = "Could not write into '" .. targetResource .. "' (" .. tostring(err)
                    .. "), and the fallback copy could not be written either (" .. tostring(stageErr)
                    .. "). Nothing was exported; the config is unchanged and still local."
            end

            log("[" .. tag .. "] EXPORT NOT COMPLETED: " .. info.message, 4)
            for _, step in ipairs(info.steps or {}) do
                log("[" .. tag .. "]   " .. step, 4)
            end
            if kind == 'missing' then
                log("[" .. tag .. "]   '" .. tostring(targetResource) .. "' is not a resource this server knows"
                    .. " about — check the name.", 4)
            end
            return false, targetPath, info
        end

        -- committed from here: the destination has the config
        info.status = 'exported'
        -- DEBUG: the handler below logs the same export at INFO, with the player who asked.
        log("[" .. tag .. "] Wrote '" .. tostring(model) .. "' → " .. targetResource .. "/" .. targetPath, 1)

        local oldExt = externalSources[model]
        if oldExt and not (oldExt.resource == targetResource and oldExt.filePath == targetPath) then
            local cleared, clearErr = clearFromExternal(oldExt, model)
            if not cleared then
                local warning = "'" .. tostring(model) .. "' is now in " .. targetResource .. "/" .. targetPath
                    .. ", but the old copy in " .. oldExt.resource .. "/" .. oldExt.filePath
                    .. " could NOT be deleted — " .. tostring(clearErr)
                    .. " Two resources now ship this model; delete the '" .. tostring(model)
                    .. "' entry from " .. oldExt.resource .. "/" .. oldExt.filePath .. " by hand."
                info.warnings[#info.warnings + 1] = warning
                log("[" .. tag .. "] " .. warning, 4)
            end
        end

        -- Attribute the new source BEFORE persisting: saveLocal only drops the
        -- entry from the owner's file once it knows somebody else owns it.
        externalSources[model] = { resource = targetResource, filePath = targetPath }
        config._local = nil
        local persisted, persistErr, persistKind =
            persistLocal("exportConfig ('" .. tostring(model) .. "' → " .. tostring(targetResource) .. ")")
        if not persisted and persistKind ~= 'skipped' then
            local warning = "'" .. tostring(model) .. "' was exported, but " .. tostring(ownerResource) .. "/"
                .. tostring(localFile) .. " could not be rewritten (" .. tostring(persistErr)
                .. "), so the old local copy is still on disk and will shadow the exported one after a restart."
            info.warnings[#info.warnings + 1] = warning
            log("[" .. tag .. "] " .. warning, 4)
        end

        if appendToManifest(targetResource, metadataKey, targetPath) then
            info.manifestOk = true
            log("[" .. tag .. "] Ensured " .. metadataKey .. " in " .. targetResource .. "/fxmanifest.lua", 1)
        else
            info.manifestOk = false
            local warning = "Could not edit " .. targetResource .. "/fxmanifest.lua. Add this line to it by hand,"
                .. " or the file will never be read:  " .. info.manifestLine
            info.warnings[#info.warnings + 1] = warning
            log("[" .. tag .. "] " .. warning, 4)
        end

        return true, targetPath, info
    end

    -- Load local first (takes priority), then external, then deduplicate.
    --
    -- Wrapped in pcall: the event-handler block below is registered AFTER these
    -- three calls, and Platform.wrapExport on FiveM is a bare exports(name, fn)
    -- with no pcall of its own. An error here would unwind straight out of the
    -- consumer's `exports['tLib']:CreateDiscovery{…}`, leaving handlers never
    -- registered while the consumer looks alive and silently answers nothing.
    -- Whatever loaded before the fault is kept; the failure is reported at ERROR.
    local okInit, initErr = pcall(function()
        inst:loadLocal()
        inst:scanExternal()
        inst:deduplicateConfigs()
    end)
    if not okInit then
        log("[" .. tag .. "] Failed to initialise the config store for '" .. tostring(ownerResource)
            .. "' — continuing with a partial load so event handlers still register. "
            .. "Configs may be incomplete; check '" .. tostring(ownerResource) .. "/" .. tostring(localFile)
            .. "'" .. (localSection and (" (section '" .. tostring(localSection) .. "')") or "")
            .. ". Error: " .. tostring(initErr), 4)
    end

    track(_onResourceStop(function(resName)
        if resName ~= ownerResource then return end
        -- DEBUG, not INFO: this fires once per Discovery owner on every restart.
        log("[" .. tag .. "] '" .. tostring(ownerResource) .. "' stopped — disposing its Discovery", 1)
        inst:dispose()
    end))

    track(_onResourceStart(function(resName)
        if disposed then return end
        if resName == ownerResource then return end
        local count = inst:loadExternalFromResource(resName)

        -- We may have exported to it earlier in this session.
        if count == 0 then
            for _, ext in pairs(externalSources) do
                if ext.resource == resName then
                    for model2, cfg2 in pairs(readJson(resName, ext.filePath) or {}) do
                        if type(cfg2) == "table" then
                            registerAlias(model2)
                            if not configs[model2] then
                                configs[model2] = cfg2
                                count = count + 1
                            end
                        end
                    end
                    break
                end
            end
        end

        if count > 0 and opts.receiveEvent and not opts.skipAutoBroadcast then
            Platform.TriggerClientEvent(opts.receiveEvent, -1, configs)
        end
    end))

        if opts.eventPrefix then
        local prefix        = opts.eventPrefix
        local receiveEv     = opts.receiveEvent or (prefix .. ":config_receive")
        local sourceInfoEv  = opts.sourceInfoEvent or (prefix .. ":externalSourceInfo")
        local targetsEv     = opts.exportTargetsEvent or (prefix .. ":exportTargets")
        -- The outcome of an export, structured -- unlike `sourceInfoEv`, which only
        -- ever carries "who owns this model now" and can't express a refused write.
        local resultEv      = opts.exportResultEvent or (prefix .. ":exportResult")
        local permCheck     = opts.permissionCheck

        -- `skipAutoBroadcast` is the delivery counterpart of `skipAutoSave`: the
        -- owner takes over sending configs to clients. Off by default. Exists because
        -- FiveM serialises and sends a net event whether or not any client handles it,
        -- so an owner that wants to pace delivery (TriggerLatentClientEvent) or send
        -- only the changed model can't while this plain broadcast still fires. An
        -- owner that sets it must answer `config_request` itself and send after
        -- afterSave/afterRemove. Announced once per instance, not per call -- unlike
        -- skipAutoSave's rare file writes, the request path can be one line per
        -- player per second on a full server.
        local skipNoticed = {}
        local function noticeSkip(path, owes)
            if skipNoticed[path] then return end
            skipNoticed[path] = true
            log("[" .. tag .. "] " .. path .. ": skipAutoBroadcast set — " .. owes
                .. " is left to '" .. tostring(ownerResource) .. "'", 1)
        end

        local function broadcast()
            if opts.skipAutoBroadcast then
                noticeSkip("broadcast", "sending configs to clients")
                return
            end
            Platform.TriggerClientEvent(receiveEv, -1, configs)
        end

        local function checkPerm(src)
            if not permCheck then
                -- No check supplied means admin-only; the alternative is
                -- unauthenticated filesystem writes.
                return Permission.isPlayerAdmin(src)
            end
            return permCheck(src)
        end

        -- The admin-gated handlers are bounded by checkPerm; config_request is not,
        -- and it's the expensive one -- it serialises the whole config map. A floor
        -- on the call interval is enough since a client only asks once per boot.
        -- Named by event, not instance: each consumer's Discovery has its own
        -- eventPrefix and must not share a budget.
        local configRequestGate = Platform.rateLimit(prefix .. ":config_request", 1000)
        netHandler(prefix .. ":config_request", function()
            local src = source
            if not src or src <= 0 then return end
            -- After the cheap source check, before serialising the config map.
            if configRequestGate(src) then return end
            -- See `broadcast` above: the owner answers this itself. This is the
            -- drop worth hearing about — a client that asks and is never told
            -- has no other way to find out.
            if opts.skipAutoBroadcast then
                noticeSkip("config_request", "answering config_request")
                return
            end
            Platform.TriggerClientEvent(receiveEv, src, configs)
        end)

        -- A model key off the wire: a spawn name or a hash. Any other type becomes a table
        -- key json.encode cannot write, and from then on every save of every model fails.
        local function modelKey(model)
            local kind = type(model)
            if kind == "string" then return model ~= "" and #model <= 128 end
            return kind == "number" and model == model
        end

        netHandler(prefix .. ":config_save", function(model, config)
            local src = source
            if not checkPerm(src) then return end
            -- Before afterSave and the broadcast: a save that was refused changed nothing,
            -- and an owner persisting its own copy on afterSave would write the old one out.
            if not modelKey(model) or type(config) ~= "table" then
                log("[" .. tag .. "] config_save from player " .. tostring(src) .. " refused: expected a model"
                    .. " name or hash and a config table, got " .. type(model) .. " and " .. type(config), 3)
                return
            end
            model = resolveModel(model)
            inst:saveModelConfig(model, config)
            TriggerEvent(metadataKey .. ":afterSave", model)
            broadcast()
        end)

        netHandler(prefix .. ":config_remove", function(model)
            local src = source
            if not checkPerm(src) then return end
            if not modelKey(model) then return end
            model = resolveModel(model)
            if not configs[model] then return end
            inst:removeModelConfig(model)
            TriggerEvent(metadataKey .. ":afterRemove", model)
            broadcast()
            log("[" .. tag .. "] " .. src .. " removed config for '" .. model .. "'", 2)
        end)

        netHandler(prefix .. ":getExternalSource", function(model)
            local src = source
            if not src or src <= 0 then return end
            if not checkPerm(src) then return end
            if not modelKey(model) then return end
            model = resolveModel(model)
            local ext = externalSources[model]
            Platform.TriggerClientEvent(sourceInfoEv, src, model, ext and ext.resource or nil)
        end)

        netHandler(prefix .. ":getExportTargets", function()
            local src = source
            if not src or src <= 0 then return end
            if not checkPerm(src) then return end
            Platform.TriggerClientEvent(targetsEv, src, inst:getExportTargets())
        end)

        netHandler(prefix .. ":exportConfig", function(model, targetResource)
            local src = source
            if not checkPerm(src) then return end
            -- The target is a resource NAME: it is handed to natives that raise on anything
            -- else, and joined into the staging path.
            if not modelKey(model) or type(targetResource) ~= "string" or targetResource == ""
                or targetResource:find("[/\\%c]") then return end
            model = resolveModel(model)
            if not configs[model] then return end

            local ok, _, info = inst:exportConfig(model, targetResource)
            info = info or { status = ok and 'exported' or 'failed', warnings = {} }
            info.model = model

            -- Mirrors `:afterSave` / `:afterRemove`. It exists so an owner that
            -- does its own persistence and delivery can react to an export
            -- WITHOUT calling exportConfig a second time — which is what tRadio
            -- was doing, running the whole move twice per click.
            TriggerEvent(metadataKey .. ":afterExport", model, targetResource, ok, info)

            broadcast()

            -- Sent on every outcome including failures -- the only event that distinguishes
            -- "exported" from "could not export, here is what to do" on the client.
            Platform.TriggerClientEvent(resultEv, src, info)

            if ok and info.status == 'local' then
                Platform.TriggerClientEvent(sourceInfoEv, src, model, nil)
                _chatMessage(src, chatTag, "Moved ~b~" .. model .. "~w~ back to local ~y~" .. tostring(localFile) .. "~w~.")
                log("[" .. tag .. "] Player " .. src .. " moved '" .. model .. "' back to local " .. tostring(localFile), 2)
            elseif ok then
                Platform.TriggerClientEvent(sourceInfoEv, src, model, targetResource)
                _chatMessage(src, chatTag, "Exported ~b~" .. model .. "~w~ config to ~y~" .. tostring(targetResource) .. "~w~.")
                log("[" .. tag .. "] Player " .. src .. " exported '" .. model .. "' to '" .. tostring(targetResource) .. "'", 2)
            else
                -- Export did not happen; config untouched. Say so, and say what to do.
                Platform.TriggerClientEvent(sourceInfoEv, src, model,
                    inst:getExternalSource(model) and inst:getExternalSource(model).resource or nil)
                if info.status == 'staged' then
                    _chatMessage(src, "^3" .. chatTag, "Could not write into ~y~" .. tostring(targetResource)
                        .. "~w~ — that resource's folder is protected by FiveM's filesystem sandbox. "
                        .. "The finished file has been written for you; three steps to finish:")
                    for _, step in ipairs(info.steps or {}) do
                        _chatMessage(src, "^3" .. chatTag, "~w~" .. step)
                    end
                else
                    _chatMessage(src, "^1" .. chatTag, "Export failed: ~w~" .. tostring(info.message or "unknown error"))
                end
            end

            for _, warning in ipairs(info.warnings or {}) do
                _chatMessage(src, "^3" .. chatTag, "~w~" .. warning)
            end
        end)
    end

    LIVE[liveKey] = inst
    return inst
end


function Discovery.registerExports()
    Platform.export('tLib', 'CreateDiscovery', function(opts)
        -- GetInvokingResource() returns nil at module init time (top-level script
        -- execution), so callers must pass resourceName = GetCurrentResourceName() explicitly.
        if not opts.resourceName then
            opts.resourceName = GetInvokingResource()
            if not opts.resourceName or opts.resourceName == '' then
                -- Level 4 (ERROR), not 1 -- the default logger filter hid this at 1.
                log('[Discovery] resourceName not set and GetInvokingResource() returned nil. '
                    .. 'Pass resourceName = GetCurrentResourceName() in your CreateDiscovery opts. '
                    .. 'Defaulting to tLib — file I/O will target the wrong resource!', 4)
            end
        end
        return Discovery.create(opts)
    end)
    -- AppendToManifest is exported by server/dist/bundle.js (Node.js) for reliable fs access
end
