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

local function validateOptions(f)
    local opts = {}
    if type(f.options) == 'table' then
        for _, opt in ipairs(f.options) do
            if type(opt) == 'table' and type(opt.value) == 'string' and type(opt.label) == 'string' then
                table.insert(opts, { value = opt.value, label = opt.label })
            end
        end
    end
    return opts
end

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
        tab         = type(f.tab) == 'string' and f.tab or nil,
    }

    if fieldType == 'text' or fieldType == 'number' or
        fieldType == 'password' or fieldType == 'textarea' then
        s.placeholder  = type(f.placeholder) == 'string' and f.placeholder or nil
        s.defaultValue = type(f.defaultValue) == 'string' and f.defaultValue or nil
        if fieldType == 'number' then
            s.min = type(f.min) == 'number' and f.min or nil
            s.max = type(f.max) == 'number' and f.max or nil
        end
    elseif fieldType == 'dropdown' or fieldType == 'select' or fieldType == 'radio' then
        s.options      = validateOptions(f)
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
        -- The confirmation question. `variant = 'destructive'` is COLOUR and
        -- nothing else, so a button that deletes something looked like one and
        -- was still one click away from doing it.
        --
        -- This serialiser is a WHITELIST -- a key it does not name never reaches
        -- the page -- which is why this line is the whole feature on the Lua
        -- side, and why `view` on a tab had to be added for the same reason a
        -- few lines below. Bounded at 512 like a menu row's `confirm` in
        -- `shared/lib/menu/schema.lua`: it is the same key with the same meaning
        -- on a different surface, and the page renders the same two buttons for
        -- both. An empty string is nil, not a question with no text.
        s.confirm = type(f.confirm) == 'string' and f.confirm ~= ''
            and #f.confirm <= 512 and f.confirm or nil
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
    if size ~= 'sm' and size ~= 'md' and size ~= 'lg' and size ~= 'xl' then size = 'md' end

    -- When omitted while fields declare `tab`, the page derives tabs from
    -- first-occurrence order with id == label.
    local tabs = nil
    if type(opts.tabs) == 'table' then
        tabs = {}
        for _, t in ipairs(opts.tabs) do
            if type(t) == 'table' and type(t.id) == 'string' and t.id ~= '' then
                -- `view` names a built-in panel the page renders in place of this
                -- tab's fields (see DialogTab.view in client/web/src/components/
                -- dialog-model.ts). It was missing from this serialiser, so every
                -- `view` tab a consumer declared reached the page as an ordinary
                -- content tab and drew an EMPTY panel -- the tab was there, the
                -- browser was not. Whitelisted rather than passed through: an
                -- unknown view would fall into the same silent blank panel.
                local view = t.view == 'marketplace' and t.view or nil
                if t.view ~= nil and not view then
                    log('ShowDialog: tab "' .. t.id .. '" has unknown view "' ..
                        tostring(t.view) .. '" -- rendering its fields instead', 3)
                end
                table.insert(tabs, {
                    id        = t.id,
                    label     = type(t.label) == 'string' and t.label or t.id,
                    icon      = type(t.icon) == 'string' and t.icon or nil,
                    action    = t.action == true or nil,
                    separator = t.separator == true or nil,
                    view      = view,
                })
            end
        end
        if #tabs == 0 then tabs = nil end
    end

    return {
        id          = id,
        title       = type(opts.title) == 'string' and opts.title or 'Dialog',
        description = type(opts.description) == 'string' and opts.description or nil,
        fields      = fields,
        tabs        = tabs,
        submitLabel = type(opts.submitLabel) == 'string' and opts.submitLabel or nil,
        cancelLabel = type(opts.cancelLabel) == 'string' and opts.cancelLabel or nil,
        size        = size,
        -- Opt OUT of "reopen where you left it". The page remembers the active
        -- tab, each tab's scroll offset and where the panel was dragged to,
        -- keyed by dialog id, so a dialog that closes for a detour (a world
        -- editor, a HUD reposition) comes back on the tab the button was on.
        -- A caller that genuinely wants a first-run dialog passes
        -- `resetState = true`. Sent only when true, and whitelisted here on
        -- purpose: `view` was once absent from this serialiser and reached the
        -- page as nothing at all, silently.
        resetState  = opts.resetState == true or nil,
        blur        = opts.blur ~= false,
        theme       = (type(opts.theme) == 'string' and opts.theme ~= '') and opts.theme or nil,
    }
