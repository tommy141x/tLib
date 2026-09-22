-- The studio-author rule, defined once. The startup banner uses it to decide
-- whether to print custom art (docs/content/versioncheck.mdx, "Branding"); the menu
-- registry uses it to exempt a resource from the per-owner registration count
-- limits. The two must agree, hence one copy.
--
-- Free of every tLib global -- no Platform, no Logger -- so it can be loaded
-- standalone into a consumer's Lua VM through LoadResourceFile, the way
-- shared/imports/menu/shared.lua loads shared/lib/menu/schema.lua. Keep it dependency-free and
-- keep it in `shared_scripts` and `files`, or one side silently ends up with no
-- rule at all.
--
-- Branding policy, not an authenticity boundary: manifests are editable, so any
-- resource can claim the studio. Nothing may use it to decide who is ALLOWED to
-- do something -- that is what ACEs are for.

StudioBranding = StudioBranding or {}

--- The author string that grants studio branding, lowercased. Comparison ignores
--- case and surrounding whitespace, so `author '  TIMMYG Studios '` counts.
StudioBranding.AUTHOR = 'timmyg studios'

--- Whether `resource`'s own manifest credits the studio. Read from the manifest
--- and nowhere else -- a folder name does not count, nor does a name a caller
--- passes in about itself. Repeated `author` entries and an `authors` list are
--- both recognised.
---
--- False rather than an error when the metadata natives are absent, so a host
--- that cannot answer lands on the unbranded path instead of crashing startup.
function StudioBranding.isStudioResource(resource)
    if type(resource) ~= 'string' or resource == '' then return false end
    if type(GetResourceMetadata) ~= 'function' or type(GetNumResourceMetadata) ~= 'function' then
        return false
    end
    for _, key in ipairs({ 'author', 'authors' }) do
        local counted, count = pcall(GetNumResourceMetadata, resource, key)
        for index = 0, (counted and tonumber(count) or 0) - 1 do
            local read, author = pcall(GetResourceMetadata, resource, key, index)
            if read and type(author) == 'string'
                and author:match('^%s*(.-)%s*$'):lower() == StudioBranding.AUTHOR then
                return true
            end
        end
    end
    return false
end

return StudioBranding
