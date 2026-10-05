-- tLib/shared/imports/marketplace/server.lua
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


--[[============================================================================
    The standard two item types, and the warning that was dead in four copies.

        tlib.marketplace.standardTypes(GetCurrentResourceName(), {
            note = function(m) log(m, tlib.logger.DEBUG) end,
            warn = function(m) log(m, tlib.logger.WARN) end,
            layouts = {
                installed   = function(slug, meta) rescanAndBroadcastLayouts() end,
                uninstalled = function(slug) rescanAndBroadcastLayouts() end,
            },
            sounds = {
                warnEvent   = 'tdet:soundOverwriteWarning',
                installed   = function(slug, meta)
                    local conflict = sounds:install(slug)
                    broadcastSoundConfig()
                    return conflict
                end,
                uninstalled = function(slug) sounds:uninstall(slug); broadcastSoundConfig() end,
            },
        })

    ── Why this exists ─────────────────────────────────────────────────────────

    Four resources — tDetector, tRadar, tELS and tRadio — each declare the same
    two marketplace item types at the same two install paths, each inside the
    same `do … pcall … if not ok or registered == false then log(…) end`
    wrapper, and each then branches a pair of lifecycle handlers on
    `itemType == 'ui'` / `'sound'` under an event name that is nothing but their
    own resource name with a suffix. tRadio registers its two halves 1,100 lines
    apart in the same file, which is how a reader stops noticing they are a pair.

    Nothing in any of that was a decision. What the registration DOES have is a
    safety property worth stating once: it is `pcall`'d because a server may run
    without `tlib_module { 'marketplace' }` opted in, the Node bridge then
    answers `false` rather than raising, and the resource has to come up anyway —
    with a warning naming the fxmanifest line to add, which is the one thing the
    operator can act on. Two of the four copies logged a message that named
    nothing to do.

    ── The overwrite warning, which is the part that was broken ────────────────

    `soundConflict` is here because one bug shipped four times. Installing a
    sound pack whose slug collides with an existing filename fired
    `TriggerClientEvent('<prefix>:soundOverwriteWarning', -1, …)` — a BROADCAST
    to every player, about an admin action — and in three of the four resources
    **nothing anywhere registered the event**: not a client script, not the NUI,
    not the docs. tELS found it first and deleted its copy, leaving a comment
    that the honest fix needed the installing player's id, which tLib did not
    carry at the time. tLib carries it now, as `meta.src` on the lifecycle
    event, so the message can reach the one person who can act on it.

    The server log is UNCONDITIONAL and the client send is not: `meta.src` is nil
    when the admin disconnected mid-install, and the record has to exist whether
    or not anybody saw the toast. A consumer with no client handler for the
    warning passes no `warnEvent` and gets the log alone — which is tELS's
    behaviour today, now by declaration rather than by a deleted send.
==============================================================================]]

local DEFAULT_LAYOUT_PATH = 'layouts'
local DEFAULT_SOUND_PATH = 'layouts/sounds'

--- Declare one marketplace item type, surviving a server that opted out.
---
--- Returns true when tLib accepted it. The Node bridge answers `false` rather
--- than raising when the `marketplace` module is not loaded, so a false and a
--- throw are the same operator-visible condition and get the same message.
---
--- ⚠️ `warn` and `note` throughout this file are SINGLE-ARGUMENT functions, not
--- a logger plus a level. The two level scales in this tree run in OPPOSITE
--- directions: tLib's logger is 1=DEBUG … 4=ERROR, while tRadio's own `log()` in
--- shared/utils.lua is 1=error … 5=trace and filters on `level > _logLevel`. A
--- shared module that passed a number would have logged tRadio's routine
--- installs at ERROR and its registration failures at INFO. Each consumer binds
--- its own level in a one-line closure instead, which is the only portable thing
--- to do and is why there is no `log` option here.
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
--- The callbacks do the consumer's own work in the consumer's own ORDER, which
--- matters: tRadio has to fire its CDN prefetch before the rescan makes the new
--- layout selectable, and has to grant model access before it becomes visible.
--- Only `sounds.installed`'s RETURN VALUE is interpreted — as the conflicting
--- slug — and it goes straight to `soundConflict`.
---
--- Either half may be `false` for a resource that accepts only the other, which
--- is how tRadio's two registrations stop being 1,100 lines apart without its
--- handlers moving.
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