end

-- Taking NUI focus is a one-way door: only the dialog component's submit/cancel
-- callbacks lead back to unlockPlayerInput. If the page never loads, focus goes to
-- a layer that cannot return it and the player is locked out until they reconnect.
-- That happens for real: .gitignore excludes client/ui/assets/, so a source-archive copy
-- ships an index.html whose script tag 404s and the page never mounts.
--
-- Hence two guards, both inert for a healthy dialog: focus is deferred behind the
-- onNUIReady handshake, and a watchdog covers the page mounting and then dying.

-- Long enough to absorb a cold disk or a heavy join; the bundle normally readies
-- within a second of resource start.
local NUI_READY_TIMEOUT_MS  = 15000

-- Idle time, not lifetime: every dialogChange resets it and the UI emits one per
-- field edit, so this only elapses for a dead page or an AFK player. Shorter risks
-- yanking the cursor from someone still reading.
local FOCUS_IDLE_TIMEOUT_MS = 300000

local _focusWatchdog = nil
local _focusDialogId = nil
local _readyWatchdog = nil
local _readyWarned   = false
local _blurLease     = nil
local _activeDialogId = nil
local _activeOwner    = nil
local _stopped        = false
local _instanceSerial = 0
local _usedIds = {}
local _stoppingOwners = {}

-- Native focus may still be false while a dialog waits in the NUI-ready queue, so
-- other tLib editors check this rather than the focus flag.
function DialogExports.isActive()
    return not _stopped and _activeDialogId ~= nil
end

local function callable(value)
    if type(value) == 'function' then return true end
    local kind = type(value)
    if kind ~= 'table' and kind ~= 'userdata' then return false end
    local mt = getmetatable(value)
    return type(mt) == 'table' and type(mt.__call) == 'function'
end

local function invoke(callback, ...)
    if not callback then return end
    local ok, err = pcall(callback, ...)
    if not ok then log('Dialog callback failed: ' .. tostring(err), 4) end
end

local function ownedEntry(id)
    local entry = DialogState.get(id)
    if entry and entry.owner == Platform.getInvokingResource() then return entry end
end

-- Tokenless replies work for an id's first lifetime only: once reused, an id alone
-- cannot tell an old browser response from a new one.
local function replyEntry(data)
    if type(data) ~= 'table' or type(data.id) ~= 'string' then return nil end
    local entry = DialogState.get(data.id)
    if not entry or _activeDialogId ~= data.id then return nil end
    if data.instance ~= entry.instance
        and not (data.instance == nil and entry.allowLegacyReply) then return nil end
    return entry
end

local function findField(entry, id)
    if type(id) ~= 'string' then return nil end
    for _, field in ipairs(entry.schema.fields) do
        if field.id == id then return field end
    end
end

local function validValue(field, value)
    if field.disabled or field.type == 'button' then return false end
    if field.type == 'checkbox' then return type(value) == 'boolean' end
    if field.type == 'slider' then
        return type(value) == 'number' and value == value and math.abs(value) < math.huge
            and value >= field.min and value <= field.max
    end
    if type(value) ~= 'string' then return false end
    if field.type == 'number' then
        if value == '' and not field.required then return true end
        local n = tonumber(value)
        return n ~= nil and n == n and math.abs(n) < math.huge
            and (not field.min or n >= field.min) and (not field.max or n <= field.max)
    end
    if field.type == 'select' or field.type == 'dropdown' or field.type == 'radio' then
        for _, option in ipairs(field.options) do if option.value == value then return true end end
        return value == '' and not field.required
    end
    return true
