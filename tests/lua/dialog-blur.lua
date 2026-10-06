-- Run from tLib root with the existing scripts/run-lua-suite.lua Fengari runner.
-- Real dialog/state, dialog/exports, ui-effects and NUI/lifecycle/shutdown adapters.
local checks = 0
local function eq(actual, expected, message)
    checks = checks + 1
    assert(actual == expected, message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end
local function host(fivem)
    _TLIB_IS_FIVEM, _TLIB_SIDE = fivem, 'client'
    _TLIB_SHUTDOWN_REGISTERED, _TLIB_RESOURCE_STOP_REGISTERED = nil, nil
    _TLIB_NUI_FOCUSED, _TLIB_UI_FOCUSED = false, false
    Logger = { create = function() return function() end end }
    local h = { events = {}, exports = {}, fades = {}, timers = {}, messages = {}, notifications = {}, owner = 'consumer', focused = false }
    function AddEventHandler(name, fn)
        h.events[name] = h.events[name] or {}
        table.insert(h.events[name], fn)
    end
    function h.emit(name, ...)
        for _, fn in ipairs(h.events[name] or {}) do fn(...) end
    end
    function h.nui(name, data) h.emit('__cfx_nui:' .. name, data, function() end) end
    function h.ready() h.nui('__tlib_nui_ready', {}) end
    function GetCurrentResourceName() return 'tLib' end
    function GetInvokingResource() return h.owner end
    function RegisterNuiCallbackType() end
    function SendNUIMessage(message) h.messages[#h.messages + 1] = message end
    function SetNuiFocus(state) h.focused = state end
    function SetNuiFocusKeepInput() end
    function TriggerScreenblurFadeIn(ms)
        eq(h.focused or h.manual, true, 'blur starts only after dialog focus')
        table.insert(h.fades, { 'in', ms })
    end
    function TriggerScreenblurFadeOut(ms) table.insert(h.fades, { 'out', ms }) end
    Platform = {
        _stub = function() return function() end end,
        setIgnoreMoveInput = function(state) h.moveLocked = state end,
        setIgnoreLookInput = function(state) h.lookLocked = state end,
        export = function(_, name, fn) h.exports[name] = fn end,
        TriggerEvent = function(name, ...)
            h.notifications[#h.notifications + 1] = { name, ... }
            if h.notify then h.notify(name, ...) end
        end,
        setTimeout = function(fn, ms)
            local token = {}; h.timers[token] = { fn = fn, ms = ms }; return token
        end,
        clearTimeout = function(token) h.timers[token] = nil end,
    }
    function h.timeout(ms)
        local pending = {}
        for token, timer in pairs(h.timers) do
            if timer.ms == ms then pending[#pending + 1] = { token, timer.fn } end
        end
        for _, pair in ipairs(pending) do h.timers[pair[1]] = nil; pair[2]() end
    end
    -- Full paths, not a shared prefix plus a suffix: these files no longer sit
    -- under one root. The tree a file lives in is now the VM it loads into.
    for _, path in ipairs({
        'shared/lib/adapter/shutdown.lua', 'shared/lib/adapter/lifecycle.lua',
        'shared/lib/adapter/ui.lua', 'client/cl_ui_effects.lua',
        'client/lib/dialog/state.lua', 'client/lib/dialog/exports.lua',
    }) do
        assert(loadfile(path, 't', _G))()
    end
    DialogState.setUI({})
    DialogExports.register()
    function h.show(id, opts) h.exports.ShowDialog(id, opts or { title = 'Test' }) end
    return h
end

local h = host(true)
HudLayout = { isEditing = function() return true end }
local blocked, reason = h.exports.ShowDialog('blocked', { title = 'Test' })
eq(blocked, nil, 'dialog cannot steal HUD editor focus')
eq(reason, 'HUD editor is open', 'blocked dialog explains focus owner')
eq(#h.fades, 0, 'blocked dialog cannot acquire blur')
HudLayout = nil
h.show('pending')
eq(#h.fades, 0, 'request before NUI ready does not blur')
h.timeout(15000)
eq(#h.fades, 0, 'NUI readiness timeout never blurs')
h.exports.CloseDialog('pending')
h.ready()
eq(#h.fades, 0, 'closed pending dialog never acquires late blur')

h = host(true)
h.show('first')
h.show('second')
h.ready()
eq(#h.fades, 1, 'only current pending dialog acquires')
h.exports.CloseDialog('first')
eq(#h.fades, 1, 'stale dialog close cannot release successor blur')
eq(h.focused, true, 'stale close cannot release successor focus')
h.nui('dialogSubmit', { id = 'second', values = {} })
eq(#h.fades, 2, 'submit releases blur')
eq(h.fades[2][1], 'out', 'submit fades out')
eq(h.focused, false, 'submit unlocks input')
h.nui('dialogCancel', { id = 'second' })
eq(#h.fades, 2, 'duplicate close is inert')

h.show('cancel')
h.nui('dialogCancel', { id = 'cancel' })
eq(#h.fades, 4, 'cancel acquires/releases exactly once')
h.show('close')
h.exports.CloseDialog('close')
eq(#h.fades, 6, 'export close acquires/releases exactly once')
h.show('idle')
h.timeout(300000)
eq(#h.fades, 8, 'idle watchdog releases blur')
eq(h.focused, false, 'idle watchdog unlocks input')

h.show('replace')
h.show('replacement')
eq(#h.fades, 9, 'visible replacement does not restart fades')
h.nui('dialogChange', { id = 'replacement', fieldId = 'x', value = 'y' })
eq(#h.fades, 9, 'watchdog refresh never restarts fade')
h.nui('dialogSubmit', { id = 'replace' })
eq(#h.fades, 9, 'stale submit leaves active lease intact')
h.exports.CloseDialog('replacement')
eq(#h.fades, 10, 'replacement releases one shared dialog lease')

h = host(true)
h.show('same')
h.show('same')
h.ready()
eq(#h.fades, 1, 'same-id pending replacement skips old ready callback')
h.exports.CloseDialog('same')
eq(#h.fades, 2, 'same-id replacement leaves no leaked lease')

h = host(true)
h.ready()
h.manual = true
local editor = UIEffects.acquireBlur('editor')
h.show('overlap')
eq(#h.fades, 1, 'dialog joins editor without restarting fade')
h.nui('dialogCancel', { id = 'overlap' })
eq(#h.fades, 1, 'dialog close does not clear editor blur')
UIEffects.releaseBlur({})
UIEffects.releaseBlur(nil)
eq(#h.fades, 1, 'unknown releases do nothing')
UIEffects.releaseBlur(editor)
UIEffects.releaseBlur(editor)
eq(#h.fades, 2, 'last release fades once, repeated release inert')

h.show('owner-stop')
h.emit('onResourceStop', 'unrelated')
eq(#h.fades, 3, 'unrelated resource stop does not clear owned blur')
h.emit('onResourceStop', 'consumer')
eq(#h.fades, 4, 'consumer shutdown releases dialog lease')
eq(h.focused, false, 'consumer shutdown unlocks input')
eq(DialogState.get('owner-stop'), nil, 'consumer shutdown removes dialog')

h.show('shutdown')
h.emit('onResourceStop', 'tLib')
eq(#h.fades, 6, 'tLib shutdown releases active blur once')
eq(h.fades[6][2], 0, 'shutdown uses immediate fade-out')
eq(next(h.timers), nil, 'shutdown clears watchdog timers')
eq(UIEffects.acquireBlur('editor'), nil, 'shutdown refuses new leases')
h.timeout(300000)
eq(#h.fades, 6, 'no late watchdog effects after shutdown')

h = host(true)
h.show('pending-stop')
h.emit('onResourceStop', 'consumer')
h.ready()
eq(#h.fades, 0, 'consumer stop before readiness blocks delayed acquire')
h = host(true)
h.show('pending-shutdown')
h.emit('onResourceStop', 'tLib')
h.ready()
eq(#h.fades, 0, 'tLib stop before readiness blocks delayed acquire')

h = host(false)
h.manual = true
eq(UIEffects.acquireBlur('editor'), nil, 'unsupported platform is a no-op')
h = host(true)
h.manual = true
TriggerScreenblurFadeIn = nil
eq(UIEffects.acquireBlur('editor'), nil, 'missing native is safe')
TriggerScreenblurFadeIn = function() error('native unavailable') end
eq(UIEffects.acquireBlur('editor'), nil, 'throwing native cannot break focus flow')
eq(#h.fades, 0, 'failed acquisition never owns blur')
h.emit('onResourceStop', 'tLib')
eq(#h.fades, 0, 'shutdown never fades unrelated blur without ownership')

h = host(true)
h.ready()
h.show('bad-callback', { onSubmit = function() error('consumer callback failed') end })
local ok = pcall(h.nui, 'dialogSubmit', { id = 'bad-callback', values = {} })
eq(ok, true, 'consumer callback failure is isolated and logged')
eq(#h.fades, 2, 'blur released before consumer callback can throw')
eq(h.focused, false, 'input released before consumer callback can throw')

h = host(true)
h.manual = true
local one = UIEffects.acquireBlur('one')
local two = UIEffects.acquireBlur('two')
h.emit('onResourceStop', 'one')
eq(#h.fades, 1, 'owner cleanup preserves another owner lease')
UIEffects.releaseBlur(one)
eq(#h.fades, 1, 'owner-cleaned token is inert')
UIEffects.releaseBlur(two)
eq(#h.fades, 2, 'remaining owner release fades out')

h = host(true)
h.manual = true
TriggerScreenblurFadeIn = function() return false end
eq(UIEffects.acquireBlur('editor'), nil, 'native refusal does not create a lease')
h.emit('onResourceStop', 'tLib')
eq(#h.fades, 0, 'refused fade-in never causes fade-out')

h = host(true)
h.manual = true
local token = UIEffects.acquireBlur('editor')
TriggerScreenblurFadeOut = function() error('transient failure') end
UIEffects.releaseBlur(token)
TriggerScreenblurFadeOut = function(ms) table.insert(h.fades, { 'out', ms }) end
h.emit('onResourceStop', 'tLib')
eq(#h.fades, 2, 'shutdown retries previously failed fade-out')
eq(h.fades[2][2], 0, 'failed normal fade-out retry is immediate')

h = host(true)
_TLIB_SIDE = 'server'
eq(UIEffects.acquireBlur('editor'), nil, 'server never calls screen natives')
-- Instance lifecycle, owner checks, callable funcrefs and schema validation.
h = host(true)
h.ready()
local cancelled, submitted = 0, 0
local funcref = setmetatable({}, { __call = function(_, values) submitted = submitted + 1 end,
    __index = function() error('Cannot index a funcref') end })
h.show('old', { onCancel = function() cancelled = cancelled + 1 end })
h.show('new', { onSubmit = funcref })
eq(cancelled, 1, 'different-id replacement cancels once')
eq(DialogState.get('old'), nil, 'replacement removes abandoned state')
h.nui('dialogSubmit', { id = 'old', values = {} })
eq(submitted, 0, 'stale different-id submit is ignored')
h.nui('dialogSubmit', { id = 'new', values = {} })
eq(submitted, 1, 'native-style callable table is retained and invoked')

h.show('same', { onCancel = function() cancelled = cancelled + 1 end, onSubmit = funcref })
local oldInstance = DialogState.get('same').instance
h.show('same', {})
local newInstance = DialogState.get('same').instance
eq(cancelled, 2, 'same-id replacement cancels once')
eq(newInstance > oldInstance, true, 'same-id replacement gets a fresh token')
h.nui('dialogSubmit', { id = 'same', instance = oldInstance, values = {} })
h.nui('dialogCancel', { id = 'same' })
eq(DialogState.get('same').instance, newInstance, 'old and tokenless reused-id replies cannot close successor')
h.nui('dialogSubmit', { id = 'same', instance = newInstance, values = {} })
eq(DialogState.get('same'), nil, 'matching token submits successor')
eq(submitted, 1, 'same-id replacement without callbacks clears prior handler')

local reentrantCancelled = 0
h.show('outer-old', { onCancel = function()
    h.show('inner', { onCancel = function() reentrantCancelled = reentrantCancelled + 1 end })
end })
local result = h.exports.ShowDialog('outer-new', { onCancel = function() reentrantCancelled = reentrantCancelled + 1 end })
eq(result, nil, 'outer show reports reentrant supersession')
eq(DialogState.get('outer-old'), nil, 'old reentrant state removed')
eq(DialogState.get('outer-new'), nil, 'superseded successor removed')
eq(DialogState.get('inner') ~= nil, true, 'reentrant newest instance wins')
eq(reentrantCancelled, 1, 'superseded successor cancelled once')
h.exports.CloseDialog('inner')
eq(reentrantCancelled, 2, 'winner cancels once on explicit close')

-- Reentry with the exact same id must not overwrite the newest callbacks/token.
h.show('reuse', { onCancel = function() h.show('reuse', { onSubmit = funcref }) end })
result = h.exports.ShowDialog('reuse', {})
eq(result, nil, 'same-id reentrant show supersedes outer show')
local winning = DialogState.get('reuse').instance
h.nui('dialogSubmit', { id = 'reuse', instance = winning, values = {} })
eq(submitted, 2, 'same-id reentry preserves newest funcref')

local changes, buttons = 0, 0
h.show('owned', { fields = {
    { id = 'enabled', type = 'checkbox' },
    { id = 'amount', type = 'slider', min = 0, max = 10 },
    { id = 'choice', type = 'select', options = { { value = 'a', label = 'A' } } },
    { id = 'locked', type = 'button', disabled = true },
    { id = 'action', type = 'button' },
    -- The confirmation question, which the serialiser is a WHITELIST over: an
    -- unnamed key never reaches the page at all, so a `confirm` that survives
    -- normalisation is the whole Lua side of the feature.
    { id = 'guarded', type = 'button', confirm = 'Really?' },
    { id = 'blankConfirm', type = 'button', confirm = '' },
    { id = 'longConfirm', type = 'button', confirm = string.rep('x', 513) },
    { id = 'valueConfirm', type = 'checkbox', confirm = 'Not a button' },
}, tabs = { { id = 'page' }, { id = 'actionTab', action = true } },
    onChange = function() changes = changes + 1 end,
    onButtonClick = function() buttons = buttons + 1 end,
})
local owned = DialogState.get('owned')
local function reply(event, fieldId, value, instance)
    h.nui(event, { id = 'owned', instance = instance or owned.instance, fieldId = fieldId, value = value })
end
h.owner = 'other'
h.exports.CloseDialog('owned')
h.exports.UpdateDialogField('owned', 'action', { label = 'Hijacked' })
h.exports.UpdateDialogFields('owned', {})
result = h.exports.ShowDialog('owned', {})
eq(result, nil, 'other owner cannot reuse active public id')
eq(DialogState.get('owned'), owned, 'cross-owner close does not remove state')
-- 9, not 5: four `confirm` fixtures were added to the schema above. The count
-- is incidental here -- what this asserts is that the cross-owner
-- `UpdateDialogFields({})` did NOT empty it.
eq(#owned.schema.fields, 9, 'cross-owner field replacement rejected')
eq(owned.schema.fields[5].label, '', 'cross-owner field patch rejected')
h.owner = 'consumer'
reply('dialogChange', 'missing', true)
reply('dialogChange', 'enabled', 'true')
reply('dialogChange', 'amount', 11)
reply('dialogChange', 'amount', 0/0)
reply('dialogChange', 'choice', 'unknown')
reply('dialogChange', 'action', true)
reply('dialogChange', 'enabled', true, owned.instance - 1)
eq(changes, 0, 'invalid fields, values, buttons-as-fields and stale tokens are rejected')
reply('dialogChange', 'enabled', true)
reply('dialogChange', 'amount', 5)
reply('dialogChange', 'choice', 'a')
eq(changes, 3, 'valid typed changes reach callbacks')
reply('dialogButtonClick', 'missing')
reply('dialogButtonClick', 'enabled')
reply('dialogButtonClick', 'locked')
reply('dialogButtonClick', 'page')
eq(buttons, 0, 'unknown, disabled, value fields and non-action tabs cannot fire buttons')
reply('dialogButtonClick', 'action')
reply('dialogButtonClick', 'actionTab')
eq(buttons, 2, 'button fields and action tabs are allowed')
h.exports.UpdateDialogField('owned', 'action', { variant = 'destructive', label = 'Stop' })
eq(owned.schema.fields[5].variant, 'destructive', 'button variant patch updates normalized schema')
eq(owned.schema.fields[6].confirm, 'Really?', 'a button confirm survives normalization')
eq(owned.schema.fields[7].confirm, nil, 'an empty confirm is no confirm, not a blank question')
eq(owned.schema.fields[8].confirm, nil, 'a confirm over 512 chars is dropped, as a menu row is')
eq(owned.schema.fields[9].confirm, nil, 'confirm is button-only: a value field has no click to gate')
-- A confirmed button still fires through the same path; the question lives in
-- the page, so Lua must not gate the click a second time.
reply('dialogButtonClick', 'guarded')
eq(buttons, 3, 'a confirmed button still reaches onButtonClick when the page says so')
h.exports.UpdateDialogField('owned', 'choice', { options = { { value = 'b', label = 'B' } } })
reply('dialogChange', 'choice', 'a')
reply('dialogChange', 'choice', 'b')
eq(changes, 4, 'updated option schema controls callback validation')
h.exports.UpdateDialogFields('owned', { { id = 'replacement', type = 'checkbox' } })
reply('dialogChange', 'enabled', true)
reply('dialogChange', 'replacement', true)
eq(changes, 5, 'replaced schema rejects removed fields')
h.emit('onResourceStop', 'other')
eq(DialogState.get('owned'), owned, 'unrelated stop preserves owned instance')
h.emit('onResourceStop', 'consumer')
eq(DialogState.get('owned'), nil, 'owner stop removes instance')
eq(h.focused, false, 'owner stop releases focus')
local invalid = h.exports.ShowDialog('invalid', { onChange = {} })
eq(invalid, nil, 'plain callback table is rejected before show')
eq(DialogState.get('invalid'), nil, 'invalid callbacks register no state')

h.show('stop-reentry', { onCancel = function() h.show('stop-reopened', {}) end })
h.emit('onResourceStop', 'consumer')
eq(DialogState.get('stop-reopened'), nil, 'stopping owner cannot reopen from cancellation')
eq(h.focused, false, 'stop callback reentry cannot strand focus')

-- Internal calls have nil invokers: only that same nil context can mutate them.
h.owner = nil
h.show('internal', {})
h.owner = 'consumer'
h.exports.CloseDialog('internal')
eq(DialogState.get('internal') ~= nil, true, 'external owner cannot close internal dialog')
h.owner = nil
h.exports.CloseDialog('internal')
eq(DialogState.get('internal'), nil, 'internal caller can close its own dialog')
h.owner = 'consumer'

-- Event listeners may also reenter; no stale inline change callback may run.
h.show('event-owner', { fields = { { id = 'x', type = 'checkbox' } },
    onChange = function() error('stale callback must not run') end })
h.notify = function(name)
    if name == 'tLib:dialog:changed' then h.show('event-new', {}) end
end
h.nui('dialogChange', { id = 'event-owner', fieldId = 'x', value = true })
eq(DialogState.get('event-owner'), nil, 'event reentry terminates previous instance')
eq(DialogState.get('event-new') ~= nil, true, 'event reentry preserves successor')
-- Native blur is optional; focus and the rest of the dialog lifecycle are not.
h = host(true)
local acquisitions = 0
local acquire = UIEffects.acquireBlur
UIEffects.acquireBlur = function(owner)
    acquisitions = acquisitions + 1
    return acquire(owner)
end
h.show('clear-pending', { blur = false })
eq(DialogState.get('clear-pending').schema.blur, false, 'opt-out is stored in normalized schema')
eq(h.focused, false, 'opt-out waits for readiness before taking focus')
h.ready()
eq(h.focused, true, 'ready opt-out takes normal focus')
eq(h.moveLocked, true, 'opt-out locks movement normally')
eq(h.lookLocked, true, 'opt-out locks look normally')
eq(acquisitions, 0, 'opt-out never calls blur acquisition')
h.ready() -- A reloaded renderer repeats the handshake; the adapter treats it as idempotent.
eq(acquisitions, 0, 'repeated renderer readiness cannot acquire opt-out blur')
eq(h.focused, true, 'repeated readiness leaves dialog focus intact')
for _, bad in ipairs({ 'false', 0, {} }) do
    local invalidId, invalidReason = h.exports.ShowDialog('bad-blur', { blur = bad })
    eq(invalidId, nil, 'non-boolean blur rejected')
    eq(invalidReason, 'Dialog blur must be a boolean', 'invalid blur reports reason')
    eq(DialogState.get('bad-blur'), nil, 'invalid blur registers no state')
    eq(DialogState.get('clear-pending') ~= nil, true, 'invalid blur does not replace active dialog')
end
h.show('blurred')
eq(DialogState.get('blurred').schema.blur, true, 'omitted blur defaults to true')
eq(acquisitions, 1, 'clear-to-default replacement acquires blur')
eq(#h.fades, 1, 'clear-to-default replacement fades in once')
h.show('clear', { blur = false })
eq(acquisitions, 1, 'blurred-to-clear replacement does not acquire')
eq(#h.fades, 2, 'blurred-to-clear replacement releases old lease')
eq(h.fades[2][1], 'out', 'blurred-to-clear fades out')
eq(h.focused, true, 'blurred-to-clear preserves focus')
h.exports.CloseDialog('blurred')
eq(h.focused, true, 'stale blurred close cannot unlock clear replacement')
h.exports.CloseDialog('clear')
eq(#h.fades, 2, 'clear close has no extra fade')
eq(h.moveLocked, false, 'clear close restores movement')
eq(h.lookLocked, false, 'clear close restores look')
h.show('explicit', { blur = true })
eq(acquisitions, 2, 'explicit true acquires blur')
h.ready()
eq(acquisitions, 2, 'repeated renderer readiness does not duplicate lease')
h.manual = true
local other = UIEffects.acquireBlur('other-ui')
h.show('clear-overlap', { blur = false })
eq(#h.fades, 3, 'clear replacement preserves other UI blur')
UIEffects.releaseBlur(other)
eq(#h.fades, 4, 'other UI is sole remaining lease after clear replacement')
eq(h.focused, true, 'other UI blur release leaves clear dialog focus intact')
h.exports.CloseDialog('clear-overlap')
eq(#h.fades, 4, 'clear close cannot release another lease again')

for _, ending in ipairs({ 'submit', 'cancel', 'close', 'idle', 'owner-stop', 'shutdown' }) do
    h = host(true)
    h.ready()
    local calls = 0
    UIEffects.acquireBlur = function() calls = calls + 1; error('opt-out acquired blur') end
    h.show('clear-lifecycle', { blur = false })
    if ending == 'submit' then h.nui('dialogSubmit', { id = 'clear-lifecycle', values = {} })
    elseif ending == 'cancel' then h.nui('dialogCancel', { id = 'clear-lifecycle' })
    elseif ending == 'close' then h.exports.CloseDialog('clear-lifecycle')
    elseif ending == 'idle' then h.timeout(300000)
    elseif ending == 'owner-stop' then h.emit('onResourceStop', 'consumer')
    else h.emit('onResourceStop', 'tLib') end
    h.ready()
    eq(calls, 0, ending .. ': opt-out lifecycle never acquires blur')
    eq(#h.fades, 0, ending .. ': opt-out lifecycle never fades')
    eq(h.focused, false, ending .. ': opt-out releases focus')
    eq(h.moveLocked, false, ending .. ': opt-out releases movement')
    eq(h.lookLocked, false, ending .. ': opt-out releases look')
    eq(DialogState.get('clear-lifecycle'), nil, ending .. ': opt-out removes state')
end

h = host(true)
h.show('pending-blur')
h.show('pending-clear', { blur = false })
h.ready()
eq(#h.fades, 0, 'pending blurred-to-clear replacement skips stale acquisition')
eq(h.focused, true, 'pending clear successor takes focus')
h.exports.CloseDialog('pending-clear')
h = host(true)
h.show('pending-clear', { blur = false })
h.show('pending-blur')
h.ready()
eq(#h.fades, 1, 'pending clear-to-blurred replacement acquires once')
h.exports.CloseDialog('pending-blur')
h = host(true)
h.show('closed-clear', { blur = false })
h.exports.CloseDialog('closed-clear')
h.ready()
eq(h.focused, false, 'closed pending opt-out cannot acquire late focus')
eq(#h.fades, 0, 'closed pending opt-out cannot acquire late blur')
-- Real Lua validation of the exact primitive types emitted by the browser form.
-- Number controls are text, sliders are numeric, and required booleans allow false.
h = host(true)
h.ready()
local wireChanges, wireSubmit = {}, nil
h.show('browser-wire', { blur = false, fields = {
    { id = 'name', type = 'text', required = true },
    { id = 'amount', type = 'number', min = 1, max = 10 },
    { id = 'enabled', type = 'checkbox', required = true },
    { id = 'choice', type = 'dropdown', options = { { value = 'a', label = 'Alpha' } } },
}, onChange = function(id, value) wireChanges[#wireChanges + 1] = { id, value } end,
    onSubmit = function(values) wireSubmit = values end })
local wireInstance = DialogState.get('browser-wire').instance
local function wireChange(value)
    h.nui('dialogChange', { id = 'browser-wire', instance = wireInstance, fieldId = 'amount', value = value })
end
wireChange(3)
wireChange('11')
wireChange('invalid')
eq(#wireChanges, 0, 'actual validator rejects numeric number-control payload and invalid strings')
wireChange('3')
wireChange('')
eq(#wireChanges, 2, 'actual validator accepts numeric text and optional empty text changes')
eq(wireChanges[1][2], '3', 'number-control change callback retains numeric text')
eq(wireChanges[2][2], '', 'number-control change callback retains empty text')
local browserValues = { name = 'Edited', amount = '', enabled = false, choice = 'a' }
h.nui('dialogSubmit', { id = 'browser-wire', instance = wireInstance - 1, values = browserValues })
eq(wireSubmit, nil, 'browser payload with stale instance cannot submit')
h.nui('dialogSubmit', { id = 'browser-wire', instance = wireInstance,
    values = { name = 'Edited', amount = 3, enabled = false, choice = 'a' } })
eq(wireSubmit, nil, 'numeric payload from old renderer is rejected on actual submit')
eq(DialogState.get('browser-wire') ~= nil, true, 'rejected number payload keeps dialog registered')
eq(h.focused, true, 'rejected number payload keeps owning dialog focused')
h.nui('dialogSubmit', { id = 'browser-wire', instance = wireInstance, values = browserValues })
eq(wireSubmit.name, 'Edited', 'browser fixture text reaches actual submit callback')
eq(wireSubmit.amount, '', 'browser fixture empty number remains empty through actual submit')
eq(wireSubmit.enabled, false, 'browser fixture required false boolean remains valid')
eq(wireSubmit.choice, 'a', 'browser fixture selection remains valid')
eq(DialogState.get('browser-wire'), nil, 'accepted browser payload closes actual Lua instance')
eq(h.focused, false, 'accepted browser payload releases actual adapter focus')
eq(#h.fades, 0, 'browser payload lifecycle preserves blur false')
wireSubmit = nil
h.show('required-number-wire', { blur = false, fields = {
    { id = 'amount', type = 'number', required = true, min = 1, max = 10 },
    { id = 'level', type = 'slider', min = 0, max = 10 },
}, onSubmit = function(values) wireSubmit = values end })
wireInstance = DialogState.get('required-number-wire').instance
h.nui('dialogSubmit', { id = 'required-number-wire', instance = wireInstance, values = { amount = '', level = 3 } })
eq(wireSubmit, nil, 'actual required-number validator rejects empty text')
h.nui('dialogSubmit', { id = 'required-number-wire', instance = wireInstance, values = { amount = '3', level = '3' } })
eq(wireSubmit, nil, 'actual slider validator rejects numeric text')
h.nui('dialogSubmit', { id = 'required-number-wire', instance = wireInstance, values = { amount = '3', level = 3 } })
eq(wireSubmit.amount, '3', 'actual accepted number submit remains text')
eq(wireSubmit.level, 3, 'actual accepted slider submit remains numeric')
eq(h.focused, false, 'mixed numeric form releases focus after accepted submit')
print(('dialog-blur: %d checks passed'):format(checks))
