-- Server-side proxy for the community configs API, so a consuming resource
-- neither repeats the HTTP boilerplate nor sees the server hash.
--
-- No HTTP happens here: every export below is a thin wrapper over the `cc*`
-- exports registered by server/community-configs/bridge.ts, which holds the
-- credential. The two original exports keep their names and their exact
-- callback signatures, because tELS calls them.
--
-- The publish endpoint requires `X-Resource-Secret`, carrying the baked-in
-- TLIB_PUBLIC_KEY from shared/ts/marketplace/catalogue.ts. The header name must
-- not change -- every shipped copy sends it. It is NOT a convar, and it is not
-- handed to this VM through an export: either would let any third-party script
-- on a customer's server read it without console or file access.

local log = Logger.create('tLib/community-configs')

--- Is this value callable?
---
--- NOT the same as `type(v) == 'function'`, and the difference is why these
--- exports were silently dead. A Lua function passed ACROSS a resource
--- boundary does not arrive as a function: the runtime rebuilds it on this
--- side as a funcref, which is callable but reports a different `type()`.
--- Every real caller is in another resource — that is the entire point of an
--- export — so a plain `type() == 'function'` test rejects precisely the
--- callers it exists to serve, and rejects them into a log line nobody reads.
local function isCallable(value)
    if type(value) == 'function' then return true end
    local mt = getmetatable(value)
    return mt ~= nil and type(mt.__call) == 'function'
end

--- Every cc* export answers (ok, err, value). One adapter so a signature
--- change in the bridge breaks in one place rather than five.
local function guardCallback(callback, label)
    if not isCallable(callback) then
        log(('%s: callback must be callable (got %s)'):format(label, type(callback)), 3)
        return nil
    end
    return callback
end

