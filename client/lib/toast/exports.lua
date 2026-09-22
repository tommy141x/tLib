-- tLib/client/lib/toast/exports.lua

ToastExports = {}
local log = Logger.create('tLib/toast')
local ui, stopped = nil, false
local entries, idCounter = {}, 0
local durations = { success = 4000, error = 6000, warning = 5000, info = 4000, loading = 0 }
local MAX_PER_OWNER, MAX_TOTAL = 32, 256

local function caller()
    local owner = Platform.getInvokingResource()
    if type(owner) == 'string' and owner ~= '' then return owner end
    log('Toast export requires an invoking resource', 3)
end

local function wireId(owner, id)
    return tostring(#owner) .. ':' .. owner .. ':' .. id
end

local function validDuration(value)
    return type(value) == 'number' and value >= 0 and value <= 2147483647
end

local function resolveType(value)
    if type(value) == 'string' and durations[value] ~= nil then return value end
    log('Unknown toast type, defaulting to info', 3)
    return 'info'
end

local function remove(key, notify)
    local entry = entries[key]
    if not entry then return false end
    entries[key] = nil
    if entry.timer then Platform.clearTimeout(entry.timer) end
    if notify and ui then Platform.sendUIEvent(ui, 'dismissToast', { id = key }) end
    return true
end

local function schedule(key, entry, duration)
    if entry.timer then Platform.clearTimeout(entry.timer) end
    entry.timer = nil
    -- Fence timers as well as entries: a type/duration update reuses the entry.
    entry.revision = entry.revision + 1
    local revision = entry.revision
    local delay = duration and duration > 0 and duration or durations[entry.type]
    if delay > 0 then
        entry.timer = Platform.setTimeout(function()
            if entries[key] == entry and entry.revision == revision then remove(key, true) end
        end, delay)
    end
end

local function owned(id)
    if stopped or not ui or type(id) ~= 'string' or id == '' then return end
    local owner = caller()
    if not owner then return end
    local key = wireId(owner, id)
    return entries[key], key
end

function ToastExports.register(webui)
    ui = webui

    -- IDs are local to the producer. Return values and public events keep that
    -- local ID; the renderer sees a namespaced ID so producers cannot collide.
    Platform.export('tLib', 'ShowToast', function(id, toastType, title, description, duration, theme)
        if stopped or not ui then return nil end
        local owner = caller()
        if not owner then return nil end
        if type(id) ~= 'string' or id == '' then
            repeat
                idCounter = idCounter + 1
                id = 'tlib_toast_' .. tostring(idCounter)
            until not entries[wireId(owner, id)]
        end
        local key = wireId(owner, id)
        if not entries[key] then
            local total, ownerCount = 0, 0
            for _, entry in pairs(entries) do
                total = total + 1
                if entry.owner == owner then ownerCount = ownerCount + 1 end
            end
            if total >= MAX_TOTAL or ownerCount >= MAX_PER_OWNER then
                return nil, 'Too many active toasts'
            end
        end
        remove(key, false)
        toastType = resolveType(toastType)
        local entry = { owner = owner, id = id, type = toastType, revision = 0 }
        entries[key] = entry
        duration = validDuration(duration) and duration or nil
        title = type(title) == 'string' and title or ''
        Platform.sendUIEvent(ui, 'showToast', {
            id = key, type = toastType, title = title,
            description = type(description) == 'string' and description or nil,
            duration = duration,
            theme = type(theme) == 'string' and theme ~= '' and theme or nil,
        })
        schedule(key, entry, duration)
        Platform.TriggerEvent('tLib:toast:shown', id, toastType, title, owner)
        return id
    end)

    -- Text/theme-only patches retain their deadline. Type changes and explicit
    -- durations restart it; duration=0 restores the current type's default.
    Platform.export('tLib', 'UpdateToast', function(id, changes)
        local entry, key = owned(id)
        if not entry or type(changes) ~= 'table' then return false end
        local patch = {}
        if type(changes.type) == 'string' then patch.type = resolveType(changes.type) end
        if type(changes.title) == 'string' then patch.title = changes.title end
        if type(changes.description) == 'string' then patch.description = changes.description end
        if type(changes.theme) == 'string' then patch.theme = changes.theme end
        if validDuration(changes.duration) then patch.duration = changes.duration end
        if next(patch) == nil then return false end
        if patch.type then entry.type = patch.type end
        if patch.type or patch.duration ~= nil then schedule(key, entry, patch.duration) end
        Platform.sendUIEvent(ui, 'updateToast', { id = key, changes = patch })
        Platform.TriggerEvent('tLib:toast:updated', id, patch, entry.owner)
        return true
    end)

    Platform.export('tLib', 'DismissToast', function(id)
        local entry, key = owned(id)
        if not entry then return false end
        remove(key, true)
        Platform.TriggerEvent('tLib:toast:dismissed', id, entry.owner)
        return true
    end)

    -- Public bulk dismissal is producer-scoped, never a global UI reset.
    Platform.export('tLib', 'DismissAll', function()
        if stopped or not ui then return false end
        local owner = caller()
        if not owner then return false end
        for key, entry in pairs(entries) do
            if entry.owner == owner then remove(key, true) end
        end
        Platform.TriggerEvent('tLib:toast:dismissedAll', owner)
        return true
    end)
end

AddEventHandler('onClientResourceStop', function(owner)
    for key, entry in pairs(entries) do
        if entry.owner == owner then remove(key, true) end
    end
end)

Platform.onShutdown(function()
    stopped = true
    for key in pairs(entries) do remove(key, false) end
    if ui then Platform.sendUIEvent(ui, 'dismissAllToasts', {}) end
    ui = nil
end)
