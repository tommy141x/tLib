local events, nui, messages, installed = {}, {}, {}, {}
local state, calls = 'started', 0
GetResourceState = function() return state end
SendNUIMessage = function(data) messages[#messages + 1] = data end
AddEventHandler = function(name, fn) events[name] = fn end
RegisterNUICallback = function(name, fn) nui[name] = fn end
exports = { tLib = {
    RegisterHudComponent = function(_, id, definition, fn)
        calls = calls + 1; installed[id] = fn
        fn({ id = id, layout = definition.defaults, width = definition.width, height = definition.height,
            phase = 'restore', editing = false })
        return true
    end,
    UnregisterHudComponent = function(_, id) installed[id] = nil; return true end,
    OpenHudEditor = function() return true end,
} }
dofile('shared/imports/hud/client.lua')
local options = { width = 200, height = 100, defaults = { x = 0.1, y = 0.1, scale = 1, visible = true, anchor = 'top-left' } }
assert(tLibHud.register('status', options))
assert(#messages == 0, 'Own NUI readiness must gate delivery')
local answered
nui.__tlib_hud_ready({}, function(reply) answered = reply.ok end)
assert(answered and #messages == 1 and messages[1].tlibHud.phase == 'restore')
installed.status({ id = 'status', layout = { x = 0.5, y = 0.2, scale = 1, visible = true, anchor = 'top-left' },
    width = 200, height = 100, phase = 'preview', editing = true })
assert(messages[#messages].tlibHud.editing)
state = 'stopped'
events.onClientResourceStop('tLib')
assert(messages[#messages].tlibHud.layout.x == 0.1 and messages[#messages].tlibHud.editing == false,
    'Stopping tLib must restore committed geometry, not the latest preview')
assert(not tLibHud.edit())
state = 'started'
events.onClientResourceStart('tLib')
assert(calls == 2 and messages[#messages].tlibHud.phase == 'restore')
assert(tLibHud.edit())
assert(tLibHud.unregister('status'))
events.onClientResourceStart('tLib')
assert(calls == 2, 'Unregistered widgets must not return after restart')
print('PASS: consumer HUD readiness, restart registration and rollback transport')
