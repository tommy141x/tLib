-- tLib/lua/discovery/server.lua
-- scans resources for tagged configs, loads/saves them, resolves hash↔name
-- aliases, handles manifest modification + late-start detection.
-- file I/O is all FiveM natives, helix paths are stubbed for now.

local log = Logger.create('tLib/discovery')

Discovery = {}

-- FiveM natives, swap for helix when known

local function _loadFile(resource, path)
    if _TLIB_IS_FIVEM then
        return LoadResourceFile(resource, path)
    else
        log('_loadFile: no Helix file-read equivalent yet (resource=' .. tostring(resource) .. ' path=' .. tostring(path) .. ')', 3)
        return nil
    end
end

local function _saveFile(resource, path, content)
    if _TLIB_IS_FIVEM then
        SaveResourceFile(resource, path, content, -1)
    else
        log('_saveFile: no Helix file-write equivalent yet (resource=' .. tostring(resource) .. ')', 3)
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
        -- Helix: no direct equivalent — return key unchanged
        return key
    end
end

local function _chatMessage(src, tag, message)
    if _TLIB_IS_FIVEM then
        Platform.TriggerClientEvent("chat:addMessage", src, { args = { tag, message } })
    end
    -- Helix: no chat equivalent known yet
end

local function _onResourceStart(cb)
    if _TLIB_IS_FIVEM then
        AddEventHandler("onResourceStart", cb)
    end
    -- Helix: no equivalent known yet — late resource detection not supported
end

-- manifest sibling keys for grouping
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


-- see opts below for what Discovery.create() accepts

