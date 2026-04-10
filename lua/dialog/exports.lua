-- tLib/lua/dialog/exports.lua

DialogExports = {}

local log = Logger.create('tLib/dialog')

local VALID_FIELD_TYPES = {
    text     = true,
    number   = true,
    password = true,
    textarea = true,
    select   = true,
    dropdown = true,
    slider   = true,
    checkbox = true,
    radio    = true,
    button   = true,
}

local function serialiseField(f)
    if type(f) ~= 'table' then return nil end

    local fieldType = type(f.type) == 'string' and f.type or 'text'
    if not VALID_FIELD_TYPES[fieldType] then
        log('serialiseField: unknown type "' .. tostring(f.type) .. '", defaulting to "text"', 3)
        fieldType = 'text'
    end

    local id = type(f.id) == 'string' and f.id ~= '' and f.id
    if not id then
        log('serialiseField: field is missing a string id — skipping', 3)
        return nil
    end

    local s = {
        id          = id,
        type        = fieldType,
        label       = type(f.label) == 'string' and f.label or '',
        description = type(f.description) == 'string' and f.description or nil,
        required    = f.required == true,
        disabled    = f.disabled == true,
        section     = type(f.section) == 'string' and f.section or nil,
        row         = type(f.row) == 'string' and f.row or nil,
        flex        = type(f.flex) == 'string' and f.flex or nil,
    }

    if fieldType == 'text' or fieldType == 'number' or
        fieldType == 'password' or fieldType == 'textarea' then
        s.placeholder  = type(f.placeholder) == 'string' and f.placeholder or nil
        s.defaultValue = type(f.defaultValue) == 'string' and f.defaultValue or nil
        if fieldType == 'number' then
            s.min = type(f.min) == 'number' and f.min or nil
            s.max = type(f.max) == 'number' and f.max or nil
        end
    elseif fieldType == 'dropdown' then
        -- Native <select> dropdown — same data shape as select/radio
        local opts = {}
        if type(f.options) == 'table' then
            for _, opt in ipairs(f.options) do
                if type(opt) == 'table' and type(opt.value) == 'string' and type(opt.label) == 'string' then
                    table.insert(opts, { value = opt.value, label = opt.label })
                end
            end
        end
        s.options      = opts
        s.placeholder  = type(f.placeholder) == 'string' and f.placeholder or nil
        s.defaultValue = type(f.defaultValue) == 'string' and f.defaultValue or nil
    elseif fieldType == 'select' or fieldType == 'radio' then
        -- options must be an array of { value, label } tables
        local opts = {}
        if type(f.options) == 'table' then
            for _, opt in ipairs(f.options) do
                if type(opt) == 'table' and type(opt.value) == 'string' and type(opt.label) == 'string' then
                    table.insert(opts, { value = opt.value, label = opt.label })
                end
            end
        end
        s.options      = opts
        s.placeholder  = type(f.placeholder) == 'string' and f.placeholder or nil
        s.defaultValue = type(f.defaultValue) == 'string' and f.defaultValue or nil
    elseif fieldType == 'slider' then
        s.min          = type(f.min) == 'number' and f.min or 0
        s.max          = type(f.max) == 'number' and f.max or 100
        s.step         = type(f.step) == 'number' and f.step or 1
        s.defaultValue = type(f.defaultValue) == 'number' and f.defaultValue or s.min
    elseif fieldType == 'checkbox' then
        s.defaultValue = f.defaultValue == true
    elseif fieldType == 'button' then
        s.variant = type(f.variant) == 'string' and f.variant or 'default'
    end

    return s
end

local function serialiseDialog(id, opts)
    local fields = {}
    if type(opts.fields) == 'table' then
        for _, f in ipairs(opts.fields) do
            local sf = serialiseField(f)
            if sf then table.insert(fields, sf) end
        end
    end

    local size = type(opts.size) == 'string' and opts.size or 'md'
    if size ~= 'sm' and size ~= 'md' and size ~= 'lg' then size = 'md' end

    return {
        id          = id,
        title       = type(opts.title) == 'string' and opts.title or 'Dialog',
        description = type(opts.description) == 'string' and opts.description or nil,
        fields      = fields,
        submitLabel = type(opts.submitLabel) == 'string' and opts.submitLabel or nil,
        cancelLabel = type(opts.cancelLabel) == 'string' and opts.cancelLabel or nil,
        size        = size,
        theme       = (type(opts.theme) == 'string' and opts.theme ~= '') and opts.theme or nil,
    }
end

-- Centralise the two-step input lock/unlock so every close path is consistent.
-- SetInputMode alone does not always release HPlayer move/look locks in Helix,
-- so we explicitly mirror what the menu system does.

local function lockPlayerInput()
    Platform.setIgnoreMoveInput(true)
    Platform.setIgnoreLookInput(true)
end

local function unlockPlayerInput(ui)
    Platform.setInputMode(ui, 0)
    Platform.setIgnoreMoveInput(false)
    Platform.setIgnoreLookInput(false)
end

