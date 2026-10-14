-- tLib/shared/imports/marketplace/client.lua
-- Client-side marketplace open helper. Centralizes slug combining + OpenMarketplace call.
-- Loaded into consumer VM via tlib.marketplace.* (not an export).

local marketplace = {}

-- The download URL a NUI needs to render an install before a restart
--
-- FiveM builds a client's file manifest when the resource STARTS, so a file
-- written by a marketplace install 404s over `nui://` until the next restart.
-- The fill is for the NUI to fetch the item from the marketplace itself and
-- serve it from blob: URLs for the session -- `@tlib/shared/runtime-assets` on
-- the TypeScript side. All it needs from Lua is this URL, and it is HERE
-- because four consumers were otherwise going to build the same string.
--
-- Handing this to the NUI does NOT make the item a tWeb dependency. The
-- shared cache HEAD-probes the resource's own file server first and skips the
-- download entirely when it answers -- which it does for every shipped layout,
-- and for an installed one from the first restart onward. That is what lets
-- this be attached to EVERY layout message rather than only to a one-shot
-- install broadcast: a built-in costs one HEAD and no download, and a player
-- who connected after the install (and so missed the broadcast) is covered by
-- the same code path instead of being broken until a restart.
--
-- NO copy of the host and NO `GetConvar` call here. This module runs in the
-- CONSUMER's VM, where tLib's `shared_scripts` were never loaded, so `StudioApi`
-- has to be bootstrapped — the same `LoadResourceFile` + `load` pattern
-- `shared/imports/versioncheck/server.lua` uses, and for the same reason. There
-- is one definition of the default host per language and
-- `tests/unit/marketplace-base-url.test.ts` is what keeps it that way; a fresh
-- literal here would have been a sixth copy of a value that must agree.
if type(StudioApi) ~= 'table' then
    local path = 'shared/sh_api.lua'
    local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
    assert(load(source, '@@tLib/' .. path))()
end

--- The marketplace base URL this client should fetch from.
---
--- Read on every call rather than cached, so an operator changing
--- `tlib_api_base_url` does not need a client rejoin. The ITEM PATH is not
--- built here on purpose: `@tlib/shared/runtime-assets`' `marketplaceItemUrl`
--- owns that shape, and the NUI is the only thing that uses it, so there is no
--- second place for it to drift in.
--- @return string  no trailing slash
function marketplace.baseUrl()
    return StudioApi.baseUrl()
end

-- Shared by openPanel and provide.
--
-- layoutSlugs: string[] of discovered layout FOLDER NAMES -- misnamed, and the
--   name is left alone only because four resources call this positionally. They
--   are not slugs: a folder is 'QRX-720' and the matching marketplace slug is
--   'tradio-qrx-720'.
-- soundEntries: {filename, slug}[] of installed sounds. These slugs ARE real
--   marketplace slugs -- upsertSound writes them from the catalogue slug.
-- opts.initialTab: 'uis'|'sounds' (default: 'uis')
-- opts.previewFn: NUI preview callback name string (optional)
-- opts.previewState: table of preview state data (optional)
--
-- ** installedSlugs CARRIES SOUNDS ONLY, AND THAT IS THE FIX, NOT A TRIM. **
--
-- It used to be layouts + sounds combined, and the browser seeds "this is
-- installed" from it keyed by marketplace slug. Layout FOLDER NAMES in that
-- list are therefore a false claim in the payload itself: nothing named
-- 'QRX-720' is ever a slug, so the seed could only miss, and all eleven shipped
-- radio heads read as not-installed and offered Install for something already
-- on disk. Papering over it in the comparison would have left the next reader
-- the same lie to re-derive.
--
-- The browser now answers the layout question from `installedLayouts` below,
-- where the names are DOCUMENTED as names, via
-- shared/ts/marketplace/local-name.ts -- which also distinguishes a shipped
-- built-in from a marketplace install, because the two need different controls.
--
-- '__builtin__' used to be filtered out here, and there used to be a
-- `marketplace.migrateBuiltinSlugs` rewriting it on three boot paths. BOTH are
-- gone, and the whole mechanism with them: no code in any commit of any repo in
-- this estate has ever WRITTEN that slug, so there was nothing on any disk for
-- the migration to find and nothing for the filter to catch. It read as a live
-- convention worth copying for layouts. It was never one.
local function buildOpts(resource, layoutSlugs, soundEntries, opts)
    opts = opts or {}
    local allSlugs = {}
    for _, s in ipairs(soundEntries or {}) do
        if type(s.slug) == 'string' and s.slug ~= '' then
            allSlugs[#allSlugs + 1] = s.slug
        end
    end
    return {
        resource         = resource,
        initialTab       = opts.initialTab,
        installedSlugs   = allSlugs,
        installedLayouts = layoutSlugs or {},
        installedSounds  = soundEntries or {},
        previewFn        = opts.previewFn,
        previewState     = opts.previewState,
    }
end

-- Open the STANDALONE marketplace modal for a resource. Use this only where
-- there is no host UI to put the browser in -- e.g. opened from tDetector's or
-- tRadar's sounds panel.
function marketplace.openPanel(resource, layoutSlugs, soundEntries, opts)
    exports['tLib']:OpenMarketplace(buildOpts(resource, layoutSlugs, soundEntries, opts))
end

-- Feed the browser embedded in the caller's OWN tLib dialog, for a tab declared
-- `view = "marketplace"`. Opens nothing and takes no focus: the dialog is
-- already open and already has it. Same arguments as openPanel, so a consumer
-- swapping one for the other changes only where the browser appears -- which
-- includes previewState, without which previewing a layout before install
-- silently stops working.
function marketplace.provide(resource, layoutSlugs, soundEntries, opts)
    exports['tLib']:ProvideMarketplaceData(buildOpts(resource, layoutSlugs, soundEntries, opts))
end

return marketplace
