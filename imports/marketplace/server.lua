-- tLib/imports/marketplace/server.lua
-- Server-side marketplace sound utilities — shared across tRadio, tELS, tDetector.
-- Loaded into consumer VM via tlib.marketplace.* (not an export).

local marketplace = {}

-- Upsert {filename, slug} in installedSounds for the given slug.
-- Returns the conflicting slug if another slug already claims the same filename, else nil.
function marketplace.upsertSound(installedSounds, slug)
    local newFilename = tostring(slug) .. ".wav"
    local conflict = nil
    for _, s in ipairs(installedSounds) do
        if s.filename == newFilename and s.slug ~= tostring(slug) then
            conflict = s.slug
            break
        end
    end
    local found = false
    for i, s in ipairs(installedSounds) do
        if s.slug == tostring(slug) then
            installedSounds[i] = { filename = newFilename, slug = tostring(slug) }
            found = true
            break
        end
    end
    if not found then
        installedSounds[#installedSounds + 1] = { filename = newFilename, slug = tostring(slug) }
    end
    return conflict
end

-- Remove a sound entry by slug; clean flat toneWavMap references.
-- Returns the removed filename string, or nil if slug not found.
-- Caller is responsible for any per-model/nested map cleanup.
function marketplace.removeSound(installedSounds, toneWavMap, slug)
    local removedFilename = nil
    for i, s in ipairs(installedSounds) do
        if s.slug == tostring(slug) then
            removedFilename = s.filename
            table.remove(installedSounds, i)
            break
        end
    end
    if removedFilename and toneWavMap then
        for key, fname in pairs(toneWavMap) do
            if fname == removedFilename then toneWavMap[key] = nil end
        end
    end
    return removedFilename
end

-- Migrate legacy __builtin__ slugs to filename-derived slugs. Mutates in place.
-- Returns true if any entries were changed.
function marketplace.migrateBuiltinSlugs(installedSounds)
    local changed = false
    for i, s in ipairs(installedSounds) do
        if s.slug == "__builtin__" then
            installedSounds[i] = { filename = s.filename, slug = s.filename:gsub("%.wav$", "") }
            changed = true
        end
    end
    return changed
end

return marketplace
