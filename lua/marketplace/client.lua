-- tLib/lua/marketplace/client.lua
--
-- Client-side entry for the marketplace panel. Opens the NUI panel, forwards
-- install requests to the server, and relays results back to the NUI.
--
-- Browse/list/preview requests happen inside the NUI itself (direct fetch
-- against the public API) so there's no need to round-trip through Lua for
-- the common, read-only path. Only install goes server-authoritative.

local log = Logger.create('tLib/marketplace')

-- Base URL contract (marketplace/API.md v0.6):
--   * Default production: https://marketplace.timmygstudios.com (no /api/v1 suffix)
--   * Local dev override: http://localhost:3000/marketplace
-- The NUI appends `/api/v1/items…` itself.
local DEFAULT_BASE_URL = 'https://marketplace.timmygstudios.com'

local function registerExports()
    -- Open the marketplace panel. Typically wired to a button in a tabbed
    -- settings dialog, e.g.:
    --
    --   { id = 'browse', type = 'button', label = 'Browse Marketplace',
    --     onButtonClick = function()
    --         exports['tLib']:OpenMarketplace({ type = 'ui-radio' })
    --     end }
    --
    -- opts:
    --   type  string | nil  Optional filter passed to the panel on open.
    Platform.export('tLib', 'OpenMarketplace', function(opts)
        opts = type(opts) == 'table' and opts or {}
        local baseUrl = GetConvar('tmarketplace_base_url', DEFAULT_BASE_URL)
        -- Strip trailing slashes so the NUI can append paths without duplication.
        baseUrl = baseUrl:gsub('/+$', '')

        SendNUIMessage({
            action = 'openMarketplace',
            data = {
                type    = type(opts.type) == 'string' and opts.type or nil,
                baseUrl = baseUrl,
            },
        })
        SetNuiFocus(true, true)
    end)

    Platform.export('tLib', 'CloseMarketplace', function()
        SendNUIMessage({ action = 'closeMarketplace' })
        SetNuiFocus(false, false)
    end)
end

-- NUI → Lua: user dismissed the panel.
RegisterNUICallback('marketplaceClose', function(_, cb)
    SetNuiFocus(false, false)
    cb('ok')
end)

-- NUI → Lua: install a specific item. Forwarded to server for ACE + install.
RegisterNUICallback('marketplaceInstall', function(data, cb)
    cb(1)
    if type(data) ~= 'table' then return end
    if type(data.type) ~= 'string' or type(data.slug) ~= 'string' or type(data.version) ~= 'string' then
        return
    end
    TriggerServerEvent('tlib:marketplace:install', data.type, data.slug, data.version)
end)

-- Server → client install result — relay to NUI so the panel can update.
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

function MarketplaceClient_Init()
    registerExports()
end

MarketplaceClient_Init()
