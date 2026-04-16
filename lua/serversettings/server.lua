-- tLib/lua/serversettings/server.lua
-- admin-configurable settings persisted to a JSON file.
--
-- Usage:
--   local ss = exports['tLib']:CreateServerSettings({
--       file           = 'data.json',          -- JSON file path in resource
--       section        = 'settings',           -- key within the JSON file
--       defaults       = { voiceVolume = 65 }, -- shipped defaults
--       requestEvent   = 'radio:requestServerSettings',
--       updateEvent    = 'radio:serverSettingsUpdated',
--       saveEvent      = 'radio:adminSaveSettings',
--       logTag         = 'Radio',
--       -- Optional: extra data sent alongside settings on request
--       onRequest      = function(src) return { radioModels = {...} } end,
--       -- Optional: called after save + broadcast (e.g. notify dispatch panel)
--       onAfterSave    = function(settings) ... end,
--   })
--
--   ss:get()                -- returns current settings table
--   ss:set(key, value)     -- set + save + broadcast
--   ss:merge(changes)      -- deep merge + save + broadcast
--   ss:save()              -- persist to file
--   ss:broadcast()         -- push to all clients

local log = Logger.create('tLib/serversettings')

ServerSettings = {}

--- Recursively merge source into target. Nested tables are merged, scalars overwrite.
local function deepMerge(target, source)
    for k, v in pairs(source) do
        if type(v) == "table" and type(target[k]) == "table" then
            deepMerge(target[k], v)
        else
            target[k] = v
        end
    end
end

function ServerSettings.create(opts)
    -- Use the invoking resource name (captured by the export wrapper),
    -- not tLib itself.
    local resName     = opts._resourceName or GetInvokingResource() or GetCurrentResourceName()
    local file        = opts.file or 'data.json'
    local section     = opts.section
    local defaults    = opts.defaults or {}
    local reqEvent    = opts.requestEvent
    local updEvent    = opts.updateEvent
    local saveEvent   = opts.saveEvent
    local logTag      = opts.logTag or resName
    local onRequest   = opts.onRequest
    local onAfterSave = opts.onAfterSave

    local settings = {}

    local function loadFromFile()
        local raw = LoadResourceFile(resName, file)
        if not raw or raw == "" then return {} end
        local ok, data = pcall(json.decode, raw)
        if not ok or type(data) ~= "table" then return {} end
        if section then
            return data[section] or {}
        end
        return data
    end

    local function saveToFile()
        if section then
            -- Read full file, update our section, write back
            local raw = LoadResourceFile(resName, file)
            local data = {}
            if raw and raw ~= "" then
                local ok, parsed = pcall(json.decode, raw)
                if ok and type(parsed) == "table" then data = parsed end
            end
            data[section] = settings
            local ok, encoded = pcall(json.encode, data)
            if ok then
                SaveResourceFile(resName, file, encoded, -1)
            else
                log("Failed to encode " .. file .. " for save", 4)
            end
        else
            -- Root-level: write settings directly as the entire file
            local ok, encoded = pcall(json.encode, settings)
            if ok then
                SaveResourceFile(resName, file, encoded, -1)
            else
                log("Failed to encode " .. file .. " for save", 4)
            end
        end
    end

    -- Initialize: load from file, then fill any missing keys from defaults
    settings = loadFromFile()
    for k, v in pairs(defaults) do
        if settings[k] == nil then
            if type(v) == "table" then
                settings[k] = {}
                for sk, sv in pairs(v) do settings[k][sk] = sv end
            else
                settings[k] = v
            end
        elseif type(v) == "table" and type(settings[k]) == "table" then
            -- Fill missing sub-keys from defaults
            for sk, sv in pairs(v) do
                if settings[k][sk] == nil then settings[k][sk] = sv end
            end
        end
    end

    local inst = {}

    --- Get the full settings table.
    function inst:get()
        return settings
    end

    --- Get a single value.
    function inst:getValue(key)
        return settings[key]
    end

    --- Set a single value, save, and broadcast.
    function inst:set(key, value)
        settings[key] = value
        saveToFile()
        inst:broadcast()
    end

    --- Deep merge changes into settings, save, and broadcast.
    function inst:merge(changes)
        if type(changes) ~= "table" then return end
        deepMerge(settings, changes)
        saveToFile()
        inst:broadcast()
    end

    --- Persist to file without broadcasting.
    function inst:save()
        saveToFile()
    end

    --- Broadcast current settings to all clients.
    function inst:broadcast()
        if updEvent then
            Platform.TriggerClientEvent(updEvent, -1, { settings = settings })
        end
        if onAfterSave then
            pcall(onAfterSave, settings)
        end
    end

    -- Client requests settings on join
    if reqEvent then
        RegisterNetEvent(reqEvent, function()
            local src = source
            local payload = { settings = settings }
            -- Check admin
            local ok, isAdm = pcall(Permission.isPlayerAdmin, src)
            payload.isAdmin = (ok and isAdm) or false
            -- Merge extra data from consumer callback
            if onRequest then
                local ok2, extra = pcall(onRequest, src)
                if ok2 and type(extra) == "table" then
                    for k, v in pairs(extra) do payload[k] = v end
                end
            end
            Platform.TriggerClientEvent(updEvent or (reqEvent .. ":response"), src, payload)
        end)
    end

    -- Admin saves settings
    if saveEvent then
        Permission.registerAdminEvent(saveEvent, function(src, changes)
            if type(changes) ~= "table" then return end
            deepMerge(settings, changes)
            saveToFile()
            log("Server settings updated by player " .. src, 3)
            inst:broadcast()
        end)
    end

    return inst
end

function ServerSettings.registerExports()
    Platform.export('tLib', 'CreateServerSettings', function(opts)
        -- Capture the invoking resource at export call time
        opts._resourceName = opts._resourceName or GetInvokingResource()
        return ServerSettings.create(opts)
    end)
end
