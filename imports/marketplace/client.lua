-- tLib/imports/marketplace/client.lua
-- Client-side marketplace open helper. Centralizes slug combining + OpenMarketplace call.
-- Loaded into consumer VM via tlib.marketplace.* (not an export).

local marketplace = {}

-- Open the tLib marketplace panel for a resource.
-- layoutSlugs: string[] of discovered layout folder names
-- soundEntries: {filename, slug}[] of installed sounds
-- opts.initialTab: 'uis'|'sounds' (default: 'uis')
-- opts.previewFn: NUI preview callback name string (optional)
-- opts.previewState: table of preview state data (optional)
function marketplace.openPanel(resource, layoutSlugs, soundEntries, opts)
    opts = opts or {}
    local soundSlugs = {}
    for _, s in ipairs(soundEntries or {}) do
        if type(s.slug) == 'string' and s.slug ~= '__builtin__' then
            soundSlugs[#soundSlugs + 1] = s.slug
        end
    end
    local allSlugs = {}
    for _, slug in ipairs(layoutSlugs or {}) do allSlugs[#allSlugs + 1] = slug end
    for _, slug in ipairs(soundSlugs) do allSlugs[#allSlugs + 1] = slug end
    exports['tLib']:OpenMarketplace({
        resource         = resource,
        initialTab       = opts.initialTab,
        installedSlugs   = allSlugs,
        installedLayouts = layoutSlugs or {},
        installedSounds  = soundEntries or {},
        previewFn        = opts.previewFn,
        previewState     = opts.previewState,
    })
end

return marketplace
