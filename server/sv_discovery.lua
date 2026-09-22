-- Scans resources for tagged configs, loads and saves them, resolves hash↔name
-- aliases, edits manifests and picks up resources that start late.

local log = Logger.create('tLib/discovery')

Discovery = {}

-- ── PER-PLAYER RATE LIMITING ────────────────────────────────────
--
-- The admin-gated handlers below are already bounded by checkPerm; the config
-- request is not, and it is the expensive one — it serialises the whole config
-- map to the asking client. A request-shaped event with no limit is a free
-- amplifier: the client sends a few bytes and the server pays for the reply.
--
-- A floor on the interval between calls rather than a token bucket, for the
-- same reason tELS uses one: a client asks for configs once per boot, so there
-- is no legitimate burst to accommodate.
--
-- Buckets are keyed by event name, not by instance, because every consumer
-- resource creates its own Discovery with its own eventPrefix and they must not
-- share a budget.
local _rateBuckets = {}

local function rateLimited(bucket, src, intervalMs)
    -- Platform.now() is a stub off FiveM, where there are no net events to
    -- limit in the first place.
    if not _TLIB_IS_FIVEM then return false end
    local b = _rateBuckets[bucket]
    if not b then
        b = {}
        _rateBuckets[bucket] = b
    end
    local now = Platform.now()
    local last = b[src]
    if last and (now - last) < intervalMs then return true end
    b[src] = now
    return false
end

-- Otherwise every bucket keeps one timestamp per player who has ever connected,
-- for the life of the server.
Platform.onPlayerDropped(function(src)
    for _, b in pairs(_rateBuckets) do b[src] = nil end
end)

local function _loadFile(resource, path)
    if _TLIB_IS_FIVEM then
        return LoadResourceFile(resource, path)
    else
        log('_loadFile: host has no file-read API (resource=' .. tostring(resource) .. ' path=' .. tostring(path) .. ')', 3)
        return nil
    end
end

local function _saveFile(resource, path, content)
    if _TLIB_IS_FIVEM then
        SaveResourceFile(resource, path, content, -1)
    else
        log('_saveFile: host has no file-write API (resource=' .. tostring(resource) .. ')', 3)
    end
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

-- ══════════════════════════════════════════════════════════════════
--  INSTANCE LIFETIME
--
--  Every handler this module registers lives in tLib's resource state, not in
--  the consumer's -- Discovery.create is called across an export boundary, so
--  the closures it builds belong to tLib and survive for as long as TLIB is
--  running. Nothing in here used to end that lifetime.
--
--  The consequence was not subtle. `restart tELS` re-ran CreateDiscovery and
--  registered a SECOND config_request handler over a freshly loaded `configs`
--  table, while the first one stayed live over the table it loaded whenever
--  tLib last started. Both answered. The client kept whichever reply landed
--  last, so an edit to data.json could be correct on disk, correctly loaded by
--  the restarted consumer, and still never reach a client -- and restarting the
--  consumer again only added a third voice. It presented as "the config is
--  stale even after a resource restart", which is exactly what it was, and it
--  applied to every resource built on Discovery rather than to any one of them.
--
--  So instances are now tracked and disposed: a consumer restarting tears its
--  old instance down before the new one is built, and a consumer stopping tears
--  it down there and then. Disposal both removes the handlers and trips a flag
--  the handler bodies check, because RemoveEventHandler is not guaranteed on
--  every build and a handler that cannot be removed must at least go quiet.
-- ══════════════════════════════════════════════════════════════════

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
local function appendToManifest(resourceName, metadataKey, filePath)
    return exports['tLib']:AppendToManifest(resourceName, metadataKey, filePath)
end

