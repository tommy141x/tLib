-- Run from tLib root with the existing scripts/run-lua-suite.lua Fengari runner.
-- Real dialog/state and dialog/exports, driven through the actual ShowDialog
-- export and read off the actual showDialog NUI message.
--
-- Why this suite exists: `serialiseDialog` copied five keys off each tab and
-- `view` was not one of them. Consumers had already shipped
-- `{ view = "marketplace" }` tabs and the page had already shipped the branch
-- that renders them, but the key never crossed the Lua/NUI boundary -- so the
-- tab appeared and its panel came up EMPTY. Nothing failed, nothing logged;
-- the only symptom was a blank tab, which reads as "the feature was never
-- integrated". That is exactly the class of bug a serialiser needs an oracle
-- for: every key a consumer is told to pass has to be asserted on the wire.
local checks = 0
local function eq(actual, expected, message)
    checks = checks + 1
    assert(actual == expected,
        message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end

_TLIB_IS_FIVEM, _TLIB_SIDE = true, 'client'
Logger = { create = function() return function() end end }

local h = { events = {}, exports = {}, messages = {}, owner = 'consumer' }
function AddEventHandler(name, fn)
    h.events[name] = h.events[name] or {}
    table.insert(h.events[name], fn)
end
function GetCurrentResourceName() return 'tLib' end
function GetInvokingResource() return h.owner end
function RegisterNuiCallbackType() end
function SendNUIMessage(message) h.messages[#h.messages + 1] = message end
function SetNuiFocus() end
function SetNuiFocusKeepInput() end
function TriggerScreenblurFadeIn() end
function TriggerScreenblurFadeOut() end
Platform = {
    _stub = function() return function() end end,
    setIgnoreMoveInput = function() end,
    setIgnoreLookInput = function() end,
    export = function(_, name, fn) h.exports[name] = fn end,
    TriggerEvent = function() end,
    setTimeout = function() return {} end,
    clearTimeout = function() end,
}
for _, path in ipairs({
    'shared/lib/adapter/shutdown.lua', 'shared/lib/adapter/lifecycle.lua',
    'shared/lib/adapter/ui.lua', 'client/cl_ui_effects.lua',
    'client/lib/dialog/state.lua', 'client/lib/dialog/exports.lua',
}) do
    assert(loadfile(path, 't', _G))()
end
DialogState.setUI({})
DialogExports.register()

-- The NUI is reported ready first: showDialog is buffered until it is, and a
-- suite that read h.messages before that would assert against an empty list and
-- pass vacuously.
for _, fn in ipairs(h.events['__cfx_nui:__tlib_nui_ready'] or {}) do fn({}, function() end) end

-- Platform.sendUIEvent wraps every payload as { name = evt, args = { data } }
-- because that is what client/web/src/lib/nui.ts destructures. Assert through
-- the same shape the page reads, not a convenient flattening of it.
local function payload(name)
    for index = #h.messages, 1, -1 do
        local message = h.messages[index]
        if message.name == name then return message.args[1] end
    end
    return nil
end

h.exports.ShowDialog('tabs', {
    title = 'Tabs',
    tabs = {
        { id = 'quick',    label = 'Quick' },
        { id = 'sounds',   label = 'Sounds' },
        { id = 'shop',     label = 'Marketplace', view = 'marketplace', separator = true },
        { id = 'editor',   label = 'Editor',      action = true },
        { id = 'bogus',    label = 'Bogus',       view = 'not-a-view' },
    },
    fields = {
        { id = 'volume', type = 'slider', min = 0, max = 10, tab = 'quick' },
        { id = 'sound:alert', type = 'dropdown', label = 'alert', tab = 'sounds',
          options = { { value = '', label = 'none' }, { value = 'a.wav', label = 'a.wav' } },
          defaultValue = 'a.wav' },
    },
})

local schema = payload('showDialog')
eq(type(schema), 'table', 'ShowDialog reaches the page')
eq(schema.id, 'tabs', 'the page is sent this dialog')
eq(#schema.tabs, 5, 'every declared tab is serialised')

-- THE regression. `view` is the whole contract for an embedded browser panel.
eq(schema.tabs[3].view, 'marketplace', 'a view tab carries its view to the page')
eq(schema.tabs[3].separator, true, 'a view tab keeps its separator')
eq(schema.tabs[3].action, nil, 'a view tab is not an action tab')

eq(schema.tabs[1].view, nil, 'a plain content tab declares no view')
eq(schema.tabs[4].action, true, 'an action tab still serialises as one')
-- An unknown view must not reach the page: the renderer has no branch for it and
-- would fall through to the same silent blank panel this suite exists to catch.
eq(schema.tabs[5].view, nil, 'an unrecognised view is dropped rather than forwarded')
eq(schema.tabs[5].id, 'bogus', 'dropping an unknown view keeps the tab itself')

-- The Sounds tab is ordinary fields, which is the whole reason it needs no view.
local sounds
for _, field in ipairs(schema.fields) do
    if field.id == 'sound:alert' then sounds = field end
end
eq(type(sounds), 'table', 'a dropdown field id containing a colon survives serialisation')
eq(sounds.tab, 'sounds', 'a sound field is bound to the sounds tab')
eq(sounds.defaultValue, 'a.wav', 'a sound field carries its current mapping')
eq(#sounds.options, 2, 'a sound field carries its options, including the empty one')
eq(sounds.options[1].value, '', 'the empty option is preserved as the clear affordance')

-- UpdateDialogField is how the open tab is refreshed when the server pushes a new
-- map. Options and value must be accepted in ONE patch: the value is validated
-- against the options in the same call, so a newly installed file would be
-- rejected if they were sent separately.
h.exports.UpdateDialogField('tabs', 'sound:alert', {
    options = { { value = '', label = 'none' }, { value = 'b.wav', label = 'b.wav' } },
    defaultValue = 'b.wav',
})
local patch = payload('updateDialogField')
eq(type(patch), 'table', 'a field patch reaches the page')
eq(patch.defaultValue, 'b.wav', 'a value new to this patch is accepted alongside its options')
eq(patch.options[2].value, 'b.wav', 'the patch carries the replacement options')

local before = #h.messages
h.exports.UpdateDialogField('tabs', 'sound:alert', { defaultValue = 'gone.wav' })
eq(#h.messages, before, 'a value absent from the options is refused, not sent')

h.exports.UpdateDialogField('tabs', 'sound:alert', { defaultValue = '' })
eq(payload('updateDialogField').defaultValue, '', 'clearing an optional mapping is accepted')

-- `resetState` is the opt-out from "reopen where you left it". It is the same
-- class of key as `view` above: the page is the only thing that can act on it,
-- so a serialiser that quietly dropped it would leave every caller that asked
-- for a fresh dialog silently getting the restored one instead. The DEFAULT is
-- the load-bearing half -- an ordinary ShowDialog must not send it, because
-- sending it would reset every dialog in the server.
eq(schema.resetState, nil, 'an ordinary dialog does not ask the page to reset its view')

h.exports.ShowDialog('reset', { title = 'Reset', resetState = true, fields = {} })
eq(payload('showDialog').resetState, true, 'resetState reaches the page when asked for')

h.exports.ShowDialog('reset', { title = 'Reset', resetState = false, fields = {} })
eq(payload('showDialog').resetState, nil, 'resetState = false is the default, not a reset')

local _, resetErr = h.exports.ShowDialog('reset', { title = 'Reset', resetState = 'yes', fields = {} })
eq(resetErr, 'Dialog resetState must be a boolean', 'a non-boolean resetState is refused')

print(('dialog-tabs: %d checks passed'):format(checks))
