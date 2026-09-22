-- Coordinates requests only; the consumer's bundled agent owns download/disk I/O.
local log = Logger.create('tLib/marketplace')
local _typeRegistrations, _locks, _pending = {}, {}, {}
local PENDING_MS, INSPECTION_PENDING_MS = 75000, 10000
local _seq = 0
local function newToken()
    _seq = _seq + 1
    return tostring(GetGameTimer()) .. '-' .. _seq
end

local function name(value, limit, pattern)
    return type(value) == 'string' and #value > 0 and #value <= limit and value:match(pattern) ~= nil
end
local function resourceName(value)
    return name(value, 128, '^[%w_][%w_%-%.]*$') and not value:find('..', 1, true)
end
local function itemType(value) return name(value, 64, '^[%w_][%w_%-]*$') end
local function slugName(value) return name(value, 128, '^[a-z0-9][a-z0-9%-_]*$') end
local function callable(value)
    if type(value) == 'function' then return value end
    local mt = type(value) == 'table' and getmetatable(value)
    if type(mt) == 'table' and type(mt.__call) == 'function' then return value end
end
local function safeScope(value, limit)
    return type(value) == 'string' and #value <= limit and value or ''
end
local inspectionStatuses = {
    managed = true, modified = true, unverified = true, protected = true,
    missing = true, unsafe = true, unavailable = true,
}
local inspectionLocks = {
    absent = true, identified = true, unidentified = true,
    ['recovery-pending'] = true, unavailable = true,
}
local function sanitizeInspection(p, result)
    if not result.ok then return { ok = false, error = 'local management inspection unavailable' } end
    local data = result.inspection
    if type(data) ~= 'table' or type(data.status) ~= 'string' or not inspectionStatuses[data.status]
        or type(data.lock) ~= 'string' or not inspectionLocks[data.lock]
        or type(data.policyAvailable) ~= 'boolean' then
        return { ok = false, error = 'invalid management inspection response' }
    end
    return { ok = true, inspection = {
        resourceName = p.resourceName, type = p.itemType, slug = p.slug,
        status = data.status, lock = data.lock, policyAvailable = data.policyAvailable,
    } }
end
local function reply(p, result)
    if not p.src then return end
    -- Never trust scope supplied by an agent; bind every response to its request.
    TriggerClientEvent('tlib:marketplace:' .. p.action .. 'Result', p.src, {
        ok = result.ok == true, error = result.error,
        slug = p.slug, resource = p.resourceName, resourceName = p.resourceName,
        type = p.itemType, action = p.action, token = p.token,
        requestId = p.requestId, inspection = result.inspection,
        fileCount = result.fileCount, bytesWritten = result.bytesWritten,
        installedAt = result.installedAt,
    })
end
local function release(p)
    _pending[p.token] = nil
    if _locks[p.key] == p.token then _locks[p.key] = nil end
end
local function fail(p, message)
    release(p)
    reply(p, { ok = false, error = message })
end

Platform.export('tLib', 'RegisterMarketplaceType', function(kind, opts)
    if not itemType(kind) or type(opts) ~= 'table'
        or type(opts.installPath) ~= 'string' or opts.installPath == '' then
        log('RegisterMarketplaceType: invalid type/options', 3)
        return false
    end
    local resource = GetInvokingResource()
    if not resourceName(resource) then
        log('RegisterMarketplaceType: could not resolve invoking resource', 3)
        return false
    end
    local called, ok = pcall(function()
        return exports['tLib']:mpRegisterType(resource, kind, opts.installPath)
    end)
    if not called or not ok then
        log('RegisterMarketplaceType: node bridge rejected registration for "' .. kind .. '"', 3)
        return false
    end
    _typeRegistrations[resource .. ':' .. kind] = {
        resource = resource, onInstall = callable(opts.onInstall), onUninstall = callable(opts.onUninstall),
    }
    return true
end)

