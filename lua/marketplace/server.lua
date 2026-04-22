-- tLib/lua/marketplace/server.lua
--
-- Server-side Lua facade over the Node marketplace bridge. Handles:
--   * exports.tLib:RegisterMarketplaceType(type, opts) — consumer registration
--   * tlib:marketplace:install net event — ACE-gated client requests
--   * firing the consumer's onInstall callback after a successful install
--   * cleaning up callbacks when a consumer resource stops

local log = Logger.create('tLib/marketplace')

-- type -> { resource = string, onInstall = function | nil }
local _typeRegistrations = {}

local function registerExports()
    -- Register an install type. Consumers call this once at boot.
    --
    --   exports['tLib']:RegisterMarketplaceType('ui-radio', {
    --       installPath = 'client/radios',
    --       onInstall   = function(slug, meta)
    --           -- e.g. TriggerClientEvent('myresource:refresh', -1)
    --       end,
    --   })
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

        -- Node side owns the file-write target. Mirror the registration there.
        local ok = exports['tLib']:mpRegisterType(resourceName, itemType, opts.installPath)
        if not ok then
            log('RegisterMarketplaceType: node bridge rejected registration for "' .. itemType .. '"', 3)
            return false
        end

        _typeRegistrations[itemType] = {
            resource  = resourceName,
            onInstall = type(opts.onInstall) == 'function' and opts.onInstall or nil,
        }
        log(('registered "%s" → %s/%s'):format(itemType, resourceName, opts.installPath), 2)
        return true
    end)
end

-- Client → server install request. Rate-limiting and auth live here.
RegisterNetEvent('tlib:marketplace:install', function(itemType, slug, version)
    local src = source
    if type(itemType) ~= 'string' or type(slug) ~= 'string' or type(version) ~= 'string' then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = slug, error = 'invalid install arguments',
        })
        return
    end
    if not IsPlayerAceAllowed(src, 'tlib.admin') then
        TriggerClientEvent('tlib:marketplace:installResult', src, {
            ok = false, slug = slug, error = 'not authorized (needs tlib.admin ACE)',
        })
        return
    end

    exports['tLib']:mpInstall(itemType, slug, version, function(resultJson)
        local decOk, parsed = pcall(json.decode, resultJson)
        if not decOk or type(parsed) ~= 'table' then
            TriggerClientEvent('tlib:marketplace:installResult', src, {
                ok = false, slug = slug, error = 'invalid install response',
            })
            return
        end

        -- Fire the consumer's onInstall only on success.
        if parsed.ok and _typeRegistrations[itemType] and _typeRegistrations[itemType].onInstall then
            local cbOk, cbErr = pcall(
                _typeRegistrations[itemType].onInstall,
                slug,
                { type = itemType, version = version, installedAt = parsed.installedAt }
            )
            if not cbOk then
                log('onInstall callback errored for "' .. itemType .. '": ' .. tostring(cbErr), 3)
            end
        end

        parsed.slug = slug
        TriggerClientEvent('tlib:marketplace:installResult', src, parsed)
    end)
end)

-- Drop callbacks whose owning resource stops, so we don't invoke dangling closures.
AddEventHandler('onResourceStop', function(stopped)
    for itemType, reg in pairs(_typeRegistrations) do
        if reg.resource == stopped then
            _typeRegistrations[itemType] = nil
        end
    end
end)

function MarketplaceServer_Init()
    registerExports()
end

MarketplaceServer_Init()