-- Wired once during DialogExports.register(). Both handlers validate the
-- incoming id, clean up Lua state, then fire the appropriate local event.

-- Callback storage for inline onSubmit/onCancel passed to ShowDialog.
-- Keyed by dialogId. Entries are cleaned up when the dialog is closed.
local _dialogCallbacks = {}

local function wireEvents(ui)
    -- UI → Lua: user submitted the form
    Platform.onUIEvent(ui, 'dialogSubmit', function(data)
        if type(data) ~= 'table' or type(data.id) ~= 'string' then return end
        if not DialogState.get(data.id) then
            log('dialogSubmit: unknown id "' .. data.id .. '"', 3)
            return
        end
        local values              = type(data.values) == 'table' and data.values or {}
        local cbs                 = _dialogCallbacks[data.id]
        _dialogCallbacks[data.id] = nil
        DialogState.remove(data.id)
        unlockPlayerInput(ui)
        -- Fire the local event first so existing event-based consumers work.
        Platform.TriggerEvent('tLib:dialog:submitted', data.id, values)
        -- Then invoke the inline onSubmit callback if one was registered.
        if cbs and cbs.onSubmit then
            cbs.onSubmit(values)
        end
    end)

    -- UI → Lua: a field value changed (for live preview / settings dialogs)
    Platform.onUIEvent(ui, 'dialogChange', function(data)
        if type(data) ~= 'table' or type(data.id) ~= 'string' then return end
        local cbs = _dialogCallbacks[data.id]
        if cbs and cbs.onChange then
            cbs.onChange(data.fieldId, data.value)
        end
        Platform.TriggerEvent('tLib:dialog:changed', data.id, data.fieldId, data.value)
    end)

    -- UI → Lua: a button field was clicked
    Platform.onUIEvent(ui, 'dialogButtonClick', function(data)
        if type(data) ~= 'table' or type(data.id) ~= 'string' then return end
        local cbs = _dialogCallbacks[data.id]
        if cbs and cbs.onButtonClick then
            cbs.onButtonClick(data.fieldId)
        end
        Platform.TriggerEvent('tLib:dialog:buttonClick', data.id, data.fieldId)
    end)

    -- UI → Lua: user dismissed the dialog without submitting
    Platform.onUIEvent(ui, 'dialogCancel', function(data)
        if type(data) ~= 'table' or type(data.id) ~= 'string' then return end
        if not DialogState.get(data.id) then
            log('dialogCancel: unknown id "' .. data.id .. '"', 3)
            return
        end
        local cbs = _dialogCallbacks[data.id]
        _dialogCallbacks[data.id] = nil
        DialogState.remove(data.id)
        unlockPlayerInput(ui)
        -- Fire the local event first so existing event-based consumers work.
        Platform.TriggerEvent('tLib:dialog:cancelled', data.id)
        -- Then invoke the inline onCancel callback if one was registered.
        if cbs and cbs.onCancel then
            cbs.onCancel()
        end
    end)
end