local function registerExports()
    --- opts = { script, configType, key, keyLabel, name, description,
    ---          serverName, configJson, fp, publisher }, callback(ok, err, id).
    ---
    --- `fp` is the model fingerprint from tELS's shared/model_fingerprint.lua
    --- and is OPTIONAL — without it a config can still be found by exact model
    --- key, just not by geometry, so an un-updated consumer keeps working.
    ---
    --- `publisher` = { name, identifiers } is ATTRIBUTION, not authentication.
    --- It is what this server claims about the publishing player: a display
    --- name for the listing and a handle to ban. The API treats it that way.
    Platform.export('tLib', 'CommunityConfigsUpload', function(opts, callback)
        if type(opts) ~= 'table' then
            if isCallable(callback) then callback(false, 'invalid opts') end
            return
        end
        callback = guardCallback(callback, 'CommunityConfigsUpload')
        if not callback then return end

        local script     = type(opts.script)     == 'string' and opts.script     or ''
        local configType = type(opts.configType) == 'string' and opts.configType or ''
        local key        = type(opts.key)        == 'string' and opts.key        or ''
        local keyLabel   = type(opts.keyLabel)   == 'string' and opts.keyLabel   or ''
        local name       = type(opts.name)       == 'string' and opts.name       or ''
        local serverName = type(opts.serverName) == 'string' and opts.serverName or ''
        local configJson = type(opts.configJson) == 'string' and opts.configJson or ''

        -- A pattern is vehicle-agnostic, so it is the one type with no key.
        -- Requiring one here would make patterns unpublishable.
        local needsKey = configType ~= 'pattern'
        if script == '' or configType == '' or name == '' or configJson == ''
            or (needsKey and key == '') then
            callback(false, 'missing required fields')
            return
        end

        local payload = {
            script      = script,
            configType  = configType,
            name        = name,
            description = type(opts.description) == 'string' and opts.description or '',
            serverName  = serverName ~= '' and serverName
                or GetConvar('sv_projectName', 'Unknown Server'),
            configJson  = configJson,
        }
        if needsKey then
            payload.key      = key
            payload.keyLabel = keyLabel ~= '' and keyLabel or key
        end
        if type(opts.fp) == 'table' then payload.fp = opts.fp end
        if type(opts.publisher) == 'table' then payload.publisher = opts.publisher end

        exports['tLib']:ccPublish(json.encode(payload), function(ok, err, id)
            if not ok or type(id) ~= 'string' or id == '' then
                local errMsg = tostring(err or 'unexpected response')
                log(('upload failed for %s/%s/%s: %s'):format(script, configType, key, errMsg), 3)
                callback(false, errMsg)
                return
            end
            log(('uploaded config for %s/%s/%s → id=%s'):format(script, configType, key, id), 2)
            callback(true, nil, id)
        end)
    end)

    --- Fetch a config by id and increment its import counter. callback(ok,
    --- configJson, err) carries the config so no second request is needed.
    ---
    --- Note the argument ORDER here is (ok, configJson, err), not the
    --- (ok, err, value) the bridge uses. It is the shipped signature tELS
    --- already calls and is not reordered to match.
    Platform.export('tLib', 'CommunityConfigsImport', function(id, callback)
        if type(id) ~= 'string' or id == '' then
            if isCallable(callback) then callback(false, nil, 'invalid id') end
            return
        end
        callback = guardCallback(callback, 'CommunityConfigsImport')
        if not callback then return end

        exports['tLib']:ccImport(id, function(ok, err, configJson)
            if not ok or type(configJson) ~= 'string' then
                local errMsg = tostring(err or 'unexpected response')
                log(('import failed for id=%s: %s'):format(id, errMsg), 3)
                callback(false, nil, errMsg)
                return
            end
            log(('imported config id=%s'):format(id), 2)
            callback(true, configJson, nil)
        end)
    end)

    --- Fetch a config by id WITHOUT incrementing its import counter.
    --- callback(ok, configJson, err), the same payload CommunityConfigsImport
    --- hands back.
    ---
    --- The ONLY difference from CommunityConfigsImport is that this does not
    --- count. Use it whenever the config is being read to render or preview it
    --- rather than because a player chose to install it — tELS's marketplace
    --- tab animates a listing's LEDs on hover, and routing that through import
    --- would turn the counter into a measure of mouse movement. Keep the two
    --- separate; do not "simplify" one into the other.
    ---
    --- Same argument ORDER note as above: (ok, configJson, err) out here,
    --- (ok, err, value) from the bridge.
    Platform.export('tLib', 'CommunityConfigsPeek', function(id, callback)
        if type(id) ~= 'string' or id == '' then
            if isCallable(callback) then callback(false, nil, 'invalid id') end
            return
        end
        callback = guardCallback(callback, 'CommunityConfigsPeek')
        if not callback then return end

        exports['tLib']:ccPeek(id, function(ok, err, configJson)
            if not ok or type(configJson) ~= 'string' then
                local errMsg = tostring(err or 'unexpected response')
                log(('peek failed for id=%s: %s'):format(id, errMsg), 3)
                callback(false, nil, errMsg)
                return
            end
            -- No success log, deliberately, where Import has one at level 2.
            -- An import is a discrete user decision and worth a line; a peek
            -- fires on hover and would flood a server console during ordinary
            -- browsing. Failures still log at level 3.
            callback(true, configJson, nil)
        end)
    end)

    --- Browse published configs. callback(ok, items, err) where `items` is a
    --- decoded array. Reads are unauthenticated by design, but NOT reachable
    --- from an in-game panel — the backend sends no Access-Control-Allow-Origin
    --- on /api/v1, so a fetch from `cfx-nui-<resource>` is refused by the
    --- browser after the request itself succeeds. That is precisely why this
    --- export exists: the panel asks the game server, and the server does the
    --- HTTP.
    Platform.export('tLib', 'CommunityConfigsList', function(opts, callback)
        if type(opts) ~= 'table' then
            if isCallable(callback) then callback(false, nil, 'invalid opts') end
            return
        end
        callback = guardCallback(callback, 'CommunityConfigsList')
        if not callback then return end

        local script     = type(opts.script)     == 'string' and opts.script     or ''
        local configType = type(opts.configType) == 'string' and opts.configType or ''
        if script == '' or configType == '' then
            callback(false, nil, 'missing required fields')
            return
        end

        exports['tLib']:ccList(
            script,
            configType,
            type(opts.key) == 'string' and opts.key or '',
            type(opts.limit) == 'number' and opts.limit or 30,
            function(ok, err, itemsJson)
                if not ok then
                    callback(false, nil, tostring(err or 'unexpected response'))
                    return
                end
                local decoded, parsed = pcall(json.decode, itemsJson or '[]')
                callback(true, (decoded and parsed) or {}, nil)
            end
        )
    end)

    --- CANDIDATE configs for a vehicle, by model fingerprint.
    ---
    --- Candidates, NOT matches. Each item carries the publisher's own
    --- fingerprint in `fp`; the caller decides with TELS_FP_Compare. The
    --- similarity algorithm deliberately lives in the consuming resource so it
    --- can be tuned by shipping a resource update rather than a web deploy.
    Platform.export('tLib', 'CommunityConfigsMatch', function(opts, callback)
        if type(opts) ~= 'table' then
            if isCallable(callback) then callback(false, nil, 'invalid opts') end
            return
        end
        callback = guardCallback(callback, 'CommunityConfigsMatch')
        if not callback then return end

        if type(opts.fp) ~= 'table' then
            callback(false, nil, 'fingerprint required')
            return
        end

        exports['tLib']:ccMatch(
            type(opts.script) == 'string' and opts.script or '',
            type(opts.configType) == 'string' and opts.configType or 'led_layout',
            json.encode(opts.fp),
            type(opts.key) == 'string' and opts.key or '',
            type(opts.limit) == 'number' and opts.limit or 30,
            function(ok, err, itemsJson)
                if not ok then
                    callback(false, nil, tostring(err or 'unexpected response'))
                    return
                end
                local decoded, parsed = pcall(json.decode, itemsJson or '[]')
                callback(true, (decoded and parsed) or {}, nil)
            end
        )
    end)
end

registerExports()
