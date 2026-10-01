-- Client-side entry for the marketplace panel: opens it, forwards install
-- requests to the server and relays the results back.
--
-- ⚠️ Browsing and UI previews are NOT fetched by the NUI any more. They used to
-- be, and it could not work: CEF's origin is `cfx-nui-tLib`, the marketplace
-- sends no Access-Control-Allow-Origin, so the browser refused the read and the
-- panel listed nothing in tDetector and tRadar. Both now go NUI → here → the
-- server bundle (`marketplaceBrowse` / `marketplacePreview` below), which also
-- lets them reach v2 and carry the resource filter.
--
-- The sound preview is the deliberate exception: it is an `<audio src>`, and an
-- element load is exempt from CORS. Do not "fix" that one into a fetch.
-- Anything that inspects or writes locally goes through the server.

local log = Logger.create('tLib/marketplace')

-- No /api/v1 suffix and no subdomain: the NUI appends `/api/v1/items...` itself.
-- Overridable for local dev with tmarketplace_base_url; the default and the
-- trailing-slash/`/api` trimming both live in shared/sh_api.lua so this VM, the
-- server VM and a consumer's versioncheck cannot drift apart.

-- The payload both entry points send. Identical on purpose: the embedded
-- browser in a dialog tab and the standalone modal are the same component, so
-- anything that reached one and not the other -- previewState most of all --
-- would break previewing a layout before installing it in exactly one of them.
local function buildPayload(opts)
    local baseUrl = StudioApi.baseUrl()
    return {
        resource         = type(opts.resource)         == 'string' and opts.resource         or nil,
        initialTab       = type(opts.initialTab)       == 'string' and opts.initialTab       or nil,
        type             = type(opts.type)             == 'string' and opts.type             or nil,
        baseUrl          = baseUrl,
        installedSlugs   = type(opts.installedSlugs)   == 'table'  and opts.installedSlugs   or nil,
        installedLayouts = type(opts.installedLayouts) == 'table'  and opts.installedLayouts or nil,
        installedSounds  = type(opts.installedSounds)  == 'table'  and opts.installedSounds  or nil,
        previewFn        = type(opts.previewFn)        == 'string' and opts.previewFn        or nil,
        previewState     = type(opts.previewState)     == 'table'  and opts.previewState     or nil,
    }
end

local function registerExports()
    --- `opts.type` filters the panel on open, e.g. OpenMarketplace({ type = 'ui-radio' }).
    Platform.export('tLib', 'OpenMarketplace', function(opts)
        opts = type(opts) == 'table' and opts or {}
        SendNUIMessage({ action = 'openMarketplace', data = buildPayload(opts) })
        SetNuiFocus(true, true)
    end)

    --- Feed the marketplace browser WITHOUT opening the standalone modal.
    --
    -- This is the integrated path. A consumer whose settings dialog carries a
    -- tab declared `view = "marketplace"` calls this when the server answers
    -- with what is installed; the browser then renders inside that tab.
    --
    -- It deliberately does NOT touch NUI focus and does NOT send
    -- `openMarketplace`. The host dialog already owns the focus and the
    -- surface, and opening the modal on top of it is the overlay-on-an-overlay
    -- this exists to replace. Same payload as OpenMarketplace, different
    -- action, so a consumer can switch between the two by name alone.
    Platform.export('tLib', 'ProvideMarketplaceData', function(opts)
        opts = type(opts) == 'table' and opts or {}
        SendNUIMessage({ action = 'marketplaceData', data = buildPayload(opts) })
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

-- Browsing goes through the server too. It looks like a read the NUI could do
-- itself, and it cannot: CEF's origin is `cfx-nui-tLib` and the marketplace
-- host sends no Access-Control-Allow-Origin, so a direct fetch returns a body
-- the browser will not let the page read. See `server/sv_marketplace.lua`.
RegisterNUICallback('marketplaceBrowse', function(data, cb)
    cb(1)
    if type(data) ~= 'table' or type(data.requestId) ~= 'string' then return end
    TriggerServerEvent('tlib:marketplace:browse', data)
end)
RegisterNetEvent('tlib:marketplace:browseResult', function(result)
    SendNUIMessage({ action = 'marketplaceBrowseResult', data = result })
end)

-- The UI preview DOCUMENT, for the same reason. The sound preview is NOT here:
-- it is an <audio> element pointed at the listing's absolute `preview_url`,
-- which needs neither this round trip nor a credential.
RegisterNUICallback('marketplacePreview', function(data, cb)
    cb(1)
    if type(data) ~= 'table' or type(data.requestId) ~= 'string' or type(data.slug) ~= 'string' then return end
    TriggerServerEvent('tlib:marketplace:preview', data)
end)
RegisterNetEvent('tlib:marketplace:previewResult', function(result)
    SendNUIMessage({ action = 'marketplacePreviewResult', data = result })
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