end

local function releaseDialogBlur()
    UIEffects.releaseBlur(_blurLease)
    _blurLease = nil
end

local function cancelFocusWatchdog()
    if _focusWatchdog then
        Platform.clearTimeout(_focusWatchdog)
        _focusWatchdog = nil
    end
    _focusDialogId = nil
end

-- NUI focus is a process-wide switch, so a rescue path calling SetNuiFocus(false)
-- blindly could yank the cursor from an unrelated resource's UI. Rescue paths
-- release only what tLib took; the normal close paths stay unconditional.
local function tlibHoldsFocus()
    return _TLIB_NUI_FOCUSED == true or _TLIB_UI_FOCUSED == true
end

local function lockPlayerInput()
    Platform.setIgnoreMoveInput(true)
    Platform.setIgnoreLookInput(true)
end

local function unlockPlayerInput(ui, id)
    -- Late callbacks/CloseDialog for a replaced dialog must not unlock its successor.
    if id and id ~= _activeDialogId then return end
    _activeDialogId, _activeOwner = nil, nil
    releaseDialogBlur()
    -- Every route that gives input back runs through here, so this is the only
    -- place the watchdog needs standing down.
    cancelFocusWatchdog()
    Platform.setInputMode(ui, 0)
    Platform.setIgnoreMoveInput(false)
    Platform.setIgnoreLookInput(false)
end

local _dialogCallbacks = {}

-- Shared teardown for CloseDialog and the focus watchdog. A rescue reports itself
-- as a cancel rather than inventing a third outcome consumers do not handle.
local function closeDialog(ui, id)
    local entry = DialogState.get(id)
    if not entry then return end
    local cbs = _dialogCallbacks[id]
    _dialogCallbacks[id] = nil
    DialogState.remove(id)
    Platform.sendUIEvent(ui, 'closeDialog', { id = id, instance = entry.instance })
    unlockPlayerInput(ui, id)
    Platform.TriggerEvent('tLib:dialog:cancelled', id)
    if cbs and cbs.onCancel then
        invoke(cbs.onCancel)
    end
end

-- Armed when focus is granted, cancelled by unlockPlayerInput on every normal
-- close, so it only fires once the page has stopped talking to us entirely.
local function armFocusWatchdog(ui, id)
    cancelFocusWatchdog()
    _focusDialogId = id
    _focusWatchdog = Platform.setTimeout(function()
        _focusWatchdog = nil
        _focusDialogId = nil
        -- Submitted, cancelled or closed in the meantime: nothing is held.
        if not DialogState.get(id) then return end
        log('Dialog "' .. tostring(id) .. '" has held input focus for '
            .. tostring(math.floor(FOCUS_IDLE_TIMEOUT_MS / 1000)) .. 's without a single message from the '
            .. 'NUI page. Assuming the page stopped responding and closing the dialog so the '
            .. 'player is not left locked out of their controls.', 3)
        closeDialog(ui, id)
    end, FOCUS_IDLE_TIMEOUT_MS)
end

-- A no-op unless a watchdog is already armed for this exact dialog: a stray event
-- must not arm one, or a dialog that never took focus would get a timer that
-- closes it.
local function refreshFocusWatchdog(ui, id)
    if _focusWatchdog and _focusDialogId == id then
        armFocusWatchdog(ui, id)
    end
end

