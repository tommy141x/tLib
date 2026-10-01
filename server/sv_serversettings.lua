-- Admin-configurable settings, persisted to a JSON file in the owning resource.
--
--   local ss = exports['tLib']:CreateServerSettings({
--       file         = 'data.json',
--       section      = 'settings',           -- key within that file; optional
--       defaults     = { voiceVolume = 65 },
--       requestEvent = 'radio:requestServerSettings',
--       updateEvent  = 'radio:serverSettingsUpdated',
--       saveEvent    = 'radio:adminSaveSettings',
--       onRequest    = function(src) return { radioModels = {} } end,
--       onAfterSave  = function(settings) end,
--   })
--
-- onRequest adds extra fields to the payload a client receives; onAfterSave runs
-- once the save has broadcast.

local log = Logger.create('tLib/serversettings')

ServerSettings = {}

-- ── PER-PLAYER RATE LIMITING ────────────────────────────────────
--
-- saveEvent goes through Permission.registerAdminEvent and is bounded by that
-- check. requestEvent is not: anyone may fire it, and it costs an admin lookup,
-- the onRequest callback (which consumers use for directory scans and other
-- real work) and a full settings payload back down the wire. Unlimited, that is
-- a free amplifier — a few bytes in, a whole panel payload out.
--
-- A floor on the interval between calls rather than a token bucket: the client
-- fires this once per panel open, so there is no legitimate burst to allow for.
--
-- Keyed by event name, because each consumer resource creates its own
-- ServerSettings with its own requestEvent and they must not share a budget.
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

--- Nested tables merge, scalars overwrite.
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
    -- The invoking resource, captured by the export wrapper -- not tLib.
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
        -- Demo mode keeps the change in `settings` (already updated by the
        -- caller) and off disk, so it lasts the session and no longer. `Demo` is
        -- tLib's own copy of the module consumers reach as `tlib.demo`.
        if Demo and Demo.dropWrite(('%s/%s'):format(resName, file)) then return end
        if section then
            -- Read, replace our section, write back, so siblings survive.
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
            local ok, encoded = pcall(json.encode, settings)
            if ok then
                SaveResourceFile(resName, file, encoded, -1)
            else
                log("Failed to encode " .. file .. " for save", 4)
            end
        end
    end

    -- The file wins; defaults only fill in what it is missing, one level deep.
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
            for sk, sv in pairs(v) do
                if settings[k][sk] == nil then settings[k][sk] = sv end
            end
        end
    end

    local inst = {}

    function inst:get()
        return settings
    end

    function inst:getValue(key)
        return settings[key]
    end

    --- Set, save and broadcast.
    function inst:set(key, value)
        settings[key] = value
        saveToFile()
        inst:broadcast()
    end

    --- Deep-merge, save and broadcast.
    function inst:merge(changes)
        if type(changes) ~= "table" then return end
        deepMerge(settings, changes)
        saveToFile()
        inst:broadcast()
    end

    --- Persist without broadcasting.
    function inst:save()
        saveToFile()
    end

    function inst:broadcast()
        if updEvent then
            Platform.TriggerClientEvent(updEvent, -1, { settings = settings })
        end
        if onAfterSave then
            pcall(onAfterSave, settings)
        end
    end

    if reqEvent then
        RegisterNetEvent(reqEvent, function()
            local src = source
            -- Before the admin lookup and the onRequest callback, both of which
            -- are the work this event actually costs. Only a real client is
            -- limited: a server-side emit has source 0 and is not a request
            -- anyone can forge.
            if src and src > 0 and rateLimited(reqEvent, src, 1000) then return end
            local payload = { settings = settings }
            local ok, isAdm = pcall(Permission.isPlayerAdmin, src)
            payload.isAdmin = (ok and isAdm) or false
            if onRequest then
                local ok2, extra = pcall(onRequest, src)
                if ok2 and type(extra) == "table" then
                    for k, v in pairs(extra) do payload[k] = v end
                end
            end
            Platform.TriggerClientEvent(updEvent or (reqEvent .. ":response"), src, payload)
        end)
    end

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
        opts._resourceName = opts._resourceName or GetInvokingResource()
        return ServerSettings.create(opts)
    end)
end
