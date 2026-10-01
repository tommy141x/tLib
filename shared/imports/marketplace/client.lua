-- tLib/shared/imports/marketplace/client.lua
-- Client-side marketplace open helper. Centralizes slug combining + OpenMarketplace call.
-- Loaded into consumer VM via tlib.marketplace.* (not an export).

local marketplace = {}

-- Shared by openPanel and provide. The slug list the browser marks as
-- "installed" is layouts + sounds combined; '__builtin__' is not a marketplace
-- slug and must never be offered for uninstall.
-- layoutSlugs: string[] of discovered layout folder names
-- soundEntries: {filename, slug}[] of installed sounds
-- opts.initialTab: 'uis'|'sounds' (default: 'uis')
-- opts.previewFn: NUI preview callback name string (optional)
-- opts.previewState: table of preview state data (optional)
local function buildOpts(resource, layoutSlugs, soundEntries, opts)
    opts = opts or {}
    local allSlugs = {}
    for _, slug in ipairs(layoutSlugs or {}) do allSlugs[#allSlugs + 1] = slug end
    for _, s in ipairs(soundEntries or {}) do
        if type(s.slug) == 'string' and s.slug ~= '__builtin__' then
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
