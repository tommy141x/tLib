-- tLib/lua/marketplace/server.lua
--
-- Coordinates marketplace installs/uninstalls. ACE-gates all requests, then
-- delegates actual file I/O to each consumer resource's own bundled agent
-- (see tLib/ts/src/marketplace/agent.ts). The agent runs inside the consumer's
-- own Node.js VM so fs.writeFileSync/unlinkSync operate on that resource's own
-- path — no cross-resource sandbox permissions required.

local log = Logger.create('tLib/marketplace')

-- type -> { resource, onInstall, onUninstall }
local _typeRegistrations = {}

-- Tracks slugs currently being installed to prevent duplicate concurrent requests.
local _installing = {}

-- Pending token → { src, resourceName, itemType, slug, ver } waiting for agent result.
local _pending = {}

local _seq = 0
local function newToken()
    _seq = _seq + 1
    return tostring(GetGameTimer()) .. '-' .. _seq
end

local function registerExports()
    Platform.export('tLib', 'RegisterMarketplaceType', function(itemType, opts)
        if type(itemType) ~= 'string' or itemType == '' then
            log('RegisterMarketplaceType: type must be a non-empty string', 3)
            return false
        end
        if type(opts) ~= 'table' or type(opts.installPath) ~= 'string' or opts.installPath == '' then
            log('RegisterMarketplaceType: opts.installPath must be a non-empty string', 3)
            return false
        end

        local resourceName = GetInvokingResource()
        if not resourceName or resourceName == '' then
            log('RegisterMarketplaceType: could not resolve invoking resource', 3)
            return false
        end

        -- Mirror into the Node registry for the marketplace UI's installed-list queries.
        local ok = exports['tLib']:mpRegisterType(resourceName, itemType, opts.installPath)
        if not ok then
            log('RegisterMarketplaceType: node bridge rejected registration for "' .. itemType .. '"', 3)
            return false
        end

        local regKey = resourceName .. ':' .. itemType
        _typeRegistrations[regKey] = {
            resource    = resourceName,
            onInstall   = type(opts.onInstall)   == 'function' and opts.onInstall   or nil,
            onUninstall = type(opts.onUninstall) == 'function' and opts.onUninstall or nil,
        }
        log(('registered "%s" → %s/%s'):format(itemType, resourceName, opts.installPath), 2)
        return true
    end)
end

-- Client → server install request. ACE-gated, then delegated to consumer agent.
RegisterNetEvent('tlib:marketplace:install', function(resourceName, itemType, slug, version)
    local src = source
    if type(itemType) ~= 'string' or type(slug) ~= 'string' then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = tostring(slug), error = 'invalid install arguments',
        })
        return
    end

    if not slug:match('^[a-z0-9][a-z0-9%-_]*$') then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = slug, error = 'invalid slug format',
        })
        return
    end

    local ver = type(version) == 'string' and version or ''
    if ver ~= '' and not ver:match('^[a-zA-Z0-9%.%-]+$') then ver = '' end

    if not IsPlayerAceAllowed(src, 'tlib.admin') then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = slug, error = 'not authorized (needs tlib.admin ACE)',
        })
        return
    end

    if _installing[slug] then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = slug, error = 'install already in progress',
        })
        return
    end
    _installing[slug] = true

    local base = GetConvar('tmarketplace_base_url', 'https://marketplace.timmygstudios.com'):gsub('/+$', '')
    local url  = base .. '/api/v1/items/' .. slug .. '/download'
    if ver ~= '' then url = url .. '?version=' .. ver end

    local token = newToken()
    _pending[token] = { src = src, resourceName = resourceName, itemType = itemType, slug = slug, ver = ver }

    TriggerEvent('tlib:marketplace:doInstall:' .. resourceName, {
        url   = url,
        slug  = slug,
        type  = itemType,
        token = token,
    })
end)

-- Client → server uninstall request. ACE-gated, then delegated to consumer agent.
RegisterNetEvent('tlib:marketplace:uninstall', function(resourceName, itemType, slug)
    local src = source
    if type(itemType) ~= 'string' or type(slug) ~= 'string' then
        TriggerClientEvent('tlib:marketplace:uninstallResult', src, {
            ok = false, slug = tostring(slug), error = 'invalid uninstall arguments',
        })
        return
    end
    if not IsPlayerAceAllowed(src, 'tlib.admin') then
        TriggerClientEvent('tlib:marketplace:uninstallResult', src, {
            ok = false, slug = slug, error = 'not authorized (needs tlib.admin ACE)',
        })
        return
    end

    local token = newToken()
    _pending[token] = { src = src, resourceName = resourceName, itemType = itemType, slug = slug, ver = '', isUninstall = true }

    TriggerEvent('tlib:marketplace:doUninstall:' .. resourceName, {
        slug  = slug,
        type  = itemType,
        token = token,
    })
end)

-- Consumer agent fires this when install or uninstall completes.
AddEventHandler('tlib:marketplace:agentResult', function(result)
    if type(result) ~= 'table' or not result.token then return end

    local p = _pending[result.token]
    if not p then return end
    _pending[result.token] = nil

    local regKey = p.resourceName .. ':' .. p.itemType

    if p.isUninstall then
        if result.ok and _typeRegistrations[regKey] and _typeRegistrations[regKey].onUninstall then
            local cbOk, cbErr = pcall(_typeRegistrations[regKey].onUninstall, p.slug, { type = p.itemType })
            if not cbOk then
                log('onUninstall callback errored for "' .. p.itemType .. '": ' .. tostring(cbErr), 3)
            end
        end
        if result.ok then
            TriggerEvent(p.resourceName .. ':marketplace:uninstalled', p.itemType, p.slug)
        end
        result.slug = p.slug
        TriggerClientEvent('tlib:marketplace:uninstallResult', p.src, result)
    else
        _installing[p.slug] = nil

        if result.ok and _typeRegistrations[regKey] and _typeRegistrations[regKey].onInstall then
            local cbOk, cbErr = pcall(_typeRegistrations[regKey].onInstall, p.slug, {
                type = p.itemType, version = p.ver, installedAt = result.installedAt,
            })
            if not cbOk then
                log('onInstall callback errored for "' .. p.itemType .. '": ' .. tostring(cbErr), 3)
            end
        end
        if result.ok then
            TriggerEvent(p.resourceName .. ':marketplace:installed', p.itemType, p.slug, {
                version = p.ver, installedAt = result.installedAt,
            })
        end
        result.slug = p.slug
        TriggerClientEvent('tlib:marketplace:installResult', p.src, result)
    end
end)

-- Drop registrations when a consumer resource stops.
AddEventHandler('onResourceStop', function(stopped)
    for key, reg in pairs(_typeRegistrations) do
        if reg.resource == stopped then _typeRegistrations[key] = nil end
    end
    -- Clean up any pending tokens for the stopped resource.
    for token, p in pairs(_pending) do
        if p.resourceName == stopped then
            _pending[token] = nil
            _installing[p.slug] = nil
        end
    end
end)

function MarketplaceServer_Init()
    registerExports()
end

MarketplaceServer_Init()