function DialogExports.register()
    local ui = DialogState.getUI()
    wireEvents(ui)

    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end

    -- Serialises the dialog definition, pushes it to the WebUI, and registers
    -- the id so subsequent submit/cancel events can be correlated.
    --
    -- Parameters
    --   id    string | nil   Stable identifier for this dialog instance.
    --                        Pass nil to auto-generate one.
    --                        The same id is echoed back in the result events.
    --
    --   opts  table          Dialog configuration:
    --     title        string          Required. Dialog heading.
    --     description  string | nil    Optional subheading shown below the title.
    --     submitLabel  string | nil    Override the submit button label (default "Submit").
    --     cancelLabel  string | nil    Override the cancel button label (default "Cancel").
    --     size         string | nil    "sm" | "md" | "lg" (default "md").
    --     theme        string | nil    Id of a registered tLib theme to scope this dialog's
    --                                  appearance. Only this dialog is affected — other open
    --                                  UI elements keep their own themes.
    --     fields       table[]         Array of field definition tables.
    --
    --   Field definition (all fields share these base keys):
    --     id           string    Required. Key used in the submitted values table.
    --     type         string    Required. One of:
    --                              "text" | "number" | "password" | "textarea"
    --                              "select" | "radio" | "slider" | "checkbox"
    --     label        string    Display label.
    --     description  string    Optional helper text shown beneath the field.
    --     required     boolean   Mark field as required (visual only — validate server-side).
    --     disabled     boolean   Render field as non-interactive.
    --
    --   Type-specific keys:
    --     text / number / password / textarea:
    --       placeholder   string
    --       defaultValue  string
    --       min, max      number    (number type only — passed as HTML attributes)
    --
    --     select / radio:
    --       options       { value: string, label: string }[]
    --       placeholder   string
    --       defaultValue  string
    --
    --     slider:
    --       min           number  (default 0)
    --       max           number  (default 100)
    --       step          number  (default 1)
    --       defaultValue  number  (defaults to min)
    --
    --     checkbox:
    --       defaultValue  boolean (default false)
    --
    -- Returns the resolved dialog id (string).
    --
    -- Results are delivered as local events AND, when provided, via optional
    -- inline callbacks:
    --
    --   onSubmit(values)   Called with the submitted values table in addition to
    --                      (not instead of) the tLib:dialog:submitted local event.
    --                      values is keyed by field id:
    --                        text/number/password/textarea → string
    --                        select/radio                 → string
    --                        slider                       → number
    --                        checkbox                     → boolean
    --
    --   onCancel()         Called with no arguments in addition to (not instead of)
    --                      the tLib:dialog:cancelled local event.
    --
    --   tLib:dialog:submitted  (dialogId, values)   — always fired
    --   tLib:dialog:cancelled  (dialogId)            — always fired
    --   onSubmit(values)         Called with submitted values table.
    --   onCancel()               Called when dialog is dismissed.
    --   onChange(fieldId, value)  Called when any field value changes (live preview).
    --   onButtonClick(fieldId)   Called when a button-type field is clicked.
    --
    --   Callbacks can be passed as positional args (onSubmit, onCancel) for backward
    --   compat, OR as a table: opts.onSubmit, opts.onCancel, opts.onChange, opts.onButtonClick.
    registerExport('ShowDialog', function(id, opts, onSubmit, onCancel)
        if type(opts) ~= 'table' then
            log('ShowDialog: opts must be a table', 4)
            return nil
        end

        id = (type(id) == 'string' and id ~= '') and id or DialogState.generateId()

        local serialised = serialiseDialog(id, opts)
        DialogState.register(id, serialised)

        -- Collect callbacks from positional args OR from opts table
        local cbs = {}
        cbs.onSubmit     = onSubmit or opts.onSubmit or nil
        cbs.onCancel     = onCancel or opts.onCancel or nil
        cbs.onChange      = opts.onChange or nil
        cbs.onButtonClick = opts.onButtonClick or nil

        if cbs.onSubmit or cbs.onCancel or cbs.onChange or cbs.onButtonClick then
            _dialogCallbacks[id] = cbs
        end

        Platform.bringUIToFront(ui)
        Platform.sendUIEvent(ui, 'showDialog', serialised)
        Platform.setInputMode(ui, 1)
        lockPlayerInput()
        Platform.TriggerEvent('tLib:dialog:opened', id)
        return id
    end)

    -- Updates a single field's properties in an open dialog.
    -- Useful for dynamically updating select/dropdown options after async operations.
    --
    -- Parameters
    --   dialogId  string  The id of the open dialog.
    --   fieldId   string  The id of the field to update.
    --   updates   table   Properties to merge into the field (e.g. { options = {...} }).
    registerExport('UpdateDialogField', function(dialogId, fieldId, updates)
        if type(dialogId) ~= 'string' or dialogId == '' then
            log('UpdateDialogField: dialogId must be a non-empty string', 3)
            return
        end
        if type(fieldId) ~= 'string' or fieldId == '' then
            log('UpdateDialogField: fieldId must be a non-empty string', 3)
            return
        end
        if type(updates) ~= 'table' then
            log('UpdateDialogField: updates must be a table', 3)
            return
        end
        if not DialogState.get(dialogId) then
            log('UpdateDialogField: dialog "' .. dialogId .. '" is not open', 4)
            return
        end

        -- Serialise options if provided
        local payload = { dialogId = dialogId, fieldId = fieldId }
        if updates.options and type(updates.options) == 'table' then
            local opts = {}
            for _, opt in ipairs(updates.options) do
                if type(opt) == 'table' and type(opt.value) == 'string' and type(opt.label) == 'string' then
                    table.insert(opts, { value = opt.value, label = opt.label })
                end
            end
            payload.options = opts
        end
        if updates.defaultValue ~= nil then
            payload.defaultValue = updates.defaultValue
        end
        if updates.disabled ~= nil then
            payload.disabled = updates.disabled == true
        end
        if updates.label ~= nil then
            payload.label = updates.label
        end

        Platform.sendUIEvent(ui, 'updateDialogField', payload)
    end)

    -- Programmatically closes an open dialog and fires tLib:dialog:cancelled.
    -- No-op if the id is not currently registered (already submitted/cancelled).
    --
    -- Parameters
    --   id  string  The id returned by ShowDialog.
    registerExport('CloseDialog', function(id)
        if type(id) ~= 'string' or id == '' then
            log('CloseDialog: id must be a non-empty string', 3)
            return
        end
        if not DialogState.get(id) then return end
        local cbs = _dialogCallbacks[id]
        _dialogCallbacks[id] = nil
        DialogState.remove(id)
        Platform.sendUIEvent(ui, 'closeDialog', { id = id })
        unlockPlayerInput(ui)
        -- Fire the local event first so existing event-based consumers work.
        Platform.TriggerEvent('tLib:dialog:cancelled', id)
        -- Then invoke the inline onCancel callback if one was registered.
        if cbs and cbs.onCancel then
            cbs.onCancel()
        end
    end)
end