local function request(action, resource, kind, slug, version, requestId)
    local p = {
        src = source, resourceName = safeScope(resource, 128), itemType = safeScope(kind, 64),
        slug = safeScope(slug, 128), action = action, token = newToken(), ver = version or '',
        requestId = safeScope(requestId, 128),
    }
    if action == 'inspect' and not name(requestId, 128, '^[%w_%-]+$') then
        reply(p, { ok = false, error = 'invalid inspection request identity' })
        return
    end
    if not resourceName(resource) or not itemType(kind) or not slugName(slug)
        or (version ~= nil and (type(version) ~= 'string' or #version > 64
            or (version ~= '' and not version:match('^[a-zA-Z0-9][a-zA-Z0-9%.%-]*$')))) then
        reply(p, { ok = false, error = 'invalid ' .. action .. ' arguments' })
        return
    end
    if not IsPlayerAceAllowed(p.src, 'tlib.admin') then
        reply(p, { ok = false, error = 'not authorized (needs tlib.admin ACE)' })
        return
    end
    local regKey = resource .. ':' .. kind
    if not _typeRegistrations[regKey] then
        reply(p, { ok = false, error = 'marketplace resource/type is not registered' })
        return
    end
    p.key = regKey .. ':' .. slug
    if _locks[p.key] then
        reply(p, { ok = false, error = 'marketplace operation already in progress' })
        return
    end
    p.registration = _typeRegistrations[regKey]
    _locks[p.key], _pending[p.token] = p.token, p
    -- Download transport must enforce its 60s absolute deadline. Disk work is
    -- synchronous. This is bookkeeping, NOT cancellation of an old agent's I/O.
    SetTimeout(action == 'inspect' and INSPECTION_PENDING_MS or PENDING_MS, function()
        if _pending[p.token] == p then
            fail(p, action == 'inspect'
                and 'management inspection unavailable; the consumer may need an update'
                or 'marketplace agent timed out after 75 seconds; completion unconfirmed')
        end
    end)
    local payload = { slug = slug, type = kind, token = p.token }
    if action == 'install' then
        local base = GetConvar('tmarketplace_base_url', 'https://timmygstudios.com'):gsub('/+$', '')
        payload.url = base .. '/api/v1/items/' .. slug .. '/download'
        if p.ver ~= '' then payload.url = payload.url .. '?version=' .. p.ver end
    end
    local agentAction = ({ install = 'Install', uninstall = 'Uninstall', inspect = 'Inspect' })[action]
    local ok, err = pcall(TriggerEvent,
        'tlib:marketplace:do' .. agentAction .. ':' .. resource, payload)
    if not ok and _pending[p.token] == p then
        log('marketplace agent dispatch failed: ' .. tostring(err), 3)
        fail(p, 'marketplace agent dispatch failed')
    end
end

RegisterNetEvent('tlib:marketplace:install', function(resource, kind, slug, version)
    request('install', resource, kind, slug, version)
end)
RegisterNetEvent('tlib:marketplace:uninstall', function(resource, kind, slug)
    request('uninstall', resource, kind, slug)
end)
RegisterNetEvent('tlib:marketplace:inspect', function(resource, kind, slug, requestId)
    request('inspect', resource, kind, slug, nil, requestId)
end)

-- Local-only event: never RegisterNetEvent. GetInvokingResource is a runtime
-- stack lookup, not a payload identity. Some local bridges have no invoking VM;
-- nil can only be correlated by pending token, not authenticated as a producer.
AddEventHandler('tlib:marketplace:agentResult', function(result)
    if type(result) ~= 'table' or type(result.token) ~= 'string' or type(result.ok) ~= 'boolean' then return end
    local p = _pending[result.token]
    if not p then return end
    local invoking = GetInvokingResource()
    if invoking ~= nil and invoking ~= p.resourceName then return end
    if p.action == 'inspect' then
        result = sanitizeInspection(p, result)
        if p.src and not IsPlayerAceAllowed(p.src, 'tlib.admin') then
            result = { ok = false, error = 'not authorized (needs tlib.admin ACE)' }
        end
    end
    release(p) -- retire before callbacks: duplicate/reentrant results are stale
    local reg = p.registration
    if result.ok and p.action ~= 'inspect' then
        local cb = p.action == 'install' and reg.onInstall or nil
        if p.action == 'uninstall' then cb = reg.onUninstall end
        local meta = { type = p.itemType, version = p.ver, installedAt = result.installedAt }
        if cb then
            local ok, err = pcall(cb, p.slug, meta)
            if not ok then log('marketplace callback errored: ' .. tostring(err), 3) end
        end
        if p.action == 'install' then
            TriggerEvent(p.resourceName .. ':marketplace:installed', p.itemType, p.slug, {
                version = p.ver, installedAt = result.installedAt,
            })
        else
            TriggerEvent(p.resourceName .. ':marketplace:uninstalled', p.itemType, p.slug)
        end
    end
    reply(p, result)
end)

AddEventHandler('onResourceStop', function(stopped)
    for key, reg in pairs(_typeRegistrations) do
        if reg.resource == stopped then _typeRegistrations[key] = nil end
    end
    for _, p in pairs(_pending) do
        if p.resourceName == stopped or stopped == GetCurrentResourceName() then
            fail(p, 'marketplace resource stopped; completion unconfirmed')
        end
    end
end)
AddEventHandler('playerDropped', function()
    local dropped = source
    for _, p in pairs(_pending) do
        -- A disconnect cannot cancel the agent. Keep the lock until result or
        -- deadline, but never send the result to a recycled player ID.
        if p.src == dropped then p.src = nil end
    end
end)
