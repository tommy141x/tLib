-- Client-side entry for the marketplace panel: opens it, forwards install
-- requests to the server and relays the results back.
--
-- Browsing and previews are fetched by the NUI directly against the public API.
-- Anything that inspects or writes locally goes through the server.

local log = Logger.create('tLib/marketplace')

-- No /api/v1 suffix and no subdomain: the NUI appends `/api/v1/items...` itself.
-- Overridable for local dev with tmarketplace_base_url.
local DEFAULT_BASE_URL = 'https://timmygstudios.com'

local function registerExports()
    --- `opts.type` filters the panel on open, e.g. OpenMarketplace({ type = 'ui-radio' }).
    Platform.export('tLib', 'OpenMarketplace', function(opts)
        opts = type(opts) == 'table' and opts or {}
        local baseUrl = GetConvar('tmarketplace_base_url', DEFAULT_BASE_URL)
        baseUrl = baseUrl:gsub('/+$', '')

        local resource       = type(opts.resource)       == 'string' and opts.resource       or nil
        local initialTab     = type(opts.initialTab)     == 'string' and opts.initialTab     or nil
        local installedSlugs = type(opts.installedSlugs) == 'table'  and opts.installedSlugs or nil
        local installedLayouts = type(opts.installedLayouts) == 'table' and opts.installedLayouts or nil
        local installedSounds  = type(opts.installedSounds)  == 'table' and opts.installedSounds  or nil
        local previewFn      = type(opts.previewFn)      == 'string' and opts.previewFn      or nil
        local previewState   = type(opts.previewState)   == 'table'  and opts.previewState   or nil

        SendNUIMessage({
            action = 'openMarketplace',
            data = {
                resource         = resource,
                initialTab       = initialTab,
                type             = type(opts.type) == 'string' and opts.type or nil,
                baseUrl          = baseUrl,
                installedSlugs   = installedSlugs,
                installedLayouts = installedLayouts,
                installedSounds  = installedSounds,
                previewFn        = previewFn,
                previewState     = previewState,
            },
        })
        SetNuiFocus(true, true)
    end)

    Platform.export('tLib', 'CloseMarketplace', function()
        SendNUIMessage({ action = 'closeMarketplace' })
        SetNuiFocus(false, false)
    end)
end

RegisterNUICallback('marketplaceClose', function(_, cb)
    SetNuiFocus(false, false)
    cb('ok')
end)

-- Forwarded to the server, which owns the ACE check and the install.
RegisterNUICallback('marketplaceInstall', function(data, cb)
    cb(1)
    if type(data) ~= 'table' then return end
    if type(data.resource) ~= 'string' or type(data.type) ~= 'string' or type(data.slug) ~= 'string' then
        print('[tLib/marketplace] marketplaceInstall NUI callback: bad data - ' .. json.encode(data or {}))
        return
    end
    local version = type(data.version) == 'string' and data.version or ''
    print('[tLib/marketplace] marketplaceInstall NUI callback: firing server event type=' .. data.type .. ' slug=' .. data.slug .. ' version=' .. version)
    TriggerServerEvent('tlib:marketplace:install', data.resource or '', data.type, data.slug, version)
end)

RegisterNUICallback('marketplaceUninstall', function(data, cb)
    cb(1)
    if type(data) ~= 'table' then return end
    if type(data.type) ~= 'string' or type(data.slug) ~= 'string' then return end
    TriggerServerEvent('tlib:marketplace:uninstall', data.resource or '', data.type, data.slug)
end)

-- Read-only, but still server-side: it needs the ACE and a registered resource.
RegisterNUICallback('marketplaceInspect', function(data, cb)
    cb(1)
    if type(data) ~= 'table' or type(data.resource) ~= 'string'
        or type(data.type) ~= 'string' or type(data.slug) ~= 'string'
        or type(data.requestId) ~= 'string' then return end
    TriggerServerEvent('tlib:marketplace:inspect', data.resource, data.type, data.slug, data.requestId)
end)
RegisterNetEvent('tlib:marketplace:inspectResult', function(result)
    SendNUIMessage({ action = 'marketplaceInspectResult', data = result })
end)

RegisterNetEvent('tlib:marketplace:installResult', function(result)
    SendNUIMessage({ action = 'marketplaceInstallResult', data = result })
    if type(result) == 'table' and result.ok then
        log(('installed "%s" → %s'):format(tostring(result.slug), tostring(result.installedAt)), 2)
    else
        log(('install failed for "%s": %s'):format(
            tostring(result and result.slug or '?'),
            tostring(result and result.error or 'unknown')
        ), 3)
    end
end)

RegisterNetEvent('tlib:marketplace:uninstallResult', function(result)
    SendNUIMessage({ action = 'marketplaceUninstallResult', data = result })
    if type(result) == 'table' and result.ok then
        log(('uninstalled "%s"'):format(tostring(result.slug)), 2)
    else
        log(('uninstall failed for "%s": %s'):format(
            tostring(result and result.slug or '?'),
            tostring(result and result.error or 'unknown')
        ), 3)
    end
end)

function MarketplaceClient_Init()
    registerExports()
end

MarketplaceClient_Init()
