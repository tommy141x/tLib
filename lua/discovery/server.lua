-- tLib/lua/discovery/server.lua
-- Resource discovery & external config management.
--
-- Provides a factory function (via export) that creates a Discovery instance
-- parameterized by metadata key, event prefix, and hooks. Handles:
--   - Scanning all running resources for configs tagged with a metadata key
--   - Loading/saving model configs to the correct location (local or external)
--   - Hash ↔ spawn name alias resolution and deduplication
--   - Export targets for the UI picker
--   - Exporting configs to other resources (including fxmanifest modification)
--   - Auto-registering standard server events (request, save, remove, export)
--   - Late-starting resource detection
--
-- Platform note: Uses FiveM natives for resource enumeration and file I/O.
-- On Helix, these functions are stubbed until Helix equivalents exist.

local log = Logger.create('tLib/discovery')

Discovery = {}

-- ══════════════════════════════════════════════════════════════════
--  MANIFEST MODIFICATION (Node.js-free, pure Lua)
-- ══════════════════════════════════════════════════════════════════

-- Sibling metadata keys — auto-populated as Discovery instances are created.
-- When appending a new metadata line to a fxmanifest, we look for existing
-- sibling keys to group near. No hardcoded resource names.
local MANIFEST_SIBLINGS = {}

