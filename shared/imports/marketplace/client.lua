-- Client-side marketplace open helper: slug combining plus the OpenMarketplace
-- call. Loaded into the consumer's VM via tlib.marketplace.* (not an export).

local marketplace = {}

-- FiveM builds a client's file manifest at resource START, so a file written by
-- a marketplace install 404s over `nui://` until the next restart. The fix:
-- the NUI fetches the item from the marketplace itself and serves it from
-- blob: URLs for the session (`@tlib/shared/runtime-assets` on the TS side).
-- The shared cache there HEAD-probes the resource's own file server first and
-- skips the download when it answers, which is why this URL is attached to
-- every layout message rather than only a one-shot install broadcast.
--
-- `StudioApi` is bootstrapped here via `LoadResourceFile` + `load` (same as
-- `shared/imports/versioncheck/server.lua`) because this module runs in the
-- CONSUMER's VM, where tLib's `shared_scripts` never loaded. Keep the default
-- host defined once — `tests/unit/marketplace-base-url.test.ts` is what
-- enforces that.
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
-- layoutSlugs: string[] of discovered layout FOLDER NAMES, e.g. 'QRX-720' --
--   not marketplace slugs (which look like 'tradio-qrx-720'). Misnamed, kept
--   because four resources call this positionally.
-- soundEntries: {filename, slug}[] of installed sounds -- these ARE real
--   marketplace slugs, written by upsertSound from the catalogue slug.
-- opts: initialTab ('uis'|'sounds', default 'uis'), previewFn, previewState,
--   panelPreviewUrl (tRadio's offline dispatch panel, for a live theme preview)
--
-- installedSlugs carries sounds only. It used to include layout folder names
-- too, and the browser seeds "installed" from it keyed by marketplace slug --
-- a folder name like 'QRX-720' is never a slug, so all eleven shipped radio
-- heads read as not-installed. The browser now answers the layout question
-- from `installedLayouts` below via shared/ts/marketplace/local-name.ts, which
-- also distinguishes a shipped built-in from a marketplace install.
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
        panelPreviewUrl  = opts.panelPreviewUrl,
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
