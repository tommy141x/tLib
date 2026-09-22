local callbacks, events, sent, messages = {}, {}, {}, {}
Logger = { create = function() return function() end end }
Platform = { export = function() end }
function RegisterNUICallback(event, cb) callbacks[event] = cb end
function RegisterNetEvent(event, cb) events[event] = cb end
function TriggerServerEvent(...) sent[#sent + 1] = { ... } end
function SendNUIMessage(message) messages[#messages + 1] = message end
function SetNuiFocus() error('inspection must not change NUI focus') end
dofile('client/cl_marketplace.lua')
local checks = 0
local function eq(actual, expected)
    checks = checks + 1
    assert(actual == expected, tostring(actual) .. ' ~= ' .. tostring(expected))
end
local replies = 0
local function invoke(data)
    callbacks.marketplaceInspect(data, function(value) replies = replies + 1; eq(value, 1) end)
end
invoke({ resource = 'tELS', type = 'ui', slug = 'item', requestId = 'view-1' })
eq(#sent, 1)
eq(sent[1][1], 'tlib:marketplace:inspect')
eq(sent[1][2], 'tELS'); eq(sent[1][3], 'ui'); eq(sent[1][4], 'item'); eq(sent[1][5], 'view-1')
invoke(nil); invoke(false); invoke({}); invoke({ resource = 'a', type = 'ui', slug = 'item' })
eq(#sent, 1); eq(replies, 5)
local result = { ok = false, resource = 'tELS', type = 'ui', slug = 'item', requestId = 'view-1', error = 'not authorized' }
events['tlib:marketplace:inspectResult'](result)
eq(#messages, 1); eq(messages[1].action, 'marketplaceInspectResult'); eq(messages[1].data, result)
print(('marketplace-inspection-client: %d checks passed'):format(checks))