-- Focus is gated on the ready handshake, so nothing is locked in this case. This
-- exists to turn "the command silently does nothing" into a line naming the cause.
local function armNuiReadyWatchdog(ui)
    if _readyWatchdog or _readyWarned then return end
    _readyWatchdog = Platform.setTimeout(function()
        _readyWatchdog = nil
        if Platform.isNUIReady() then return end
        _readyWarned = true
        log('A dialog was requested but tLib\'s NUI page has not reported ready after '
            .. tostring(math.floor(NUI_READY_TIMEOUT_MS / 1000)) .. 's, so no dialog can be shown. This is '
            .. 'almost always missing UI assets: tLib/client/ui/assets/ is excluded by .gitignore, so a '
            .. 'copy taken from the source archive ships an index.html whose script tag 404s and '
            .. 'the page never mounts. Install the packaged release (tLib.zip) instead of a source '
            .. 'download, or build the UI from the tLib folder. Player input has been left with '
            .. 'the game, so nobody is locked out.', 4)
        -- In case some other path grabbed focus first.
        if tlibHoldsFocus() then unlockPlayerInput(ui) end
    end, NUI_READY_TIMEOUT_MS)
end

-- Never grants focus before the page confirms it is listening, because only the
-- page can give it back.
local function acquireFocus(ui, id)
    local entry = DialogState.get(id)
    if not Platform.isNUIReady() then
        armNuiReadyWatchdog(ui)
    end
    Platform.onNUIReady(function()
        -- CloseDialog may have run while the page was still loading.
        if _stopped or _activeDialogId ~= id or DialogState.get(id) ~= entry then return end
        Platform.setInputMode(ui, 1)
        lockPlayerInput()
        -- Acquire before releasing to avoid a flash between blurred dialogs.
        local previous = _blurLease
        _blurLease = entry.schema.blur and UIEffects.acquireBlur(_activeOwner) or nil
        UIEffects.releaseBlur(previous)
        armFocusWatchdog(ui, id)
    end)
end

local function wireEvents(ui)
    Platform.onUIEvent(ui, 'dialogSubmit', function(data)
        local entry = replyEntry(data)
        if not entry or type(data.values) ~= 'table' then return end
        local values = {}
        for id, value in pairs(data.values) do
            local field = findField(entry, id)
            if not field then return end
            -- Disabled fields may be echoed by the renderer but cannot be changed.
            if not field.disabled then
                if not validValue(field, value) then return end
                values[id] = value
            end
        end
        for _, field in ipairs(entry.schema.fields) do
            if field.required and not field.disabled and field.type ~= 'button'
                and (values[field.id] == nil or values[field.id] == '') then return end
        end
        local cbs                 = _dialogCallbacks[data.id]
        _dialogCallbacks[data.id] = nil
        DialogState.remove(data.id)
        Platform.sendUIEvent(ui, 'closeDialog', { id = data.id, instance = entry.instance })
        unlockPlayerInput(ui, data.id)
        Platform.TriggerEvent('tLib:dialog:submitted', data.id, values)
        if cbs and cbs.onSubmit then
            invoke(cbs.onSubmit, values)
        end
    end)

    Platform.onUIEvent(ui, 'dialogChange', function(data)
        local entry = replyEntry(data)
        if not entry then return end
        local field = findField(entry, data.fieldId)
        if not field or not validValue(field, data.value) then return end
        refreshFocusWatchdog(ui, data.id)
        local cbs = _dialogCallbacks[data.id]
        Platform.TriggerEvent('tLib:dialog:changed', data.id, data.fieldId, data.value)
        if DialogState.get(data.id) == entry and cbs then
            invoke(cbs.onChange, data.fieldId, data.value)
        end
    end)

    Platform.onUIEvent(ui, 'dialogButtonClick', function(data)
        local entry = replyEntry(data)
        if not entry then return end
        local field = findField(entry, data.fieldId)
        local allowed = field and field.type == 'button' and not field.disabled
        if not field and type(data.fieldId) == 'string' then
            for _, tab in ipairs(entry.schema.tabs or {}) do
                if tab.id == data.fieldId and tab.action then allowed = true end
            end
        end
        if not allowed then return end
        refreshFocusWatchdog(ui, data.id)
        local cbs = _dialogCallbacks[data.id]
        Platform.TriggerEvent('tLib:dialog:buttonClick', data.id, data.fieldId)
        if DialogState.get(data.id) == entry and cbs then
            invoke(cbs.onButtonClick, data.fieldId)
        end
    end)

    Platform.onUIEvent(ui, 'dialogCancel', function(data)
        if not replyEntry(data) then return end
        local cbs = _dialogCallbacks[data.id]
        _dialogCallbacks[data.id] = nil
        DialogState.remove(data.id)
        unlockPlayerInput(ui, data.id)
        Platform.TriggerEvent('tLib:dialog:cancelled', data.id)
        if cbs and cbs.onCancel then
            invoke(cbs.onCancel)
        end
    end)
