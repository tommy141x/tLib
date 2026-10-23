-- Server-side marketplace sound utilities — shared across tRadio, tELS, tDetector.

local marketplace = {}

--- The file an install actually wrote, from the install's own metadata:
--- `meta.installedAt` is the absolute path the installer swapped into place,
--- extension included -- bundle.ts takes it from the payload's magic bytes --
--- so nothing needs to guess it.
--- @param slug string
--- @param meta table|nil  the second argument of a `sounds.installed` callback
--- @return string filename, boolean derived  `derived` is false when guessed
local function soundFilename(slug, meta)
    local at = type(meta) == 'table' and meta.installedAt
    if type(at) == 'string' and at ~= '' then
        -- `\\` and not `\`: escaped for the Lua STRING, not for the pattern.
        -- Lua patterns escape with `%`; a lone `\]` is an invalid escape
        -- sequence and the file will not load at all.
        local base = at:match('([^/\\]+)$')
        if base and base ~= '' and base:find('%.') then return base, true end
    end
    return tostring(slug) .. '.wav', false
end
marketplace.soundFilename = soundFilename

--- Upsert {filename, slug} in installedSounds for the given slug.
---
--- WARNING: `meta` IS NOT OPTIONAL IN PRACTICE, even though it is tolerated.
--- Without it the filename is guessed as `slug .. '.wav'`, while the installer
--- writes `.wav`, `.ogg` OR `.mp3` from the payload's magic bytes
--- (`soundExtension` in installer/bundle.ts) -- so a non-WAV tone is recorded
--- under a name that is not on disk, and nothing fails at install time because
--- only the bookkeeping is wrong. Derived here rather than in each consumer,
--- which is how copies of it drift apart.
---
--- @return string|nil conflict  the slug already claiming this filename
function marketplace.upsertSound(installedSounds, slug, meta)
    local newFilename, derived = soundFilename(slug, meta)
    if not derived then
        -- Not silent: a guessed name is the bug this replaced, so it says so
        -- rather than writing a plausible lie.
        print(("[tLib/marketplace] no installedAt for sound '%s'; recording it as '%s'. If the payload was not a WAV this entry names a file that does not exist.")
            :format(tostring(slug), newFilename))
    end
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

--- Clear every tone mapping that points at `filename` -- one left pointing at a
--- deleted file 404s in the NUI rather than falling back, and the device is
--- silent for that event. `flatMap` is `key -> filename`; each entry of
--- `scopedMaps` is `scope -> { key -> filename }`, the per-model and
--- per-pattern tone overrides.
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
--- file -- flat and scoped. `scopedMaps` is optional only for compatibility:
--- the old contract made the caller clean nested maps itself, and callers did.
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
    The sound-overwrite warning used to be broadcast to EVERY PLAYER about an
    admin action, with no handler registered anywhere. tLib carries the
    installing admin's id as `meta.src`, so only they are told; the server log
    is unconditional and the client send is not, because `meta.src` is nil when
    the admin disconnected mid-install.

    Registration is pcall'd because a server may run without
    `tlib_module { 'marketplace' }`: the bridge then answers false rather than
    raising, and the resource still has to come up.
]]

local DEFAULT_LAYOUT_PATH = 'layouts'
local DEFAULT_SOUND_PATH = 'layouts/sounds'

--- Declare one marketplace item type, surviving a server that opted out.
---
--- `warn` and `note` here are SINGLE-ARGUMENT functions, not a logger plus a
--- level: the two level scales in this tree run in OPPOSITE directions, so a
--- shared module passing a number would log routine installs at ERROR. The
--- Node bridge answers `false` rather than raising when the `marketplace`
--- module is not loaded, so a false and a throw get the same message.
---
--- @param kind string  'ui' | 'sound' | …
--- @return boolean  true when tLib accepted the type
function marketplace.registerType(kind, installPath, warn)
    local ok, registered = pcall(function()
        return exports['tLib']:RegisterMarketplaceType(kind, { installPath = installPath })
    end)
    if ok and registered ~= false then return true end
    if type(warn) == 'function' then
        -- NAME WHAT ACTUALLY FAILED. This used to advise adding `tlib_module
        -- { 'marketplace' }` to the fxmanifest, which cannot fix it: imports.lua
        -- lazy-loads on first access of `tlib.<name>`, so a resource reaching
        -- this line has already loaded the module -- it is how it called this
        -- function. The three things that CAN fail are named below, in the order
        -- RegisterMarketplaceType checks them.
        warn(("marketplace type '%s' was not registered. tLib's RegisterMarketplaceType refused it, for one of: an invalid installPath, an invoking resource it could not resolve, or its Node bridge rejecting the registration. tLib's console logs which. Declaring the module does NOT affect this -- modules lazy-load on first access.")
            :format(tostring(kind)))
    end
    return false
end

--- The sound-overwrite warning: logged always, shown to the installing admin.
--- `conflict` is the slug that already owned the filename; `warnEvent` must be
--- a client event the consumer HAS a handler for.
--- @return boolean told  true if a client was actually told
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
---   note / warn  function(message), for routine install lines and for problems
---   layouts      table|false  { path, installed(slug, meta), uninstalled(slug) }
---   sounds       table|false  { path, warnEvent, installed -> conflict,
---                               uninstalled }
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
