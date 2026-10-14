-- The studio-author rule and the display-title rule, each defined once. Both
-- read the manifest and nothing else, which is why they share a file.
--
-- The studio-author rule: the startup banner uses it to decide
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

--- `resource`'s human-visible title: its manifest `name` directive, falling back
--- to the resource name when that is absent, empty or unreadable.
---
--- TEXT AND ONLY TEXT. Branding policy, not an authenticity boundary:
--- manifests are editable, so any resource can claim the studio. Nothing may use
--- it to decide who is ALLOWED to do something -- that is what ACEs are for.
--- Nor is it ever an identifier: not a slug, ACE object, event name, command,
--- statebag or KVP key, filename, cache key, wire field or lookup index. Those
--- stay the resource name. Which is also why the fallback is the resource name
--- rather than an error -- a caller only ever gets a LABEL back, so there is no
--- shape of failure here that can be mistaken for identity.
---
--- Falls back rather than throwing when the metadata natives are absent, the
--- same way isStudioResource above lands on a safe path instead of crashing
--- startup. `name` is declared at most once per manifest, so index 0 is all of
--- it; repeated entries are not a thing the way they are for `author`.
function StudioBranding.displayName(resource)
    if type(resource) ~= 'string' or resource == '' then return '' end
    if type(GetResourceMetadata) ~= 'function' then return resource end
    local read, title = pcall(GetResourceMetadata, resource, 'name', 0)
    if read and type(title) == 'string' then
        local trimmed = title:match('^%s*(.-)%s*$')
        if trimmed ~= '' then return trimmed end
    end
    return resource
end

return StudioBranding
