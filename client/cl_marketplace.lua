-- Client-side entry for the marketplace panel: opens it, forwards install
-- requests to the server and relays the results back.
--
-- Browsing and previews route through the server (`marketplaceBrowse` /
-- `marketplacePreview` below), not a direct NUI fetch: CEF's origin is
-- `cfx-nui-tLib`, the marketplace sends no Access-Control-Allow-Origin, and a
-- direct fetch returned a body the panel could not read. The one exception is
-- the sound preview, an `<audio src>` — an element load is exempt from CORS.

local log = Logger.create('tLib/marketplace')

-- The payload both entry points send. Identical on purpose: the embedded
-- browser in a dialog tab and the standalone modal are the same component, so
-- anything that reached one and not the other -- previewState most of all --
-- would break previewing a layout before installing it in exactly one of them.
local MARKETPLACE_TABS = { uis = true, sounds = true, installed = true }

local function buildPayload(opts)
    local baseUrl = StudioApi.baseUrl()
    return {
        resource         = type(opts.resource)         == 'string' and opts.resource         or nil,
        -- Unknown tab = every render branch skipped = blank panel. Both ends clamp.
        initialTab       = MARKETPLACE_TABS[opts.initialTab] and opts.initialTab or nil,
        baseUrl          = baseUrl,
        installedSlugs   = type(opts.installedSlugs)   == 'table'  and opts.installedSlugs   or nil,
        installedLayouts = type(opts.installedLayouts) == 'table'  and opts.installedLayouts or nil,
        installedSounds  = type(opts.installedSounds)  == 'table'  and opts.installedSounds  or nil,
        previewFn        = type(opts.previewFn)        == 'string' and opts.previewFn        or nil,
        previewState     = type(opts.previewState)     == 'table'  and opts.previewState     or nil,
        -- Where this consumer serves tRadio's offline dispatch panel, for a
        -- `theme` item's live preview. The consumer's own URL, because only it
        -- knows whether that file is published by its fxmanifest at all.
        panelPreviewUrl  = type(opts.panelPreviewUrl)   == 'string' and opts.panelPreviewUrl  or nil,
    }
end

local function registerExports()
    --- `opts.resource` scopes the catalogue to one product; `opts.initialTab`
    --- picks 'uis' or 'sounds'. There is no per-TYPE filter: `opts.type` was
    --- forwarded here for a while and nothing in the browser ever read it.
    --- See `OpenData` in shared/ts/marketplace/ui/types.ts.
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
    -- Does not touch NUI focus or send `openMarketplace`: the host dialog
    -- already owns the focus and surface, and stacking the modal on top of it
    -- is the overlay-on-an-overlay this exists to replace. Same payload as
    -- OpenMarketplace, different action, so a consumer can switch by name alone.
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
        log(('marketplaceInstall: bad data - %s'):format(json.encode(data or {})), 3)
        return
    end
    local version = type(data.version) == 'string' and data.version or ''
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

-- Liking goes through the server for identity, not CORS: a like is
-- de-duplicated on the player's FiveM license, which only works if the
-- license is something they cannot choose. This VM cannot establish that —
-- anything the NUI or client reports is player-controlled — so the payload
-- carries only a slug and a desired state; the server resolves identity itself
-- from the event's `source`. Never add a license, identifier or player name to
-- this payload: it would let a player like as somebody else.
RegisterNUICallback('marketplaceLike', function(data, cb)
    cb(1)
    if type(data) ~= 'table' or type(data.requestId) ~= 'string' or type(data.slug) ~= 'string' then return end
    -- `next` is the state being asked for rather than a toggle, so a retry after
    -- a timeout cannot invert anything. `== true` keeps a missing value meaning
    -- un-like, which is the direction that adds nothing to a public count.
    TriggerServerEvent('tlib:marketplace:like', { requestId = data.requestId, slug = data.slug, next = data.next == true })
end)
RegisterNetEvent('tlib:marketplace:likeResult', function(result)
    SendNUIMessage({ action = 'marketplaceLikeResult', data = result })
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

-- A theme's published DEFINITION, for the dispatch-panel preview. Relayed as
-- text: this VM never decodes it, because the only check worth making is the
-- frame-contract one the NUI applies before it posts the theme across.
RegisterNUICallback('marketplaceThemeJson', function(data, cb)
    cb(1)
    if type(data) ~= 'table' or type(data.requestId) ~= 'string' or type(data.slug) ~= 'string' then return end
    TriggerServerEvent('tlib:marketplace:themeJson', data)
end)
RegisterNetEvent('tlib:marketplace:themeJsonResult', function(result)
    SendNUIMessage({ action = 'marketplaceThemeJsonResult', data = result })
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
        -- Counts, not a path: the server no longer sends `installedAt`, and these
        -- answer the question an admin watching a progress spinner actually has.
        log(('installed "%s" (%s file(s), %s bytes)'):format(
            tostring(result.slug),
            tostring(result.fileCount or '?'),
            tostring(result.bytesWritten or '?')
        ), 2)
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

registerExports()
