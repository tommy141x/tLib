-- tLib/lua/community-configs/server.lua
--
-- Server-side proxy for the community configs API. Provides exports for any
-- tScript to upload or import shared configs without duplicating the HTTP
-- boilerplate or leaking the server hash to the client.
--
-- Exports:
--   exports['tLib']:CommunityConfigsUpload(opts, callback)
--     opts = { script, configType, key, keyLabel, name, serverName, configJson }
--     callback(ok, error) -- called async when the request completes
--
--   exports['tLib']:CommunityConfigsImport(id, callback)
--     callback(ok, configJson, error)

local log = Logger.create('tLib/community-configs')

local BASE_URL = 'https://marketplace.timmygstudios.com'

local function getBaseUrl()
    return GetConvar('tmarketplace_base_url', BASE_URL):gsub('/+$', '')
end

local function registerExports()
    -- Upload a config to the community configs API.
    -- The X-FiveM-Server header is added automatically by FiveM for outbound
    -- requests, so we get server identity for free.
    --
    --   exports['tLib']:CommunityConfigsUpload({
    --       script = "tELS",
    --       configType = "led_layout",
    --       key = "123456789",
    --       keyLabel = "POLICE",
    --       name = "My LED Config",
    --       serverName = "My FiveM Server",
    --       configJson = json.encode(myConfig),
    --   }, function(ok, err)
    --       if ok then ... end
    --   end)
    Platform.export('tLib', 'CommunityConfigsUpload', function(opts, callback)
        if type(opts) ~= 'table' then
            if type(callback) == 'function' then callback(false, 'invalid opts') end
            return
        end
        if type(callback) ~= 'function' then
            log('CommunityConfigsUpload: callback must be a function', 3)
            return
        end

        local script     = type(opts.script)     == 'string' and opts.script     or ''
        local configType = type(opts.configType)  == 'string' and opts.configType or ''
        local key        = type(opts.key)         == 'string' and opts.key        or ''
        local keyLabel   = type(opts.keyLabel)    == 'string' and opts.keyLabel   or ''
        local name       = type(opts.name)        == 'string' and opts.name       or ''
        local serverName = type(opts.serverName)  == 'string' and opts.serverName or ''
        local configJson = type(opts.configJson)  == 'string' and opts.configJson or ''

        if script == '' or configType == '' or key == '' or name == '' or configJson == '' then
            callback(false, 'missing required fields')
            return
        end

        local url  = getBaseUrl() .. '/api/v1/community-configs'
        local body = json.encode({
            script     = script,
            configType = configType,
            key        = key,
            keyLabel   = keyLabel ~= '' and keyLabel or key,
            name       = name,
            serverName = serverName ~= '' and serverName or GetConvar('sv_projectName', 'Unknown Server'),
            configJson = configJson,
        })

        PerformHttpRequest(url, function(status, responseBody)
            if status < 200 or status >= 300 then
                local ok2, parsed = pcall(json.decode, responseBody or '')
                local errMsg = 'HTTP ' .. tostring(status)
                if ok2 and type(parsed) == 'table' and parsed.error then
                    errMsg = tostring(parsed.error)
                end
                log(('upload failed for %s/%s/%s: %s'):format(script, configType, key, errMsg), 3)
                callback(false, errMsg)
                return
            end
            local ok2, parsed = pcall(json.decode, responseBody or '')
            if ok2 and type(parsed) == 'table' and parsed.id then
                log(('uploaded config for %s/%s/%s → id=%s'):format(script, configType, key, parsed.id), 2)
                callback(true, nil, parsed.id)
            else
                callback(false, 'unexpected response')
            end
        end, 'POST', body, { ['Content-Type'] = 'application/json' })
    end)

    -- Fetch a config by ID and increment its import counter.
    -- Returns the configJson so the caller can apply it without a second request.
    --
    --   exports['tLib']:CommunityConfigsImport("some-uuid", function(ok, configJson, err)
    --       if ok then
    --           local cfg = json.decode(configJson)
    --           -- apply cfg...
    --       end
    --   end)
    Platform.export('tLib', 'CommunityConfigsImport', function(id, callback)
        if type(id) ~= 'string' or id == '' then
            if type(callback) == 'function' then callback(false, nil, 'invalid id') end
            return
        end
        if type(callback) ~= 'function' then
            log('CommunityConfigsImport: callback must be a function', 3)
            return
        end

        local url = getBaseUrl() .. '/api/v1/community-configs/' .. id .. '/import'

        PerformHttpRequest(url, function(status, responseBody)
            if status < 200 or status >= 300 then
                local ok2, parsed = pcall(json.decode, responseBody or '')
                local errMsg = 'HTTP ' .. tostring(status)
                if ok2 and type(parsed) == 'table' and parsed.error then
                    errMsg = tostring(parsed.error)
                end
                log(('import failed for id=%s: %s'):format(id, errMsg), 3)
                callback(false, nil, errMsg)
                return
            end
            local ok2, parsed = pcall(json.decode, responseBody or '')
            if ok2 and type(parsed) == 'table' and parsed.ok and parsed.configJson then
                log(('imported config id=%s'):format(id), 2)
                callback(true, parsed.configJson, nil)
            else
                callback(false, nil, 'unexpected response')
            end
        end, 'POST', '', {})
    end)
end

function CommunityConfigsServer_Init()
    registerExports()
end

CommunityConfigsServer_Init()
