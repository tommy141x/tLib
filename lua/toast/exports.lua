-- tLib/lua/toast/exports.lua

ToastExports     = {}

local log        = Logger.create('tLib/toast')

-- WebUI reference — set once by ToastExports.register(ui)
local ui         = nil

-- separate counter from menus

local _idCounter = 0

local function generateId()
    _idCounter = _idCounter + 1
    return 'tlib_toast_' .. tostring(_idCounter)
end

local VALID_TYPES = {
    success = true,
    error   = true,
    warning = true,
    info    = true,
    loading = true,
}

local function assertUI(fname)
    if not ui then
        log(fname .. ': Toast subsystem not initialised (ui is nil)', 4)
        return false
    end
    return true
end

-- Coerce and validate the toast type.  Falls back to 'info' on bad input.
local function resolveType(t)
    if type(t) == 'string' and VALID_TYPES[t] then return t end
    log('resolveType: unknown type "' .. tostring(t) .. '", defaulting to "info"', 3)
    return 'info'
end

function ToastExports.register(webui)
    ui = webui

    -- Creates a new toast notification and pushes it to the UI.
    -- Toasts are purely informational and non-interactable.
    --
    -- Parameters
    --   id          string|nil   Unique id for this toast.  Pass nil to auto-generate.
    --                            The id is the handle used by UpdateToast / DismissToast.
    --   toastType   string       "success" | "error" | "warning" | "info" | "loading"
    --   title       string       Primary headline text.
    --   description string|nil   Optional supporting detail text shown below the title.
    --   duration    number|nil   Milliseconds before auto-dismiss.
    --                            0 or nil uses the type default:
    --                              success  4000 ms
    --                              error    6000 ms
    --                              warning  5000 ms
    --                              info     4000 ms
    --                              loading  persistent (until DismissToast / UpdateToast)
    --   theme       string|nil   Id of a registered tLib theme to scope this toast's appearance.
    --                            Each toast card is independently themed — other visible toasts
    --                            are unaffected.
    --
    -- Returns the resolved toast id.
    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end

    registerExport('ShowToast', function(id, toastType, title, description, duration, theme)
        if not assertUI('ShowToast') then return nil end

        id            = (type(id) == 'string' and id ~= '') and id or generateId()
        toastType     = resolveType(toastType)
        title         = type(title) == 'string' and title or ''

        local payload = {
            id          = id,
            type        = toastType,
            title       = title,
            description = type(description) == 'string' and description or nil,
            duration    = (type(duration) == 'number' and duration > 0) and duration or nil,
            theme       = (type(theme) == 'string' and theme ~= '') and theme or nil,
        }

        Platform.sendUIEvent(ui, 'showToast', payload)
        Platform.TriggerEvent('tLib:toast:shown', id, toastType, title)
        return id
    end)

    -- Merges partial changes into a live toast in place.
    -- The primary use-case is resolving a "loading" toast to "success" or
    -- "error" after an async operation completes server-side.
    --
    -- Parameters
    --   id      string  The id returned by ShowToast.
    --   changes table   A subset of toast fields to merge:
    --                     type        string   New toast type.
    --                     title       string   New headline text.
    --                     description string   New detail text.
    --                     duration    number   New duration in ms (0 = type default).
    registerExport('UpdateToast', function(id, changes)
        if not assertUI('UpdateToast') then return end
        if type(id) ~= 'string' or id == '' then
            log('UpdateToast: invalid id', 3)
            return
        end
        if type(changes) ~= 'table' then
            log('UpdateToast: changes must be a table', 3)
            return
        end

        local patch = {}

        if type(changes.type) == 'string' then
            patch.type = resolveType(changes.type)
        end
        if type(changes.title) == 'string' then
            patch.title = changes.title
        end
        if type(changes.description) == 'string' then
            patch.description = changes.description
        end
        if type(changes.duration) == 'number' and changes.duration > 0 then
            patch.duration = changes.duration
        end

        if next(patch) == nil then
            log('UpdateToast: no valid changes provided for id "' .. id .. '"', 3)
            return
        end

        Platform.sendUIEvent(ui, 'updateToast', { id = id, changes = patch })
        Platform.TriggerEvent('tLib:toast:updated', id, patch)
    end)

    -- Programmatically removes a single toast before its duration expires.
    -- Essential for dismissing persistent "loading" toasts once the async
    -- work they represent has completed.
    --
    -- Parameters
    --   id  string  The id returned by ShowToast.
    registerExport('DismissToast', function(id)
        if not assertUI('DismissToast') then return end
        if type(id) ~= 'string' or id == '' then
            log('DismissToast: invalid id', 3)
            return
        end
        Platform.sendUIEvent(ui, 'dismissToast', { id = id })
        Platform.TriggerEvent('tLib:toast:dismissed', id)
    end)

    -- Clears every visible toast immediately.
    registerExport('DismissAll', function()
        if not assertUI('DismissAll') then return end
        Platform.sendUIEvent(ui, 'dismissAllToasts', {})
        Platform.TriggerEvent('tLib:toast:dismissedAll')
    end)
end
