-- Scans resources for tagged configs, loads and saves them, resolves hash↔name
-- aliases, edits manifests and picks up resources that start late.

local log = Logger.create('tLib/discovery')

Discovery = {}

-- The resource whose VM issues the file-writing natives below. Every write in
-- this file is made from tLib's runtime no matter which resource asked for it,
-- because Discovery.create is reached across an export boundary — so tLib is the
-- name that appears in a filesystem-permission grant, not the consumer's.
local TLIB_RESOURCE = _TLIB_IS_FIVEM and GetCurrentResourceName() or 'tLib'

-- THERE IS NO server.cfg LINE THAT LIFTS THE CROSS-RESOURCE WRITE REFUSAL.
-- DO NOT ADD ONE BACK, AND DO NOT TELL OPERATORS TO TRY ONE.
--
-- This file used to carry
--     BLANKET_GRANT_LINE = 'add_filesystem_permission tLib write *'
-- and six places recommended it whenever a write was refused. It was a
-- hypothesis awaiting measurement. The measurement is in, and it is negative:
-- that exact line sat in 305RP2's server.cfg from 2026-09-25, across many
-- server restarts, and on 2026-10-13 writes into a vehicle resource were still
-- refused every time.
--
-- The reason is that the sandbox objects to WHICH RESOURCE IS WRITING, not to
-- a missing permission. FiveM's Node runtime confines each resource to its own
-- directory, so a write originating in tLib's VM cannot land in someone else's
-- folder whatever the cfg says. shared/ts/fs/server.ts records the same finding
-- from the other side: a tLib-registered `WriteResourceFile(resource, ...)` was
-- built, measured, and abandoned for this, and replaced by "every resource
-- writes to itself from its own bundle".
--
-- THAT IS NOT THE SAME AS "CROSS-RESOURCE WRITES ARE IMPOSSIBLE", and this
-- comment used to say so. They are possible, and _saveFile does them: the
-- write just has to ORIGINATE in the target, which is what calling the
-- TARGET's own `WriteResourceFile` export achieves. Every t* resource bundles
-- tLib's shared/ts and registers one, and exports cross resources freely. The
-- only unreachable destination is one with no server bundle at all -- a plain
-- ASSET PACK, a vehicle resource shipping a tels.json. That case is structural.
--
-- For that case, and only that case, there is STAGING: write the finished file
-- inside tLib and tell the operator the two or three steps to put it where it
-- belongs. See stagingPath and _stageFile below, and the identical fallback in
-- saveModelConfig.

-- Where a refused export leaves the file it could not deliver. Inside tLib,
-- because tLib's own directory is the one place a write from tLib's VM is always
-- allowed.
local function stagingPath(targetResource, targetPath)
    return 'export-staging/' .. tostring(targetResource) .. '/' .. tostring(targetPath)
end

local function manifestLineFor(metadataKey, targetPath)
    return tostring(metadataKey) .. " '" .. tostring(targetPath) .. "'"
end

-- PER-PLAYER RATE LIMITING
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

-- WRITING TO A RESOURCE THAT IS NOT OURS
--
-- Measured on this server, from one resource's VM:
--
--   SaveResourceFile(<own resource>,   …) → 1
--   SaveResourceFile(<other resource>, …) → false        -- sandbox refusal
--   SaveResourceFile(<unknown resource>,…) → THROWS       -- "Resource X not found."
--   LoadResourceFile(<anything>,       …) → works         -- reads are unrestricted
--
-- Three distinguishable outcomes, and until now `_saveFile` discarded all of
-- them. Every failure was silent: the server logged a write, then logged
-- success, then told the player in green chat that their config had been
-- exported, while nothing had been written and a restart reverted the lot. A
-- green checkmark over silent data loss is worse than an error, so the return
-- value is now the contract.
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

    -- CROSS-RESOURCE WRITES ARE POSSIBLE, and this is how.
    --
    -- The sandbox objects to which resource is DOING the writing, not to the
    -- destination — so the write has to originate inside the target. That is
    -- exactly what the target's own `WriteResourceFile` export is: every
    -- resource bundling tLib's shared/ts calls `registerWriteResourceFile()`
    -- in its own server/main.ts, and an export is callable across resources.
    --
    -- `exports[resource]`, NOT `exports[tLib]`. Asking our own bridge to
    -- write somewhere else is the thing that is refused, and shared/ts/fs/
    -- server.ts refuses it there deliberately rather than letting Node answer
    -- with "use --allow-fs-write" — a server startup argument no customer can
    -- be asked to add. Routing to the target's bridge is not a workaround for
    -- that refusal; it is the design the refusal points at.
    --
    -- Only a target with no server bundle at all — a plain vehicle asset pack —
    -- is genuinely unwritable, and the callers below stage a file for that.
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