function Discovery.create(opts)
    local metadataKey   = opts.metadataKey
    local defaultFile   = opts.defaultFileName
    local localFile     = opts.localFile or "data.json"
    local localSection  = opts.localSection   -- optional: read/write only this key within localFile
    local tag           = opts.logTag or metadataKey
    local chatTag       = opts.chatTag or ("[" .. Platform.getPackageName() .. "]")

    -- Auto-register this metadata key as a manifest sibling for grouping
    Discovery.addManifestSibling(metadataKey)

    local configs         = {}   -- { [model] = configData }
    local externalSources = {}   -- { [model] = { resource, filePath } }
    local hashToName      = {}   -- { [hashString] = spawnName }

    local inst = {}

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

    function inst:getExternalSource(model)
        model = resolveModel(model)
        return externalSources[model]
    end

    function inst:resolveModel(model)
        return resolveModel(model)
    end

    function inst:loadLocal(filePath)
        filePath = filePath or localFile
        local raw = _loadFile(Platform.getPackageName(), filePath)
        if raw and raw ~= "" then
            local decoded = json.decode(raw) or {}
            if localSection then
                configs = (type(decoded[localSection]) == "table") and decoded[localSection] or {}
            else
                configs = decoded
            end
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
        if localSection then
            -- Merge into the existing file so sibling sections are preserved
            local raw = _loadFile(Platform.getPackageName(), filePath)
            local fileData = (raw and raw ~= "") and json.decode(raw) or {}
            fileData[localSection] = localOnly
            _saveFile(Platform.getPackageName(), filePath, json.encode(fileData))
        else
            _saveFile(Platform.getPackageName(), filePath, json.encode(localOnly))
        end
    end

    function inst:loadExternalFromResource(resName)
        local configPath = _getResourceMeta(resName, metadataKey)
        if not configPath or configPath == "" then return 0 end

        local raw = _loadFile(resName, configPath)
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
        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= Platform.getPackageName() then
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
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = config
            _saveFile(ext.resource, ext.filePath, json.encode(extData))
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
            local raw = _loadFile(ext.resource, ext.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            _saveFile(ext.resource, ext.filePath, json.encode(extData))
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
        table.insert(targets, { name = Platform.getPackageName(), hasMetadata = true, isLocal = true })

        local numResources = _getResourceCount()
        for i = 0, numResources - 1 do
            local resName = _getResourceAtIndex(i)
            if resName and resName ~= Platform.getPackageName() and _getResourceState(resName) == "started" then
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
        if targetResource == Platform.getPackageName() then
            local oldExt = externalSources[model]
            if oldExt then
                local raw = _loadFile(oldExt.resource, oldExt.filePath)
                local extData = (raw and raw ~= "") and json.decode(raw) or {}
                extData[model] = nil
                _saveFile(oldExt.resource, oldExt.filePath, json.encode(extData))
            end
            externalSources[model] = nil
            config._local = nil
            inst:saveLocal()
            return true
        end

        -- 1. Remove from current location
        local oldExt = externalSources[model]
        if oldExt then
            local raw = _loadFile(oldExt.resource, oldExt.filePath)
            local extData = (raw and raw ~= "") and json.decode(raw) or {}
            extData[model] = nil
            _saveFile(oldExt.resource, oldExt.filePath, json.encode(extData))
        end
        config._local = nil
        inst:saveLocal()

        -- 2. Determine target file path
        local targetPath = _getResourceMeta(targetResource, metadataKey)
        if not targetPath or targetPath == "" then
            targetPath = defaultFile
        end

        -- 3. Write config to target resource
        local raw = _loadFile(targetResource, targetPath)
        local targetData = (raw and raw ~= "") and json.decode(raw) or {}
        local cleanConfig = {}
        for k, v in pairs(config) do
            if k ~= "_local" then cleanConfig[k] = v end
        end
        targetData[model] = cleanConfig
        _saveFile(targetResource, targetPath, json.encode(targetData))

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

        -- Load local first (takes priority), then external, then deduplicate
    inst:loadLocal()
    inst:scanExternal()
    inst:deduplicateConfigs()

    -- Watch for resources that start after us
    _onResourceStart(function(resName)
        if resName == Platform.getPackageName() then return end
        local count = inst:loadExternalFromResource(resName)

        -- Also check runtime tracking for resources we previously exported to
        if count == 0 then
            for _, ext in pairs(externalSources) do
                if ext.resource == resName then
                    local raw2 = _loadFile(resName, ext.filePath)
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
            Platform.TriggerClientEvent(opts.receiveEvent, -1, configs)
        end
    end)

        if opts.eventPrefix then
        local prefix        = opts.eventPrefix
        local receiveEv     = opts.receiveEvent or (prefix .. ":config_receive")
        local sourceInfoEv  = opts.sourceInfoEvent or (prefix .. ":externalSourceInfo")
        local targetsEv     = opts.exportTargetsEvent or (prefix .. ":exportTargets")
        local permCheck     = opts.permissionCheck
        local afterSave     = opts.afterSave
        local afterRemove   = opts.afterRemove

        local function broadcast()
            Platform.TriggerClientEvent(receiveEv, -1, configs)
        end

        local function checkPerm(src)
            if not permCheck then
                -- Default to admin check when no permissionCheck is provided.
                -- This prevents unauthenticated filesystem writes.
                return Permission.isPlayerAdmin(src)
            end
            return permCheck(src)
        end

        -- Request all configs
        Platform.AddEventHandler(prefix .. ":config_request", function()
            Platform.TriggerClientEvent(receiveEv, source, configs)
        end)

        -- Save a model's config
        Platform.AddEventHandler(prefix .. ":config_save", function(model, config)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            inst:saveModelConfig(model, config)
            if afterSave then afterSave(model, config) end
            broadcast()
        end)

        -- Remove a model's config
        Platform.AddEventHandler(prefix .. ":config_remove", function(model)
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
        Platform.AddEventHandler(prefix .. ":getExternalSource", function(model)
            local src = source
            model = resolveModel(model)
            local ext = externalSources[model]
            Platform.TriggerClientEvent(sourceInfoEv, src, model, ext and ext.resource or nil)
        end)

        -- Get export target list
        Platform.AddEventHandler(prefix .. ":getExportTargets", function()
            Platform.TriggerClientEvent(targetsEv, source, inst:getExportTargets())
        end)

        -- Export config to another resource
        Platform.AddEventHandler(prefix .. ":exportConfig", function(model, targetResource)
            local src = source
            if not checkPerm(src) then return end
            model = resolveModel(model)
            if not configs[model] then return end

            local ok, targetPath = inst:exportConfig(model, targetResource)
            if not ok then return end

            broadcast()

            if targetResource == Platform.getPackageName() then
                Platform.TriggerClientEvent(sourceInfoEv, src, model, nil)
                _chatMessage(src, chatTag, "Moved ~b~" .. model .. "~w~ back to local ~y~data.json~w~.")
                log("[" .. tag .. "] Player " .. src .. " moved '" .. model .. "' back to local data.json", 2)
            else
                Platform.TriggerClientEvent(sourceInfoEv, src, model, targetResource)
                _chatMessage(src, chatTag, "Exported ~b~" .. model .. "~w~ config to ~y~" .. targetResource .. "~w~.")

                -- Warn if fxmanifest couldn't be modified
                if not appendToManifest(targetResource, metadataKey, targetPath or defaultFile) then
                    _chatMessage(src, "^1" .. chatTag,
                        "Could not modify fxmanifest.lua for ~y~" .. targetResource ..
                        "~w~. Please add manually: ~g~" .. metadataKey .. " '" .. (targetPath or defaultFile) .. "'")
                end

                log("[" .. tag .. "] Player " .. src .. " exported '" .. model .. "' to '" .. targetResource .. "'", 2)
            end
        end)
    end

    return inst
end


function Discovery.registerExports()
    Platform.export('tLib', 'CreateDiscovery', function(opts)
        return Discovery.create(opts)
    end)
    -- AppendToManifest is exported by server/bundle.js (Node.js) for reliable fs access
end
