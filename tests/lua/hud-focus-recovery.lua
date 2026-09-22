-- Real HUD, dialog and native-menu backend modules against mocked FiveM natives.
local checks = 0
local function check(value, message) checks = checks + 1; assert(value, message) end
_TLIB_IS_FIVEM, _TLIB_SIDE = true, 'client'
Logger = { create = function() return function() end end }
local events, exports, commands, threads, timers = {}, {}, {}, {}, {}
local clock, ownFocus, externalFocus, acquisitions = 0, false, false, 0
local move, look = false, false
function AddEventHandler(name, fn)
    events[name] = events[name] or {}; table.insert(events[name], fn)
end
local function emit(name, ...)
    for _, fn in ipairs(events[name] or {}) do fn(...) end
end
local function nui(name, data)
    local reply
    emit('__cfx_nui:' .. name, data or {}, function(value) reply = value end)
    return reply
end
function RegisterNuiCallbackType() end
function RegisterCommand(name, fn) commands[name] = fn end
function GetCurrentResourceName() return 'tLib' end
function GetInvokingResource() return 'consumer' end
function SetNuiFocus(state) ownFocus = state; if state then acquisitions = acquisitions + 1 end end
function SetNuiFocusKeepInput() end
function IsNuiFocused() return ownFocus or externalFocus end
function GetGameTimer() return clock end
function GetConvar() return '' end
function GetSafeZoneSize() return 1 end
local latest
function SendNUIMessage(message)
    if message.name == 'layoutOpen' then latest = message.args[1].session end
end
Platform = {
    _stub = function() return function() end end,
    export = function(_, name, fn) exports[name] = fn end,
    getInvokingResource = GetInvokingResource,
    setIgnoreMoveInput = function(state) move = state end,
    setIgnoreLookInput = function(state) look = state end,
    now = function() return clock end,
    createThread = function(fn) threads[#threads + 1] = coroutine.create(fn) end,
    wait = function() coroutine.yield() end,
    setTimeout = function(fn, ms) local token = {}; timers[token] = { fn = fn, ms = ms }; return token end,
    clearTimeout = function(token) timers[token] = nil end,
    TriggerEvent = function() end,
}
UIEffects = { acquireBlur = function() return {} end, releaseBlur = function() end }
-- Full paths, not a shared prefix plus a suffix: these files no longer sit under
-- one root. The tree a file lives in is now the VM it loads into.
for _, path in ipairs({
    'shared/lib/adapter/shutdown.lua', 'shared/lib/adapter/lifecycle.lua',
    'shared/lib/adapter/ui.lua', 'client/lib/dialog/state.lua',
    'client/lib/dialog/exports.lua', 'client/lib/menu/input.lua',
    'client/lib/layout/schema.lua', 'client/cl_layout.lua',
}) do
    dofile(path)
end
DialogState.setUI({})
DialogExports.register()
HudLayout.init({})
local watchdog = threads[1]
local function tick(ms)
    clock = clock + ms
    local ok, err = coroutine.resume(watchdog); check(ok, err)
end
local function command(action) commands.tlibhud(0, action and { action } or {}) end
-- Queue a HUD-open callback ahead of the dialog's ready callback. At that exact
-- transition readiness is true but native focus is still false.
local transitionOpened
Platform.onNUIReady(function() transitionOpened = exports.OpenHudEditor() end)
exports.ShowDialog('pending', { title = 'Pending' })
check(not ownFocus, 'pending dialog does not focus a cold renderer')
nui('__tlib_nui_ready')
check(transitionOpened == false, 'HUD must reject a pending dialog during the ready callback flush')
check(ownFocus and not HudLayout.isEditing(), 'dialog alone owns the ready transition')
exports.CloseDialog('pending')
check(not ownFocus and not move and not look, 'dialog releases focus and input locks')
check(exports.OpenHudEditor(), 'HUD opens after dialog close')
local first, takes = latest, acquisitions
-- An idle native menu closing must NOT release the HUD editor's focus.
MenuInput.setVisible(false)
check(ownFocus and HudLayout.isEditing(), 'non-typing native menu cleanup preserves HUD focus')
-- Simulate a stale/native resource release while editor heartbeats continue.
SetNuiFocus(false, false)
tick(0)
nui('layoutHeartbeat', { session = first })
tick(1500)
check(not HudLayout.isEditing() and not ownFocus and not move and not look, 'focus loss rolls back and unblocks game controls')
check(acquisitions == takes, 'watchdog never automatically takes NUI focus')
command()
check(HudLayout.isEditing() and latest > first, 'player can reopen with a new generation')
check(nui('layoutFinish', { session = first, save = true }).ok == false, 'late browser completion cannot affect reopened session')
command('cancel')
check(not HudLayout.isEditing(), 'emergency command closes even without browser completion')
-- Typing menu exit remains legitimate and cannot overlap an editor open.
MenuInput.setVisible(true, function() end)
check(MenuInput.text(true), 'native menu can enter text focus')
check(not exports.OpenHudEditor(), 'HUD rejects native menu typing')
MenuInput.setVisible(false)
check(exports.OpenHudEditor(), 'HUD can open after menu typing teardown')
externalFocus = true
SetNuiFocus(false, false)
takes = acquisitions
command('cancel')
check(externalFocus and not ownFocus and acquisitions == takes, 'discard never steals external-resource NUI focus')
check(not exports.OpenHudEditor(), 'external focus prevents reopen')
externalFocus = false
check(exports.OpenHudEditor(), 'editor opens when external owner releases')
emit('onClientResourceStop', 'consumer')
check(not HudLayout.isEditing() and not ownFocus and not move and not look, 'opener stop discards and unlocks')
command('open')
check(HudLayout.isEditing(), 'command-owned editor can open after consumer stop')
emit('onClientResourceStop', 'tLib')
check(not HudLayout.isEditing() and not ownFocus and not move and not look, 'tLib stop tears down editor and locks')
check(not exports.OpenHudEditor(), 'stopped service cannot be reopened by retained exports')
command()
check(not HudLayout.isEditing(), 'stopped service cannot be reopened by retained command')
tick(0)
check(coroutine.status(watchdog) == 'dead', 'resource stop terminates watchdog')
print(('PASS: %d HUD focus recovery checks with actual dialog, menu and NUI/lifecycle adapters'):format(checks))