--- Register a metadata key as a manifest sibling (called automatically by Discovery.create).
function Discovery.addManifestSibling(key)
    for _, k in ipairs(MANIFEST_SIBLINGS) do
        if k == key then return end
    end
    MANIFEST_SIBLINGS[#MANIFEST_SIBLINGS + 1] = key
    -- Also register with the Node.js bundle so it groups correctly when writing manifests
    pcall(function() exports['tLib']:RegisterManifestSibling(key) end)
end

--- Ensure a resource's fxmanifest.lua contains a metadata line for the given key.
--- Delegates to the Node.js server bundle which has reliable cross-resource fs access.
--- Returns true on success, false on failure.
local function appendToManifest(resourceName, metadataKey, filePath)
    return exports['tLib']:AppendToManifest(resourceName, metadataKey, filePath)
end


-- ══════════════════════════════════════════════════════════════════
--  DISCOVERY INSTANCE FACTORY
-- ══════════════════════════════════════════════════════════════════

--[[
    Discovery.create(opts) — creates and returns a fully initialized Discovery instance.

    Required opts:
        metadataKey     string   — fxmanifest metadata key (e.g. "tels_config", "tradio_config")
        defaultFileName string   — file name to create when exporting to a resource without existing metadata
        localFile       string   — path to the local data file (e.g. "data.json")

    Optional opts:
        logTag          string   — prefix for log messages (default: metadataKey)
        chatTag         string   — chat message prefix, e.g. "[tELS]" (default: "[resource]")

        eventPrefix     string   — if provided, auto-registers standard server events:
                                    {prefix}:config_request, {prefix}:config_save,
                                    {prefix}:config_remove, {prefix}:getExternalSource,
                                    {prefix}:getExportTargets, {prefix}:exportConfig
        receiveEvent    string   — client event name to broadcast configs to (e.g. "lightbar:config_receive")
        sourceInfoEvent string   — client event for external source info (e.g. "lightbar:externalSourceInfo")
        exportTargetsEvent string — client event for export target list (e.g. "lightbar:exportTargets")

        permissionCheck function(src) → boolean — called before save/remove/export; return false to deny
        afterSave       function(model, config)  — called after a model is saved (e.g. orphan ref cleanup)
        afterRemove     function(model)           — called after a model is removed
]]

function Discovery.create(opts)
    local metadataKey   = opts.metadataKey
    local defaultFile   = opts.defaultFileName
    local localFile     = opts.localFile or "data.json"
    local tag           = opts.logTag or metadataKey
    local chatTag       = opts.chatTag or ("[" .. GetCurrentResourceName() .. "]")

    -- Auto-register this metadata key as a manifest sibling for grouping
    Discovery.addManifestSibling(metadataKey)

    local configs         = {}   -- { [model] = configData }
    local externalSources = {}   -- { [model] = { resource, filePath } }
    local hashToName      = {}   -- { [hashString] = spawnName }

    local inst = {}

    -- ── Alias helpers ──

    local function registerAlias(key)
        if tonumber(key) == nil then
            hashToName[tostring(GetHashKey(key))] = key
        end
    end

    local function resolveModel(model)
        return hashToName[tostring(model)] or model
    end

    -- ══════════════════════════════════════════════════════════════
    --  CORE API (always available, even without eventPrefix)
    -- ══════════════════════════════════════════════════════════════

    function inst:getConfigs()
        return configs
    end

    function inst:setConfigs(c)
        configs = c
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
        local raw = LoadResourceFile(GetCurrentResourceName(), filePath)
        if raw and raw ~= "" then
            configs = json.decode(raw) or {}
            for key in pairs(configs) do registerAlias(key) end
        end
    end

    function inst:saveLocal(filePath)
        filePath = filePath or localFile
        local localOnly = {}
        for model, cfg in pairs(configs) do
            if not externalSources[model] or configs[model]._local then
                local copy = {}
                for k, v in pairs(cfg) do
                    if k ~= "_local" then copy[k] = v end
                end
                localOnly[model] = copy
            end
        end
        SaveResourceFile(GetCurrentResourceName(), filePath, json.encode(localOnly), -1)
    end

    function inst:loadExternalFromResource(resName)
        local configPath = GetResourceMetadata(resName, metadataKey, 0)
        if not configPath or configPath == "" then return 0 end

        local raw = LoadResourceFile(resName, configPath)
        if not raw or raw == "" then return 0 end

        local extConfigs = json.decode(raw)
        if not extConfigs then return 0 end

        local count = 0
        for model, cfg in pairs(extConfigs) do
            registerAlias(model)
            if not externalSources[model] then
                externalSources[model] = { resource = resName, filePath = configPath }
            end
            if not configs[model] then
                configs[model] = cfg
                count = count + 1
            end
        end
        if count > 0 then
            log("[" .. tag .. "] Loaded " .. count .. " config(s) from '" .. resName .. "/" .. configPath .. "'", 2)
        end
        return count
    end

    function inst:scanExternal()
        local numResources = GetNumResources()
        for i = 0, numResources - 1 do
            local resName = GetResourceByFindIndex(i)
            if resName and resName ~= GetCurrentResourceName() then
                inst:loadExternalFromResource(resName)
            end
        end
    end

    function inst:deduplicateConfigs()
        local dirty = false
        for model in pairs(configs) do
            if tonumber(model) ~= nil then
                local canonical = hashToName[model]
                if canonical and configs[canonical] then
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
        if dirty then inst:saveLocal() end
    end

    function inst:saveModelConfig(model, config)
        model = resolveModel(model)
        configs[model] = config

        local ext = externalSources[model]
        if ext then
            local raw = LoadResourceFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = config
            SaveResourceFile(ext.resource, ext.filePath, json.encode(extData), -1)
            log("[" .. tag .. "] Saved '" .. model .. "' → " .. ext.resource .. "/" .. ext.filePath, 2)
        else
            config._local = true
            inst:saveLocal()
            log("[" .. tag .. "] Saved '" .. model .. "' → local", 2)
        end
    end

    function inst:removeModelConfig(model)
        model = resolveModel(model)
        local ext = externalSources[model]
        if ext then
            local raw = LoadResourceFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            SaveResourceFile(ext.resource, ext.filePath, json.encode(extData), -1)
            externalSources[model] = nil
        end
        configs[model] = nil
        inst:saveLocal()
    end

    function inst:getExportTargets()
        local activeResources = {}
        for _, ext in pairs(externalSources) do
            activeResources[ext.resource] = true
        end

        local targets = {}
        table.insert(targets, { name = GetCurrentResourceName(), hasMetadata = true, isLocal = true })

        local numResources = GetNumResources()
        for i = 0, numResources - 1 do
            local resName = GetResourceByFindIndex(i)
            if resName and resName ~= GetCurrentResourceName() and GetResourceState(resName) == "started" then
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
        if not config then return false end

        -- Move back to local
        if targetResource == GetCurrentResourceName() then
            local oldExt = externalSources[model]
            if oldExt then
                local raw = LoadResourceFile(oldExt.resource, oldExt.filePath)
                local extData = (raw and raw ~= "") and json.decode(raw) or {}
                extData[model] = nil
                SaveResourceFile(oldExt.resource, oldExt.filePath, json.encode(extData), -1)
            end
            externalSources[model] = nil
            config._local = nil
            inst:saveLocal()
            return true
        end

        -- 1. Remove from current location
        local oldExt = externalSources[model]
        if oldExt then
            local raw = LoadResourceFile(oldExt.resource, oldExt.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            SaveResourceFile(oldExt.resource, oldExt.filePath, json.encode(extData), -1)
        end
        config._local = nil
        inst:saveLocal()

        -- 2. Determine target file path
        local targetPath = GetResourceMetadata(targetResource, metadataKey, 0)
        if not targetPath or targetPath == "" then
            targetPath = defaultFile
        end

        -- 3. Write config to target resource
        local raw = LoadResourceFile(targetResource, targetPath)
        local targetData = (raw and raw ~= "") and json.decode(raw) or {}
        local cleanConfig = {}
        for k, v in pairs(config) do
            if k ~= "_local" then cleanConfig[k] = v end
        end
        targetData[model] = cleanConfig
        SaveResourceFile(targetResource, targetPath, json.encode(targetData), -1)

        -- 4. Ensure fxmanifest has the metadata line
        local ok = appendToManifest(targetResource, metadataKey, targetPath)
        if ok then
            log("[" .. tag .. "] Ensured " .. metadataKey .. " in " .. targetResource .. "/fxmanifest.lua", 2)
        else
            log("[" .. tag .. "] WARNING: Could not modify fxmanifest.lua for '" .. targetResource .. "'", 4)
        end

        -- 5. Update tracking
        externalSources[model] = { resource = targetResource, filePath = targetPath }

        return true, targetPath
    end

    -- ══════════════════════════════════════════════════════════════
    --  AUTO-INITIALIZATION
    -- ══════════════════════════════════════════════════════════════

    -- Load local first (takes priority), then external, then deduplicate
    inst:loadLocal()
    inst:scanExternal()
    inst:deduplicateConfigs()

    -- Watch for resources that start after us
    AddEventHandler("onResourceStart", function(resName)
        if resName == GetCurrentResourceName() then return end
        local count = inst:loadExternalFromResource(resName)

        -- Also check runtime tracking for resources we previously exported to
        if count == 0 then
            for _, ext in pairs(externalSources) do
                if ext.resource == resName then
                    local raw2 = LoadResourceFile(resName, ext.filePath)
                    if raw2 and raw2 ~= "" then
                        local extConfigs = json.decode(raw2)
                        if extConfigs then
                            for model2, cfg2 in pairs(extConfigs) do
                                registerAlias(model2)
                                if not configs[model2] then
                                    configs[model2] = cfg2
                                    count = count + 1
                                end
                            end
                        end
                    end
                    break
                end
            end
        end

        if count > 0 and opts.receiveEvent then
            TriggerClientEvent(opts.receiveEvent, -1, configs)
        end
    end)

    -- ══════════════════════════════════════════════════════════════
    --  AUTO-REGISTER STANDARD EVENTS (if eventPrefix provided)
    -- ══════════════════════════════════════════════════════════════

    if opts.eventPrefix then
        local prefix        = opts.eventPrefix
        local receiveEv     = opts.receiveEvent or (prefix .. ":config_receive")
        local sourceInfoEv  = opts.sourceInfoEvent or (prefix .. ":externalSourceInfo")
        local targetsEv     = opts.exportTargetsEvent or (prefix .. ":exportTargets")
        local permCheck     = opts.permissionCheck
        local afterSave     = opts.afterSave
        local afterRemove   = opts.afterRemove

        local function broadcast()
            TriggerClientEvent(receiveEv, -1, configs)
        end

        local function checkPerm(src)
            if not permCheck then return true end
            return permCheck(src)
        end

        -- Request all configs
        RegisterNetEvent(prefix .. ":config_request", function()
            TriggerClientEvent(receiveEv, source, configs)
        end)

        -- Save a model's config
        RegisterNetEvent(prefix .. ":config_save", function(model, config)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            inst:saveModelConfig(model, config)
            if afterSave then afterSave(model, config) end
            broadcast()
        end)

        -- Remove a model's config
        RegisterNetEvent(prefix .. ":config_remove", function(model)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            if not configs[model] then return end
            inst:removeModelConfig(model)
            if afterRemove then afterRemove(model) end
            broadcast()
            log("[" .. tag .. "] " .. src .. " removed config for '" .. model .. "'", 2)
        end)

        -- Get external source for a model
        RegisterNetEvent(prefix .. ":getExternalSource", function(model)
            local src = source
            model = resolveModel(model)
            local ext = externalSources[model]
            TriggerClientEvent(sourceInfoEv, src, model, ext and ext.resource or nil)
        end)

        -- Get export target list
        RegisterNetEvent(prefix .. ":getExportTargets", function()
            TriggerClientEvent(targetsEv, source, inst:getExportTargets())
        end)

        -- Export config to another resource
        RegisterNetEvent(prefix .. ":exportConfig", function(model, targetResource)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            if not configs[model] then return end

            local ok, targetPath = inst:exportConfig(model, targetResource)
            if not ok then return end

            broadcast()

            if targetResource == GetCurrentResourceName() then
                TriggerClientEvent(sourceInfoEv, src, model, nil)
                TriggerClientEvent("chat:addMessage", src, {
                    args = { chatTag, "Moved ~b~" .. model .. "~w~ back to local ~y~data.json~w~." }
                })
                log("[" .. tag .. "] Player " .. src .. " moved '" .. model .. "' back to local data.json", 2)
            else
                TriggerClientEvent(sourceInfoEv, src, model, targetResource)
                TriggerClientEvent("chat:addMessage", src, {
                    args = { chatTag, "Exported ~b~" .. model .. "~w~ config to ~y~" .. targetResource .. "~w~." }
                })

                -- Warn if fxmanifest couldn't be modified
                if not appendToManifest(targetResource, metadataKey, targetPath or defaultFile) then
                    TriggerClientEvent("chat:addMessage", src, {
                        args = { "^1" .. chatTag, "Could not modify fxmanifest.lua for ~y~" .. targetResource ..
                            "~w~. Please add manually: ~g~" .. metadataKey .. " '" .. (targetPath or defaultFile) .. "'" }
                    })
                end

                log("[" .. tag .. "] Player " .. src .. " exported '" .. model .. "' to '" .. targetResource .. "'", 2)
            end
        end)
    end

    return inst
end


-- ══════════════════════════════════════════════════════════════════
--  EXPORTS
-- ══════════════════════════════════════════════════════════════════

function Discovery.registerExports()
    Platform.export('tLib', 'CreateDiscovery', function(opts)
        return Discovery.create(opts)
    end)
    -- AppendToManifest is exported by server/bundle.js (Node.js) for reliable fs access
end