end

function DialogExports.register()
    local ui = DialogState.getUI()
    wireEvents(ui)

    Platform.onResourceStop(function(owner)
        _stoppingOwners[owner] = true
        if not _stopped and _activeDialogId and _activeOwner == owner then
            closeDialog(ui, _activeDialogId)
        end
        _stoppingOwners[owner] = nil
    end)
    Platform.onShutdown(function()
        _stopped = true
        if _readyWatchdog then
            Platform.clearTimeout(_readyWatchdog)
            _readyWatchdog = nil
        end
        if _activeDialogId then closeDialog(ui, _activeDialogId) end
        unlockPlayerInput(ui)
        _dialogCallbacks = {}
    end)

    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end

    -- Returns the resolved dialog id, generating one when `id` is nil.
    --
    -- Results arrive both as local events (tLib:dialog:submitted/cancelled) and
    -- through inline callbacks, which are additive rather than a replacement.
    -- onSubmit/onCancel may be passed positionally for backward compatibility, or on
    -- opts alongside onChange and onButtonClick.
    registerExport('ShowDialog', function(id, opts, onSubmit, onCancel)
        if _stopped then return nil end
        if HudLayout and HudLayout.isEditing() then return nil, 'HUD editor is open' end
        if type(opts) ~= 'table' then
            log('ShowDialog: opts must be a table', 4)
            return nil
        end

        if opts.blur ~= nil and type(opts.blur) ~= 'boolean' then
            return nil, 'Dialog blur must be a boolean'
        end

        if opts.resetState ~= nil and type(opts.resetState) ~= 'boolean' then
            return nil, 'Dialog resetState must be a boolean'
        end

        id = (type(id) == 'string' and id ~= '') and id or DialogState.generateId()

        local owner = Platform.getInvokingResource()
        if owner and _stoppingOwners[owner] then return nil, 'Dialog owner is stopping' end
        if DialogState.get(id) and not ownedEntry(id) then return nil, 'Dialog belongs to another resource' end
        local cbs = {
            onSubmit = onSubmit or opts.onSubmit,
            onCancel = onCancel or opts.onCancel,
            onChange = opts.onChange,
            onButtonClick = opts.onButtonClick,
        }
        for _, cb in pairs(cbs) do
            if not callable(cb) then return nil, 'Dialog callback must be callable' end
        end
        local serialised = serialiseDialog(id, opts)
        local seen = {}
        for _, field in ipairs(serialised.fields) do
            if seen[field.id] then return nil, 'Duplicate dialog field id' end
            seen[field.id] = true
        end
        local previousId = _activeDialogId
        local previous = previousId and DialogState.get(previousId)
        local previousCallbacks = previousId and _dialogCallbacks[previousId]
        if previousId then
            _dialogCallbacks[previousId] = nil
            DialogState.remove(previousId)
        end
        cancelFocusWatchdog()
        _instanceSerial = _instanceSerial + 1
        serialised.instance = _instanceSerial
        DialogState.register(id, serialised)
        local entry = DialogState.get(id)
        entry.owner, entry.instance = owner, _instanceSerial
        entry.allowLegacyReply = not _usedIds[id]
        _usedIds[id] = true
        _dialogCallbacks[id] = cbs
        _activeDialogId, _activeOwner = id, owner

        -- Install the successor before notification: a reentrant ShowDialog is
        -- newer and wins. Never let this outer call overwrite or focus it later.
        if previous then
            Platform.sendUIEvent(ui, 'closeDialog', { id = previousId, instance = previous.instance })
            Platform.TriggerEvent('tLib:dialog:cancelled', previousId)
            if previousCallbacks then invoke(previousCallbacks.onCancel) end
        end
        if _stopped or DialogState.get(id) ~= entry or _activeDialogId ~= id then
            return nil, 'Dialog superseded during replacement'
        end
        Platform.bringUIToFront(ui)
        Platform.sendUIEvent(ui, 'showDialog', serialised)
        -- sendUIEvent buffers on the same signal and the adapter flushes it before
        -- running ready callbacks, so the dialog is on screen before focus is taken.
        acquireFocus(ui, id)
        Platform.TriggerEvent('tLib:dialog:opened', id)
        return id
    end)

    -- Merge properties into one field of an open dialog, for cases like filling
    -- select options after an async lookup.
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
        if not ownedEntry(dialogId) then
            log('UpdateDialogField: dialog "' .. dialogId .. '" is not open', 1)
            return
        end

        local entry = ownedEntry(dialogId)
        local field = findField(entry, fieldId)
        if not field then return end
        -- Patches update the validation schema as well as the page.
        local payload = { dialogId = dialogId, fieldId = fieldId, instance = entry.instance }
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
            local candidate = {}
            for key, value in pairs(field) do candidate[key] = value end
            candidate.disabled = false
            candidate.options = payload.options or candidate.options
            if not validValue(candidate, updates.defaultValue) then return end
            payload.defaultValue = updates.defaultValue
        end
        if updates.disabled ~= nil then
            payload.disabled = updates.disabled == true
        end
        if type(updates.label) == 'string' then payload.label = updates.label end
        if field.type == 'button' and (updates.variant == 'default'
            or updates.variant == 'primary' or updates.variant == 'destructive') then
            payload.variant = updates.variant
        end
        for key, value in pairs(payload) do
            if key ~= 'dialogId' and key ~= 'fieldId' and key ~= 'instance' then field[key] = value end
        end
        Platform.sendUIEvent(ui, 'updateDialogField', payload)
    end)

    -- Replaces the fields array without recreating the dialog. Existing values are
    -- preserved; new fields get their defaultValue.
    registerExport('UpdateDialogFields', function(dialogId, fields)
        if type(dialogId) ~= 'string' or dialogId == '' then
            log('UpdateDialogFields: dialogId must be a non-empty string', 3)
            return
        end
        if type(fields) ~= 'table' then
            log('UpdateDialogFields: fields must be a table', 3)
            return
        end
        if not ownedEntry(dialogId) then
            log('UpdateDialogFields: dialog "' .. dialogId .. '" is not open', 1)
            return
        end
        local serialised, seen = {}, {}
        for _, f in ipairs(fields) do
            local sf = serialiseField(f)
            if sf then
                if seen[sf.id] then return end
                seen[sf.id] = true
                table.insert(serialised, sf)
            end
        end
        local entry = ownedEntry(dialogId)
        entry.schema.fields = serialised
        Platform.sendUIEvent(ui, 'updateDialogFields', { dialogId = dialogId, instance = entry.instance, fields = serialised })
    end)

    -- Closes an open dialog and fires tLib:dialog:cancelled. No-op for an id that
    -- already submitted or cancelled.
    registerExport('CloseDialog', function(id)
        if type(id) ~= 'string' or id == '' then
            log('CloseDialog: id must be a non-empty string', 3)
            return
        end
        if not ownedEntry(id) then return end
        closeDialog(ui, id)
    end)
end
