-- Server-side marketplace sound utilities — shared across tRadio, tELS, tDetector.

local marketplace = {}

-- Upsert {filename, slug} in installedSounds for the given slug.
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

--- Clear every tone mapping that points at `filename`. Shared because five call
--- falling back, and the device is silent for that event.
---
--- `flatMap` is `key -> filename`. Each entry of `scopedMaps` is a map of
--- `scope -> { key -> filename }` -- tRadio's per-model tone overrides, tELS's
---
--- @return boolean changed
function marketplace.forgetSoundFile(filename, flatMap, scopedMaps)
    if type(filename) ~= "string" or filename == "" then return false end
    local changed = false

    if type(flatMap) == "table" then
        for key, fname in pairs(flatMap) do
            if fname == filename then
                flatMap[key] = nil
                changed = true
            end
        end
    end

    for _, scoped in ipairs(scopedMaps or {}) do
        if type(scoped) == "table" then
            for scope, map in pairs(scoped) do
                if type(map) == "table" then
                    for key, fname in pairs(map) do
                        if fname == filename then
                            map[key] = nil
                            changed = true
                        end
                    end
                    if next(map) == nil then
                        scoped[scope] = nil
                        changed = true
                    end
                end
            end
        end
    end

    return changed
end

--- Remove a sound entry by slug, and clear every mapping that pointed at its
--- file -- flat and scoped. `scopedMaps` is optional and was added because
--- omitting it was the DEFAULT: the old contract told the caller to clean nested
--- maps itself, and five call sites did.
--- @return string|nil the removed filename, or nil when the slug was not found
function marketplace.removeSound(installedSounds, toneWavMap, slug, scopedMaps)
    local removedFilename = nil
    for i, s in ipairs(installedSounds) do
        if s.slug == tostring(slug) then
            removedFilename = s.filename
            table.remove(installedSounds, i)
            break
        end
    end
    if removedFilename then
        marketplace.forgetSoundFile(removedFilename, toneWavMap, scopedMaps)
    end
    return removedFilename
end


--[[
    The standard two item types, and the warning that was dead in four copies.

        tlib.marketplace.standardTypes(GetCurrentResourceName(), {
            note = ..., warn = ...,
            layouts = { installed = fn, uninstalled = fn },
            sounds  = { warnEvent = 'tdet:soundOverwriteWarning',
                        installed = fn, uninstalled = fn },
        })

    Four resources declared the same two types at the same two paths inside the
    same pcall wrapper, and three of them broadcast a `soundOverwriteWarning` to
    EVERY PLAYER about an admin action -- for which nothing anywhere registered a
    handler. tELS found it and deleted its copy. tLib now carries the installing
    player's id as `meta.src`, so the message reaches the one person who can act
    on it. The server log is unconditional and the client send is not: `meta.src`
    is nil when the admin disconnected mid-install.

    Registration is pcall'd because a server may run without
    `tlib_module { 'marketplace' }`; the bridge then answers false rather than
    raising, and the resource still has to come up -- with a warning naming the
    fxmanifest line to add, which is the one thing the operator can act on.
]]

local DEFAULT_LAYOUT_PATH = 'layouts'
local DEFAULT_SOUND_PATH = 'layouts/sounds'

--- Declare one marketplace item type, surviving a server that opted out.
---
--- `warn` and `note` here are SINGLE-ARGUMENT functions, not a logger plus a
--- level: the two level scales in this tree run in OPPOSITE directions, so a
--- shared module passing a number would log tRadio's routine installs at ERROR.
---
--- Returns true when tLib accepted it. The Node bridge answers `false` rather
--- than raising when the `marketplace` module is not loaded, so a false and a
--- throw are the same operator-visible condition and get the same message.
---
--- @param kind string  'ui' | 'sound' | …
--- @param installPath string
--- @param warn function|nil  function(message)
--- @return boolean
function marketplace.registerType(kind, installPath, warn)
    local ok, registered = pcall(function()
        return exports['tLib']:RegisterMarketplaceType(kind, { installPath = installPath })
    end)
    if ok and registered ~= false then return true end
    if type(warn) == 'function' then
        warn(("marketplace type '%s' was not registered — add `tlib_module { 'marketplace' }` to this resource's fxmanifest to enable it")
            :format(tostring(kind)))
    end
    return false
end

--- The sound-overwrite warning: logged always, shown to the installing admin.
--- @param conflict string|nil   the slug that already owned the filename
--- @param slug string           the slug just installed
--- @param meta table|nil        the lifecycle event's third argument
--- @param warnEvent string|nil  a client event the consumer HAS a handler for
--- @param warn function|nil     function(message)
--- @return boolean told          true if a client was actually told
function marketplace.soundConflict(conflict, slug, meta, warnEvent, warn)
    if not conflict then return false end
    local filename = tostring(slug) .. '.wav'
    if type(warn) == 'function' then
        warn(('marketplace sound overwrite: %s replaced by %s'):format(tostring(conflict), filename))
    end
    local src = meta and meta.src
    if not warnEvent or not src then return false end
    TriggerClientEvent(warnEvent, src, {
        filename = filename,
        newSlug  = tostring(slug),
        oldSlug  = tostring(conflict),
    })
    return true
end

--- Register the standard `ui` and `sound` types and wire their lifecycle.
---
--- @param resourceName string  the lifecycle event prefix; tLib fires
---                             `<resourceName>:marketplace:installed`.
--- @param opts table
---   note     function|nil  function(message), for the routine install lines
---   warn     function|nil  function(message), for a problem
---   layouts  table|false   { path, installed(slug, meta), uninstalled(slug) }
---   sounds   table|false   { path, warnEvent, installed(slug, meta) -> conflict,
---                            uninstalled(slug) }
---
function marketplace.standardTypes(resourceName, opts)
    opts = opts or {}
    local note, warn = opts.note, opts.warn
    local layouts, sounds = opts.layouts, opts.sounds

    if layouts ~= false then
        layouts = layouts or {}
        marketplace.registerType('ui', layouts.path or DEFAULT_LAYOUT_PATH, warn)
    end
    if sounds ~= false then
        sounds = sounds or {}
        marketplace.registerType('sound', sounds.path or DEFAULT_SOUND_PATH, warn)
    end

    local function say(text)
        if type(note) == 'function' then note(text) end
    end

    AddEventHandler(resourceName .. ':marketplace:installed', function(itemType, slug, meta)
        if itemType == 'ui' and layouts ~= false then
            say('marketplace installed ui: ' .. tostring(slug))
            if type(layouts.installed) == 'function' then layouts.installed(slug, meta) end
        elseif itemType == 'sound' and sounds ~= false then
            say('marketplace installed sound: ' .. tostring(slug))
            local conflict
            if type(sounds.installed) == 'function' then conflict = sounds.installed(slug, meta) end
            marketplace.soundConflict(conflict, slug, meta, sounds.warnEvent, warn)
        end
    end)

    AddEventHandler(resourceName .. ':marketplace:uninstalled', function(itemType, slug)
        if itemType == 'ui' and layouts ~= false then
            say('marketplace uninstalled ui: ' .. tostring(slug))
            if type(layouts.uninstalled) == 'function' then layouts.uninstalled(slug) end
        elseif itemType == 'sound' and sounds ~= false then
            say('marketplace uninstalled sound: ' .. tostring(slug))
            if type(sounds.uninstalled) == 'function' then sounds.uninstalled(slug) end
        end
    end)
end

return marketplace
