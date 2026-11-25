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

-- Every handler below is registered in tLib's VM on a consumer's behalf, so it outlives
-- that consumer's restart unless it is removed here. Left in place, the previous instance
-- kept answering the save event too: it merged the change into ITS settings, wrote those
-- over the file the new instance had just written, and broadcast them. Same disease, and
-- the same cure, as Discovery's own LIVE.
local LIVE = {}

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
    local onRequest   = opts.onRequest
    local onAfterSave = opts.onAfterSave
    local where       = ('%s/%s'):format(resName, file)

    local liveKey = ('%s|%s|%s'):format(resName, file, tostring(section))
    if LIVE[liveKey] then LIVE[liveKey]:dispose() end

    local settings = {}
    local disposed = false
    local handles = {}
    -- The decode error, while the file on disk is one this instance could not read. Its
    -- contents are then not in `settings`, so a save would replace them with defaults.
    local unreadable = nil

    local function loadFromFile()
        local data, state, detail = Discovery.readJson(resName, file)
        if state == 'corrupt' then
            unreadable = detail
            log(('%s is not valid JSON (%s), so its settings did not load and the defaults are in'
                .. ' use. It has NOT been changed, and nothing will be saved over it. Fix the file'
                .. ' and restart %s.'):format(where, tostring(detail), resName), 4)
            return {}
        end
        if not data then return {} end
        if not section then return data end
        return type(data[section]) == "table" and data[section] or {}
    end

    --- @return boolean  false when the settings did not reach the disk
    local function saveToFile()
        -- Demo mode keeps the change in `settings` (already updated by the
        -- caller) and off disk, so it lasts the session and no longer. `Demo` is
        -- tLib's own copy of the module consumers reach as `tlib.demo`.
        if Demo and Demo.dropWrite(where) then return true end

        -- Read again, not remembered: sibling sections may have changed since load.
        local data, state, detail = Discovery.readJson(resName, file)
        if state == 'corrupt' or unreadable then
            log(('%s is not valid JSON (%s), so it is not being overwritten. This change is in'
                .. ' effect until a restart and is not saved. Fix the file and restart %s.')
                :format(where, tostring(state == 'corrupt' and detail or unreadable), resName), 4)
            return false
        end

        local document = settings
        if section then
            -- Replace our section and write the rest back, so siblings survive.
            document = data or {}
            document[section] = settings
        end
        local encodedOk, encoded = pcall(json.encode, document)
        if not encodedOk then
            log(('Failed to encode %s for save: %s'):format(where, tostring(encoded)), 4)
            return false
        end

        -- A bare SaveResourceFile here is refused for every resource but tLib, and returns
        -- false rather than raising -- so this used to report nothing and persist nothing.
        local ok, err = Discovery.saveFile(resName, file, encoded)
        if not ok then
            log(('Could not write %s — %s These settings will be gone after a restart.')
                :format(where, tostring(err)), 4)
            return false
        end
        return true
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

    --- Set, save and broadcast. Returns whether the save reached the disk.
    function inst:set(key, value)
        settings[key] = value
        local saved = saveToFile()
        inst:broadcast()
        return saved
    end

    --- Deep-merge, save and broadcast. Returns whether the save reached the disk.
    function inst:merge(changes)
        if type(changes) ~= "table" then return false end
        deepMerge(settings, changes)
        local saved = saveToFile()
        inst:broadcast()
        return saved
    end

    --- Persist without broadcasting. Returns whether the save reached the disk.
    function inst:save()
        return saveToFile()
    end

    function inst:broadcast()
        if updEvent then
            Platform.TriggerClientEvent(updEvent, -1, { settings = settings })
        end
        if onAfterSave then
            pcall(onAfterSave, settings)
        end
    end

    --- Stop answering. Idempotent: the owner stopping and a re-create can both fire.
    function inst:dispose()
        if disposed then return end
        disposed = true
        for i = #handles, 1, -1 do
            Platform.RemoveEventHandler(handles[i])
            handles[i] = nil
        end
        if LIVE[liveKey] == self then LIVE[liveKey] = nil end
    end

    if reqEvent then
        -- saveEvent is bounded by Permission.registerAdminEvent; requestEvent is
        -- not -- anyone may fire it, and it costs an admin lookup, the onRequest
        -- callback and a full settings payload back down the wire. A floor on the
        -- call interval is enough since the client only fires once per panel open.
        -- Named by event since each consumer's ServerSettings has its own
        -- requestEvent and must not share a budget.
        local requestGate = Platform.rateLimit(reqEvent, 1000)
        handles[#handles + 1] = Platform.AddNetEventHandler(reqEvent, function()
            -- The flag as well as the removal: RemoveEventHandler is not on every build.
            if disposed then return end
            local src = source
            -- Before the admin lookup and the onRequest callback, both of which
            -- are the work this event actually costs. Only a real client is
            -- limited: a server-side emit has source 0 and is not a request
            -- anyone can forge.
            if src and src > 0 and requestGate(src) then return end
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
        handles[#handles + 1] = Permission.registerAdminEvent(saveEvent, function(src, changes)
            if disposed then return end
            if type(changes) ~= "table" then return end
            deepMerge(settings, changes)
            saveToFile()
            -- INFO, not WARN: an admin changing server settings is an audit
            -- line, not a problem.
            log("Server settings updated by player " .. src, 2)
            inst:broadcast()
        end)
    end

    LIVE[liveKey] = inst
    return inst
end

Platform.onResourceStop(function(stopped)
    for key, inst in pairs(LIVE) do
        if key:sub(1, #stopped + 1) == stopped .. '|' then inst:dispose() end
    end
end)

function ServerSettings.registerExports()
    Platform.export('tLib', 'CreateServerSettings', function(opts)
        opts._resourceName = opts._resourceName or GetInvokingResource()
        return ServerSettings.create(opts)
    end)
end
