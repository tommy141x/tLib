-- Run from tLib root: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/dialog-lint.lua
--
-- Oracle for the dialog spec lint, which used to run in the PLAYER's NUI on every open of
-- every dialog: `console.warn` for `variant:"primary"` on several buttons and for buttons with
-- no description, both faults only the author of the spec can fix. tRadio and tLS tripped it
-- on every open. It now runs where the spec is in hand, in the Lua open path, at DEBUG, so
-- the author sees it with `Logger.setLevel(1)` and no player ever does.
--
-- Real dialog/state and dialog/exports, driven through the actual ShowDialog export.

local checks = 0
local function eq(actual, expected, message)
    checks = checks + 1
    assert(actual == expected,
        message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end

_TLIB_IS_FIVEM, _TLIB_SIDE = true, 'client'

-- The real Logger filters by level in one place; a stub that records everything with its level
-- lets this suite assert BOTH the text and that it is DEBUG, which is the whole change.
local logged = {}
Logger = { create = function(source)
    return function(...)
        local args = { ... }
        local level = type(args[#args]) == 'number' and table.remove(args) or 2
        logged[#logged + 1] = { source = source, level = level, text = table.concat(args, ' ') }
    end
end }

local h = { events = {}, exports = {}, messages = {}, owner = 'consumer' }
function AddEventHandler(name, fn)
    h.events[name] = h.events[name] or {}
    table.insert(h.events[name], fn)
end
function GetCurrentResourceName() return 'tLib' end
-- The adapter's registerNUICallback loads tlib.nui from the resource. string.dump rather than
-- io.open: the fengari runtime does not implement io.open (same approach as adapter-fivem.lua).
function LoadResourceFile(_, path) return string.dump(assert(loadfile(path))) end
-- The watchdog tlib.nui.register arms only matters to a callback that never answers; the
-- dialog `__tlib_nui_ready` handler answers at once, so a thread that never runs is enough.
function GetGameTimer() return 0 end
Citizen = { CreateThread = function() end, Wait = function() end }
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
for _, fn in ipairs(h.events['__cfx_nui:__tlib_nui_ready'] or {}) do fn({}, function() end) end

local function open(id, fields)
    logged = {}
    h.exports.ShowDialog(id, { title = id, fields = fields })
    local lines = {}
    for _, entry in ipairs(logged) do
        if entry.text:find('dialog "' .. id .. '"', 1, true) then lines[#lines + 1] = entry end
    end
    return lines
end

local function button(id, extra)
    local field = { id = id, type = 'button', label = id, description = 'what this does' }
    for k, v in pairs(extra or {}) do field[k] = v end
    return field
end

-- A clean spec is silent: the lint must not become the noise it replaced.
eq(#open('clean', { button('recalibrate'), button('reposition') }), 0, 'a clean spec logs nothing')
eq(#open('one-primary', { button('apply', { variant = 'primary' }), button('reset') }), 0,
    'one primary is allowed: the footer owns the other')

-- Several primaries compete with the footer's own and with each other.
local primaries = open('three-primaries', {
    button('a', { variant = 'primary' }), button('b', { variant = 'primary' }),
    button('c', { variant = 'primary' }), button('plain'),
})
eq(#primaries, 1, 'several primaries are one warning')
eq(primaries[1].level, 1, 'logged at DEBUG, which the default level filters out')
eq(primaries[1].source, 'tLib/dialog', 'under the dialog logger')
assert(primaries[1].text:find('3 fields declare variant "primary" (a, b, c)', 1, true), primaries[1].text)
assert(not primaries[1].text:find('plain', 1, true), 'a non-primary is not blamed')

-- A button that changes something with nothing saying what.
local undescribed = open('undescribed', {
    button('go', { description = false }), button('blank', { description = '' }), button('fine'),
})
eq(#undescribed, 1, 'undescribed buttons are one warning')
eq(undescribed[1].level, 1, 'at DEBUG as well')
assert(undescribed[1].text:find('button field(s) with no description: go, blank', 1, true), undescribed[1].text)

-- Both faults at once are two sentences, and only buttons are measured.
local both = open('both', {
    button('x', { variant = 'primary', description = false }),
    button('y', { variant = 'primary', description = false }),
    { id = 'volume', type = 'slider', label = 'Volume' },
    { id = 'name', type = 'text', label = 'Name' },
})
eq(#both, 2, 'a primary fault and a description fault are reported separately')

-- The point of moving it: nothing about it reaches the page. The dialog still opens, and the
-- NUI message carries no warning field for the renderer to log.
logged = {}
h.messages = {}
h.exports.ShowDialog('opens-anyway', { title = 't', fields = { button('a', { variant = 'primary', description = false }),
    button('b', { variant = 'primary', description = false }) } })
local shown
for _, message in ipairs(h.messages) do if message.name == 'showDialog' then shown = message.args[1] end end
eq(type(shown), 'table', 'a badly authored dialog still opens')
eq(shown.warnings, nil, 'no lint output is sent to the player\'s page')

print(('Passed %d dialog-lint checks'):format(checks))