--- Write into tLib's OWN directory, which is never sandbox-refused.
---
--- Goes through tLib's Node export rather than SaveResourceFile because it
--- creates missing parent directories; the staging tree below is nested.
local function _stageFile(relPath, content)
    if not _TLIB_IS_FIVEM then
        return false, 'host has no file-write API'
    end
    local called, res = pcall(function()
        return exports[TLIB_RESOURCE]:WriteResourceFile(TLIB_RESOURCE, relPath, content)
    end)
    if not called then return false, tostring(res) end
    -- WriteResourceFile answers `true`, or a string describing the failure.
    if res ~= true then return false, tostring(res) end
    return true
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
        local encoded
        if localSection then
            -- Merge, so sibling sections of the same file survive.
            local raw = _loadFile(ownerResource, filePath)
            log("[" .. tag .. "] saveLocal: read existing file — " .. (raw and (tostring(#raw) .. " bytes") or "nil/empty"), 1)
            local fileData = (raw and raw ~= "") and json.decode(raw) or {}
            if type(fileData) ~= "table" then fileData = {} end
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

        -- This used to be where the lie started: the write was discarded, and
        -- every caller went on to report success.
        local advice = ""
        if kind == 'denied' then
            -- tLib is writing into the consumer's own folder from tLib's VM. The
            -- owner is the resource that can always write here, so the real fix
            -- is for it to take the write — which is exactly what `skipAutoSave`
            -- is for.
            advice = " '" .. tostring(ownerResource) .. "' should pass skipAutoSave = true to CreateDiscovery and"
                .. " write its own data file (tlib.fs.writeResourceFile runs inside its VM and is always allowed)."
        end
        log("[" .. tag .. "] saveLocal FAILED for " .. tostring(ownerResource) .. "/" .. tostring(filePath)
            .. " — " .. tostring(err) .. " Nothing was written; these settings will be gone after a restart."
            .. advice, 4)
        return false, err, kind
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
                local prevSource = externalSources[model]
                if not prevSource then
                    externalSources[model] = { resource = resName, filePath = configPath }
                end
                local existing = configs[model]
                -- Re-registration by the SAME external resource is not a shadow.
                -- scanExternal() walks every resource at owner start, including
                -- ones that have not started yet -- their folder is on disk, so
                -- the metadata and tels.json read fine and the config is adopted.
                -- Their onResourceStart then re-registers the identical file, and
                -- this used to see the owner's own earlier adoption as a local
                -- override and report a shadow against a file that does not
                -- contain the model at all. Measured 2026-10-13: tELS/data.json
                -- held `vehicles: {}` and the warning still fired every boot for
                -- 18charger21tr and fpiu21tr. Refresh in place instead.
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
                        -- DEBUG, not INFO, and that follows from the sentence
                        -- below: the operator's correct response here is to do
                        -- nothing, because saveLocal drops the entry on the
                        -- next write. One line per shadowed model on every
                        -- boot, with no action attached, is noise that pushes
                        -- the permanent case above out of view. Kept, because
                        -- it is still the only way to see why a shipped config
                        -- is not the one in use while the state lasts.
                        log("[" .. tag .. "] '" .. tostring(model) .. "' from '" .. resName
                            .. "' is shadowed by an older copy in " .. shadowPath
                            .. "; it takes over when that config is next saved.", 1)
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
                        -- Both DEBUG: hash-vs-spawn-name collapsing is internal
                        -- bookkeeping in a vocabulary that exists only in this
                        -- file, it runs at every boot, and it is one line per
                        -- affected model -- so it scales with how many configs
                        -- the server ships. Nothing for an operator to do
                        -- either way.
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
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            if type(extData) ~= "table" then extData = {} end
            extData[model] = config
            local encodedExt = json.encode(extData)
            local ok, err, kind = _saveFile(ext.resource, ext.filePath, encodedExt)
            if not ok then
                -- DO NOT RECOMMEND THE BLANKET GRANT HERE. It cannot work.
                --
                -- This used to end with "add this one line to server.cfg and
                -- restart: add_filesystem_permission tLib write *". That advice
                -- is false, and it was being printed on EVERY lightbar save.
                -- The grant has been in 305RP2's server.cfg since 2026-09-25 and
                -- the write is still refused, because the sandbox objects to
                -- WHICH RESOURCE IS WRITING, not to a missing permission:
                -- FiveM's Node runtime confines each resource to its own
                -- directory. shared/ts/fs/server.ts documents the same thing
                -- from the other side -- a tLib-registered WriteResourceFile
                -- taking a target resource was built, measured and abandoned
                -- for exactly this reason, and replaced by "every resource
                -- writes to itself from its own bundle".
                --
                -- Reaching HERE is not "cross-resource writes do not work" --
                -- _saveFile has already tried the target's own fs bridge, which
                -- is the route that does work. It means this particular target
                -- has no server bundle to host one: a plain asset pack, a
                -- vehicle resource shipping a tels.json. That case is
                -- structural, not a configuration gap, and no cfg line fixes it.
                --
                -- So do what the export path at the bottom of this file already
                -- does: stage the finished file inside tLib and tell the
                -- operator the three steps. `stagingPath` and `_stageFile`
                -- exist for precisely this.
                local staged = stagingPath(ext.resource, ext.filePath)
                local stagedOk, stageErr = _stageFile(staged, encodedExt)

                if stagedOk then
                    log("[" .. tag .. "] Could not write '" .. model .. "' into '" .. ext.resource
                        .. "' (" .. tostring(err) .. "), so the finished file was written to "
                        .. TLIB_RESOURCE .. "/" .. staged .. " instead.", 3)
                    log("[" .. tag .. "]   1. Copy " .. TLIB_RESOURCE .. "/" .. staged
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
                -- The caller (tELS) persists its own copy, which is why the
                -- setting survives a restart -- but that is the CALLER's doing,
                -- not something this function may claim.
                return false, err, kind
            end
            -- DEBUG. Every way this write can fail already reports itself at
            -- WARN or ERROR just above, so the success line adds nothing an
            -- operator can act on -- and it fires on every lightbar save.
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
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            if type(extData) ~= "table" then extData = {} end
            extData[model] = nil
            local ok, err = _saveFile(ext.resource, ext.filePath, json.encode(extData))
            if not ok then
                -- The entry is gone from memory but still on disk, so it comes
                -- back on the next scan. Saying so is the whole point.
                -- No blanket-grant suggestion here either, and for the same
                -- reason as saveModelConfig above: the grant cannot work, and
                -- offering it sends the operator to restart a server for
                -- nothing. Deleting the entry by hand is the ONLY way to remove
                -- a config from a resource that cannot write to itself.
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

        -- `hasMetadata` is exactly what it says: the resource DECLARES the
        -- metadata key in its fxmanifest. It used to be derived from which
        -- resources currently serve a config instead, so a vehicle that declared
        -- the key but shipped an empty file — or one whose only model is
        -- shadowed by a local override — showed as "no metadata" in the picker
        -- and looked like the wrong place to export to.
        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= ownerResource and _getResourceState(resName) == "started" then
                local declared = _getResourceMeta(resName, metadataKey)
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
        local raw = _loadFile(ext.resource, ext.filePath)
        local extData = (raw and raw ~= "") and json.decode(raw) or {}
        if type(extData) ~= "table" then extData = {} end
        if extData[model] == nil then return true end   -- already absent
        extData[model] = nil
        return _saveFile(ext.resource, ext.filePath, json.encode(extData))
    end

    --- Move `model` back into the owner's own data file.
    ---
    --- The external copy is genuinely deleted, and when it cannot be, that is
    --- reported rather than assumed. The move itself still stands in that case —
    --- a `_local` entry outranks anything a resource ships, so the config the
    --- player sees IS the local one — but a stale copy left in the vehicle is
    --- something the operator has to know about, because it is what will come
    --- back if the local entry is ever deleted.
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
        -- `_local` is what makes the entry survive saveLocal and outrank the
        -- external copy on the next boot. Clearing it here — which is what used
        -- to happen — is precisely how a "move back to local" could end up
        -- owning nothing at all.
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
    --- ORDERING. Nothing that could lose the config is done until the
    --- destination write has actually succeeded. The previous order cleared
    --- `_local`, rewrote the owner's data file and deleted the entry from the
    --- resource that used to hold it BEFORE attempting the target write, and
    --- attributed the new source only afterwards. On a host where writes land
    --- that is a delete-then-crash; on this one, where the target write is
    --- refused, it rewrote the local file with the entry still marked as local-
    --- but-unowned and left the picker claiming an export that never happened.
    --- Write first, commit second.
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

        local targetPath = _getResourceMeta(targetResource, metadataKey)
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
        local raw = _loadFile(targetResource, targetPath)
        local targetData = (raw and raw ~= "") and json.decode(raw) or {}
        if type(targetData) ~= "table" then targetData = {} end
        local cleanConfig = {}
        for k, v in pairs(config) do
            if k ~= "_local" then cleanConfig[k] = v end
        end
        targetData[model] = cleanConfig
        local encoded = json.encode(targetData)

        local wrote, err, kind = _saveFile(targetResource, targetPath, encoded)

        if not wrote then
            -- NOTHING has been committed at this point: the config is still
            -- local, still marked `_local`, still in the owner's file and still
            -- being served to clients. The export did not happen, and this
            -- returns false so no caller can claim it did.
            info.status = 'staged'
            info.error = err
            info.errorKind = kind

            local staged = stagingPath(targetResource, targetPath)
            local stagedOk, stageErr = _stageFile(staged, encoded)
            if stagedOk then
                info.stagedResource = TLIB_RESOURCE
                info.stagedPath = staged
                info.steps = {
                    "1. Copy " .. TLIB_RESOURCE .. "/" .. staged
                        .. "  ->  " .. targetResource .. "/" .. targetPath,
                    "2. Add this line to " .. targetResource .. "/fxmanifest.lua:  " .. info.manifestLine,
                    "3. Restart " .. targetResource .. " (or the server).",
                }
                info.message = "Could not write into '" .. targetResource .. "' (" .. tostring(err)
                    .. "), so the finished file was written to " .. TLIB_RESOURCE .. "/" .. staged .. " instead."
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
        -- DEBUG because the handler at the bottom of this file logs the same
        -- export at INFO with the player who asked for it, which is the version
        -- worth keeping: an audit line names who did what. Two lines per click
        -- for one event is the duplication, not the level.
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
        -- DEBUG, not INFO. Disposal is bookkeeping that always happens and can
        -- only fail loudly; narrating it put one line per Discovery owner in
        -- every operator's console on every restart.
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

        if count > 0 and opts.receiveEvent and not opts.skipAutoBroadcast then
            Platform.TriggerClientEvent(opts.receiveEvent, -1, configs)
        end
    end))

        if opts.eventPrefix then
        local prefix        = opts.eventPrefix
        local receiveEv     = opts.receiveEvent or (prefix .. ":config_receive")
        local sourceInfoEv  = opts.sourceInfoEvent or (prefix .. ":externalSourceInfo")
        local targetsEv     = opts.exportTargetsEvent or (prefix .. ":exportTargets")
        -- The outcome of an export, structured. Separate from `sourceInfoEv`,
        -- which only ever carried "who owns this model now" and therefore had no
        -- way to express a refused write at all.
        local resultEv      = opts.exportResultEvent or (prefix .. ":exportResult")
        local permCheck     = opts.permissionCheck

        -- `skipAutoBroadcast` is the delivery counterpart of `skipAutoSave`: the
        -- owning resource takes over sending configs to clients, exactly as
        -- `skipAutoSave` hands it the file writes. Off by default, so every
        -- existing caller keeps the behaviour it has.
        --
        -- It exists because this broadcast is a plain, non-latent
        -- `TriggerClientEvent` of the WHOLE map to `-1` on every save, and an
        -- owner that wants to pace it (TriggerLatentClientEvent) or send only
        -- the model that changed cannot do either while this one still fires:
        -- FiveM serialises and sends a net event whether or not any client has
        -- a handler for it, so redirecting `receiveEvent` at an unused name
        -- would cost the same bandwidth and merely hide it.
        --
        -- An owner that sets this MUST answer `config_request` itself — nothing
        -- else replies to it — and must send after `afterSave`/`afterRemove`.
        -- Announce a declined path ONCE per instance rather than per call, which
        -- is where this has to differ from `skipAutoSave`. That option guards
        -- file writes — rare, and one line each is proportionate. These guard a
        -- broadcast and a per-player request: on a full server the request path
        -- alone is one line per player per second, which buries the very first
        -- line an owner needs to read. Once is enough to turn silent-forever
        -- into a console message naming who owes the reply.
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

        netHandler(prefix .. ":config_request", function()
            local src = source
            if not src or src <= 0 then return end
            -- After the cheap source check, before serialising the config map.
            if rateLimited(prefix .. ":config_request", src, 1000) then return end
            -- See `broadcast` above: the owner answers this itself. This is the
            -- drop worth hearing about — a client that asks and is never told
            -- has no other way to find out.
            if opts.skipAutoBroadcast then
                noticeSkip("config_request", "answering config_request")
                return
            end
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

            local ok, _, info = inst:exportConfig(model, targetResource)
            info = info or { status = ok and 'exported' or 'failed', warnings = {} }
            info.model = model

            -- Mirrors `:afterSave` / `:afterRemove`. It exists so an owner that
            -- does its own persistence and delivery can react to an export
            -- WITHOUT calling exportConfig a second time — which is what tRadio
            -- was doing, running the whole move twice per click.
            TriggerEvent(metadataKey .. ":afterExport", model, targetResource, ok, info)

            broadcast()

            -- The structured result, for a consumer UI that wants to render the
            -- steps properly. Sent on every outcome, including the failures —
            -- this event is the only thing that distinguishes "exported" from
            -- "could not export, here is what to do" on the client.
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
                -- The export did NOT happen. The config is untouched and still
                -- served from wherever it was — say so, and say what to do,
                -- rather than leaving a green message over a file that was never
                -- written.
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
        -- GetInvokingResource() returns nil when called at module init time (top-level
        -- script execution), so callers must pass resourceName = GetCurrentResourceName()
        -- explicitly. Warn loudly here so the misconfiguration is obvious.
        if not opts.resourceName then
            opts.resourceName = GetInvokingResource()
            if not opts.resourceName or opts.resourceName == '' then
                -- Level 4 (ERROR). This said "WARNING: … file I/O will target
                -- the wrong resource!" at level 1, which the logger filters out
                -- by default -- so the loudest sentence in the file was the one
                -- nobody could see. The comment above says "warn loudly"; now it
                -- does.
                log('[Discovery] resourceName not set and GetInvokingResource() returned nil. '
                    .. 'Pass resourceName = GetCurrentResourceName() in your CreateDiscovery opts. '
                    .. 'Defaulting to tLib — file I/O will target the wrong resource!', 4)
            end
        end
        return Discovery.create(opts)
    end)
    -- AppendToManifest is exported by server/dist/bundle.js (Node.js) for reliable fs access
end