function Discovery.create(opts)
    local metadataKey   = opts.metadataKey
    local defaultFile   = opts.defaultFileName
    local localFile     = opts.localFile or "data.json"
    local localSection  = opts.localSection   -- optional: read/write only this key within localFile
    local ownerResource = opts.resourceName or Platform.getPackageName()
    local tag           = opts.logTag or metadataKey
    local chatTag       = opts.chatTag or ("[" .. ownerResource .. "]")

    Discovery.addManifestSibling(metadataKey)

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

    -- Every walk over `configs` type-guards its values. Without a `localSection`,
    -- loadLocal adopts the whole of the owner's data file as the model → config
    -- map, and owners legitimately park scalars at its top level (tELS keeps
    -- bloom, paRange, envQuality, hudVisible there). Reaching one with pairs() is
    -- a hard error, and since the export is a bare exports(name, fn) it unwinds
    -- out of CreateDiscovery before any handler is registered — one stray scalar
    -- took a whole resource offline. Guards skip or pass through, never throw.

    -- `skipAutoSave` means the owning resource does its own file writes; what it
    -- is avoiding is SaveResourceFile reaching from tLib's runtime into its
    -- folder. Every write path must honour it.
    local function persistLocal(reason)
        if opts.skipAutoSave then
            log("[" .. tag .. "] " .. reason .. ": skipAutoSave set — leaving the file to '"
                .. tostring(ownerResource) .. "'", 1)
            return false
        end
        inst:saveLocal()
        return true
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
        local raw = _loadFile(ownerResource, filePath)
        if raw and raw ~= "" then
            local decoded = json.decode(raw)
            if type(decoded) ~= "table" then
                if decoded ~= nil then
                    log("[" .. tag .. "] loadLocal: '" .. tostring(ownerResource) .. "/" .. tostring(filePath)
                        .. "' decoded to a " .. type(decoded) .. ", expected an object — ignoring it", 4)
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
    end

    function inst:saveLocal(filePath)
        filePath = filePath or localFile
        log("[" .. tag .. "] saveLocal: resource='" .. tostring(ownerResource) .. "' file='" .. tostring(filePath) .. "' section='" .. tostring(localSection) .. "'", 1)
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
        if localSection then
            -- Merge, so sibling sections of the same file survive.
            local raw = _loadFile(ownerResource, filePath)
            log("[" .. tag .. "] saveLocal: read existing file — " .. (raw and (tostring(#raw) .. " bytes") or "nil/empty"), 1)
            local fileData = (raw and raw ~= "") and json.decode(raw) or {}
            fileData[localSection] = localOnly
            local encoded = json.encode(fileData)
            _saveFile(ownerResource, filePath, encoded)
            log("[" .. tag .. "] saveLocal: wrote " .. tostring(#encoded) .. " bytes to " .. ownerResource .. "/" .. filePath, 1)
        else
            local encoded = json.encode(localOnly)
            _saveFile(ownerResource, filePath, encoded)
            log("[" .. tag .. "] saveLocal: wrote " .. tostring(#encoded) .. " bytes to " .. ownerResource .. "/" .. filePath, 1)
        end
    end

    function inst:loadExternalFromResource(resName)
        local configPath = _getResourceMeta(resName, metadataKey)
        if not configPath or configPath == "" then return 0 end

        local raw = _loadFile(resName, configPath)
        if not raw or raw == "" then return 0 end

        local extConfigs = json.decode(raw)
        if type(extConfigs) ~= "table" then
            if extConfigs ~= nil then
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
                if not externalSources[model] then
                    externalSources[model] = { resource = resName, filePath = configPath }
                end
                local existing = configs[model]
                if not existing then
                    configs[model] = cfg
                    count = count + 1
                elseif type(existing) == "table" then
                    -- The local copy wins by design, but silently shadowing a
                    -- resource's config is indistinguishable from it being
                    -- broken: the author ships an update, nothing changes in
                    -- game, and the only fix is hand-editing a file. Reporting
                    -- it is the whole point of this branch; precedence is
                    -- untouched.
                    local shadowPath = tostring(ownerResource) .. "/" .. tostring(localFile)
                        .. (localSection and (" (section '" .. tostring(localSection) .. "')") or "")
                    if existing._local then
                        -- Permanent: saveLocal keeps `_local` entries forever,
                        -- so every restart reloads the override.
                        log("[" .. tag .. "] '" .. tostring(model) .. "' shipped by '" .. resName .. "/" .. configPath
                            .. "' is NOT being used. " .. shadowPath .. " contains a saved local override for '"
                            .. tostring(model) .. "' (marked _local), and local always wins. The override is "
                            .. "rewritten on every save, so this will not resolve on its own — the settings in '"
                            .. resName .. "' can never load while it is there. To use the ones '" .. resName
                            .. "' ships, delete the '" .. tostring(model) .. "' entry from " .. shadowPath
                            .. " and restart the server.", 3)
                    else
                        -- Transient: saveLocal drops the entry on the next
                        -- write. Logged below WARN because it self-heals.
                        log("[" .. tag .. "] '" .. tostring(model) .. "' shipped by '" .. resName .. "/" .. configPath
                            .. "' is not being used yet: " .. shadowPath .. " still holds an older copy of it, and "
                            .. "local takes priority. That leftover copy is dropped the next time this config is "
                            .. "saved, and the version from '" .. resName .. "' takes over from then on. To switch "
                            .. "immediately, delete the '" .. tostring(model) .. "' entry from " .. shadowPath
                            .. " and restart the server.", 2)
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
                        log("[" .. tag .. "] Local hash '" .. model .. "' promoted to '" .. canonical .. "'", 2)
                    else
                        log("[" .. tag .. "] Removed duplicate hash '" .. model .. "' (canonical: " .. canonical .. ")", 2)
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
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = config
            _saveFile(ext.resource, ext.filePath, json.encode(extData))
            log("[" .. tag .. "] Saved '" .. model .. "' → " .. ext.resource .. "/" .. ext.filePath, 2)
        else
            config._local = true
            if not opts.skipAutoSave then
                inst:saveLocal()
            end
            log("[" .. tag .. "] Saved '" .. model .. "' → local", 2)
        end
    end

    function inst:removeModelConfig(model)
        model = resolveModel(model)
        local ext = externalSources[model]
        if ext then
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            _saveFile(ext.resource, ext.filePath, json.encode(extData))
            externalSources[model] = nil
        end
        configs[model] = nil
        if not opts.skipAutoSave then
            inst:saveLocal()
        end
    end

    function inst:getExportTargets()
        local activeResources = {}
        for _, ext in pairs(externalSources) do
            activeResources[ext.resource] = true
        end

        local targets = {}
        table.insert(targets, { name = ownerResource, hasMetadata = true, isLocal = true })

        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= ownerResource and _getResourceState(resName) == "started" then
                local hasMetadata = activeResources[resName] == true
                table.insert(targets, { name = resName, hasMetadata = hasMetadata })
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

    function inst:exportConfig(model, targetResource)
        model = resolveModel(model)
        local config = configs[model]
        if type(config) ~= "table" then return false end

        -- Move back to local.
        if targetResource == ownerResource then
            local oldExt = externalSources[model]
            if oldExt then
                local raw = _loadFile(oldExt.resource, oldExt.filePath)
                local extData = (raw and raw ~= "") and json.decode(raw) or {}
                extData[model] = nil
                _saveFile(oldExt.resource, oldExt.filePath, json.encode(extData))
            end
            externalSources[model] = nil
            config._local = nil
            persistLocal("exportConfig (moved '" .. tostring(model) .. "' back to local)")
            return true
        end

        local oldExt = externalSources[model]
        if oldExt then
            local raw = _loadFile(oldExt.resource, oldExt.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            _saveFile(oldExt.resource, oldExt.filePath, json.encode(extData))
        end
        config._local = nil
        persistLocal("exportConfig ('" .. tostring(model) .. "' → " .. tostring(targetResource) .. ")")

        local targetPath = _getResourceMeta(targetResource, metadataKey)
        if not targetPath or targetPath == "" then
            targetPath = defaultFile
        end

        local raw = _loadFile(targetResource, targetPath)
        local targetData = (raw and raw ~= "") and json.decode(raw) or {}
        local cleanConfig = {}
        for k, v in pairs(config) do
            if k ~= "_local" then cleanConfig[k] = v end
        end
        targetData[model] = cleanConfig
        _saveFile(targetResource, targetPath, json.encode(targetData))

        local ok = appendToManifest(targetResource, metadataKey, targetPath)
        if ok then
            log("[" .. tag .. "] Ensured " .. metadataKey .. " in " .. targetResource .. "/fxmanifest.lua", 2)
        else
            log("[" .. tag .. "] WARNING: Could not modify fxmanifest.lua for '" .. targetResource .. "'", 4)
        end

        externalSources[model] = { resource = targetResource, filePath = targetPath }

        return true, targetPath
    end

    -- Load local first (takes priority), then external, then deduplicate.
    --
    -- Wrapped in pcall on purpose. Everything below this line — the late-start
    -- watcher and the whole event-handler block — is registered AFTER these
    -- three calls, and Platform.wrapExport on FiveM is a bare exports(name, fn)
    -- with no pcall of its own. An error raised in here therefore unwinds
    -- straight out of the consumer's `exports['tLib']:CreateDiscovery{…}`: the
    -- handle is never assigned, config_request/config_save are never registered,
    -- and the consumer looks alive while silently answering nothing. One
    -- malformed entry in one data file used to be enough.
    --
    -- Whatever loaded before the fault is kept, and the failure is reported at
    -- ERROR level with the file to look at — a partially-loaded store that still
    -- serves events is strictly better than a resource with no handlers, but it
    -- must never be silent.
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
        log("[" .. tag .. "] '" .. tostring(ownerResource) .. "' stopped — disposing its Discovery "
            .. "so it cannot keep answering with configs it loaded before", 2)
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
                    local raw2 = _loadFile(resName, ext.filePath)
                    if raw2 and raw2 ~= "" then
                        local extConfigs = json.decode(raw2)
                        if type(extConfigs) == "table" then
                            for model2, cfg2 in pairs(extConfigs) do
                                if type(cfg2) == "table" then
                                    registerAlias(model2)
                                    if not configs[model2] then
                                        configs[model2] = cfg2
                                        count = count + 1
                                    end
                                end
                            end
                        end
                    end
                    break
                end
            end
        end

        if count > 0 and opts.receiveEvent then
            Platform.TriggerClientEvent(opts.receiveEvent, -1, configs)
        end
    end))

        if opts.eventPrefix then
        local prefix        = opts.eventPrefix
        local receiveEv     = opts.receiveEvent or (prefix .. ":config_receive")
        local sourceInfoEv  = opts.sourceInfoEvent or (prefix .. ":externalSourceInfo")
        local targetsEv     = opts.exportTargetsEvent or (prefix .. ":exportTargets")
        local permCheck     = opts.permissionCheck

        local function broadcast()
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

        netHandler(prefix .. ":config_request", function()
            local src = source
            if not src or src <= 0 then return end
            -- After the cheap source check, before serialising the config map.
            if rateLimited(prefix .. ":config_request", src, 1000) then return end
            Platform.TriggerClientEvent(receiveEv, src, configs)
        end)

        netHandler(prefix .. ":config_save", function(model, config)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            inst:saveModelConfig(model, config)
            TriggerEvent(metadataKey .. ":afterSave", model)
            broadcast()
        end)

        netHandler(prefix .. ":config_remove", function(model)
            local src = source
            if not checkPerm(src) then return end
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
            model = resolveModel(model)
            if not configs[model] then return end

            local ok, targetPath = inst:exportConfig(model, targetResource)
            if not ok then return end

            broadcast()

            if targetResource == ownerResource then
                Platform.TriggerClientEvent(sourceInfoEv, src, model, nil)
                _chatMessage(src, chatTag, "Moved ~b~" .. model .. "~w~ back to local ~y~data.json~w~.")
                log("[" .. tag .. "] Player " .. src .. " moved '" .. model .. "' back to local data.json", 2)
            else
                Platform.TriggerClientEvent(sourceInfoEv, src, model, targetResource)
                _chatMessage(src, chatTag, "Exported ~b~" .. model .. "~w~ config to ~y~" .. targetResource .. "~w~.")

                if not appendToManifest(targetResource, metadataKey, targetPath or defaultFile) then
                    _chatMessage(src, "^1" .. chatTag,
                        "Could not modify fxmanifest.lua for ~y~" .. targetResource ..
                        "~w~. Please add manually: ~g~" .. metadataKey .. " '" .. (targetPath or defaultFile) .. "'")
                end

                log("[" .. tag .. "] Player " .. src .. " exported '" .. model .. "' to '" .. targetResource .. "'", 2)
            end
        end)
    end

    LIVE[liveKey] = inst
    return inst
end


function Discovery.registerExports()
    Platform.export('tLib', 'CreateDiscovery', function(opts)
        -- GetInvokingResource() returns nil when called at module init time (top-level
        -- script execution), so callers must pass resourceName = GetCurrentResourceName()
        -- explicitly. Warn loudly here so the misconfiguration is obvious.
        if not opts.resourceName then
            opts.resourceName = GetInvokingResource()
            if not opts.resourceName or opts.resourceName == '' then
                log('[Discovery] WARNING: resourceName not set and GetInvokingResource() returned nil. '
                    .. 'Pass resourceName = GetCurrentResourceName() in your CreateDiscovery opts. '
                    .. 'Defaulting to tLib — file I/O will target the wrong resource!', 1)
            end
        end
        return Discovery.create(opts)
    end)
    -- AppendToManifest is exported by server/dist/bundle.js (Node.js) for reliable fs access
end
