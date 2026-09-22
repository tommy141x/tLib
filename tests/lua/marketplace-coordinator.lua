-- Run: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/marketplace-coordinator.lua
local handlers, net, timers, dispatched, replies, hooks = {}, {}, {}, {}, {}, {}
local invoking, register, now, allowed, dispatchError = nil, nil, 0, true, false
Logger = { create = function() return function() end end }
Platform = { export = function(_, _, cb) register = cb end }
exports = { tLib = { mpRegisterType = function() return true end } }
function GetInvokingResource() return invoking end
function GetCurrentResourceName() return 'tLib' end
function GetGameTimer() return now end
function GetConvar(_, default) return default end
function IsPlayerAceAllowed() return allowed end
function RegisterNetEvent(event, cb) handlers[event] = cb; net[event] = true end
function AddEventHandler(event, cb) handlers[event] = cb end
function SetTimeout(ms, cb) timers[#timers + 1] = { due = now + ms, cb = cb } end
function TriggerClientEvent(event, target, payload)
    replies[#replies + 1] = { event = event, target = target, p = payload }
end
function TriggerEvent(event, payload, ...)
    if event:match('^tlib:marketplace:do') then
        if dispatchError then error('dispatch failure') end
        dispatched[#dispatched + 1] = { event = event, p = payload }
    else hooks[#hooks + 1] = { event = event, p = payload } end
end
dofile('server/sv_marketplace.lua')
local checks = 0
local function eq(a, b, why)
    checks = checks + 1
    assert(a == b, (why or 'equal') .. ': got ' .. tostring(a) .. ', expected ' .. tostring(b))
end
local function reg(resource, kind, opts)
    invoking = resource
    return register(kind or 'ui', opts or { installPath = 'layouts' })
end
local function req(action, resource, kind, slug, version, player)
    source = player or 1
    handlers['tlib:marketplace:' .. action](resource, kind, slug, version)
end
local function last() return dispatched[#dispatched].p end
local function result(token, resource, ok)
    invoking = resource
    handlers['tlib:marketplace:agentResult']({ token = token, ok = ok ~= false, slug = 'forged', resource = 'forged' })
end
local function advance(ms)
    now = now + ms
    local remaining = {}
    for _, t in ipairs(timers) do
        if t.due <= now then t.cb() else remaining[#remaining + 1] = t end
    end
    timers = remaining
end
local function rejected(action, resource, kind, slug, version)
    local d, r = #dispatched, #replies
    req(action, resource, kind, slug, version)
    eq(#dispatched, d, 'must not dispatch')
    eq(#replies, r + 1, 'failure reply')
    local p = replies[#replies].p
    eq(p.ok, false); eq(p.action, action); eq(type(p.token), 'string')
    eq(type(p.resource), 'string'); eq(type(p.type), 'string')
end

eq(net['tlib:marketplace:agentResult'], nil, 'results local only')
eq(reg(nil), false)
eq(reg('a', '../bad'), false)
eq(reg('a'), true); eq(reg('a', 'sound'), true); eq(reg('b'), true)
for _, action in ipairs({ 'install', 'uninstall' }) do
    rejected(action, nil, 'ui', 'item')
    rejected(action, {}, 'ui', 'item')
    rejected(action, 12, 'ui', 'item')
    rejected(action, 'a:bad', 'ui', 'item')
    rejected(action, string.rep('a', 129), 'ui', 'item')
    rejected(action, 'a', {}, 'item')
    rejected(action, 'a', string.rep('a', 65), 'item')
    rejected(action, 'a', 'ui', '../item')
    rejected(action, 'a', 'ui', string.rep('a', 129))
    rejected(action, 'a', 'ui', '')
    rejected(action, 'unknown', 'ui', 'item')
    rejected(action, 'a', 'unknown', 'item')
end
rejected('install', 'a', 'ui', 'item', {})
rejected('install', 'a', 'ui', 'item', false)
rejected('install', 'a', 'ui', 'item', '1&evil=1')
rejected('install', 'a', 'ui', 'item', string.rep('1', 65))
allowed = false; rejected('install', 'a', 'ui', 'item'); allowed = true
req('install', 'a', 'ui', 'item', '1.2-beta'); local a = last().token
eq(last().url:match('%?version=(.*)$'), '1.2-beta')
rejected('uninstall', 'a', 'ui', 'item')
rejected('install', 'a', 'ui', 'item')
req('install', 'b', 'ui', 'item'); local b = last().token
req('uninstall', 'a', 'sound', 'item'); local sound = last().token
eq(a ~= b and b ~= sound, true, 'isolated tuple locks')
local r = #replies
result(a, 'b'); eq(#replies, r, 'wrong producer ignored')
result(a, ''); eq(#replies, r, 'empty producer not nil')
invoking = 'a'; handlers['tlib:marketplace:agentResult']({ token = a, ok = 'yes' })
eq(#replies, r, 'malformed result ignored')
result(a, 'a'); eq(#replies, r + 1)
eq(replies[#replies].p.resource, 'a'); eq(replies[#replies].p.type, 'ui')
eq(replies[#replies].p.slug, 'item'); eq(replies[#replies].p.token, a)
result(a, 'a'); eq(#replies, r + 1, 'duplicate ignored')
result(b, nil); eq(#replies, r + 2, 'nil local bridge supported without invented identity')
result(sound, 'a')
req('uninstall', 'a', 'ui', 'item'); local timeout = last().token
rejected('install', 'a', 'ui', 'item')
advance(74999); eq(replies[#replies].p.token == timeout, false)
advance(1); eq(replies[#replies].p.token, timeout); eq(replies[#replies].p.ok, false)
r = #replies; result(timeout, 'a'); eq(#replies, r, 'late result ignored')
req('install', 'a', 'ui', 'item'); local retry = last().token
result(timeout, 'a'); rejected('uninstall', 'a', 'ui', 'item')
result(retry, 'a', false)

local calls = 0
local cb = setmetatable({}, { __call = function(_, slug, meta)
    calls = calls + 1; eq(slug, 'callback'); eq(meta.type, 'ui')
end })
eq(reg('a', 'ui', { installPath = 'layouts', onInstall = cb, onUninstall = cb }), true)
for _, action in ipairs({ 'install', 'uninstall' }) do
    req(action, 'a', 'ui', 'callback'); result(last().token, 'a')
end
eq(calls, 2, 'callable tables')
reg('a', 'ui', { installPath = 'layouts', onInstall = function() error('callback failed') end })
req('install', 'a', 'ui', 'throws'); result(last().token, 'a')
eq(replies[#replies].p.ok, true, 'callback failure does not lose reply')
req('uninstall', 'a', 'ui', 'throws'); result(last().token, 'a')

req('install', 'a', 'ui', 'stop'); local stopped = last().token
handlers.onResourceStop('a'); eq(replies[#replies].p.token, stopped)
eq(replies[#replies].p.ok, false)
r = #replies; result(stopped, 'a'); eq(#replies, r)
rejected('uninstall', 'a', 'ui', 'stop')
reg('a'); req('uninstall', 'a', 'ui', 'stop'); result(last().token, 'a')
req('install', 'a', 'ui', 'drop', nil, 42); local dropped = last().token
source = 42; handlers.playerDropped()
r = #replies; result(dropped, 'a'); eq(#replies, r, 'no reply to recycled player id')
req('install', 'a', 'ui', 'drop-timeout', nil, 42)
source = 42; handlers.playerDropped()
rejected('uninstall', 'a', 'ui', 'drop-timeout') -- disconnect cannot cancel disk I/O
r = #replies; advance(75000); eq(#replies, r, 'detached timeout silent')
req('uninstall', 'a', 'ui', 'drop-timeout'); result(last().token, 'a')
dispatchError = true
req('install', 'a', 'ui', 'dispatch'); eq(replies[#replies].p.ok, false)
dispatchError = false
req('install', 'a', 'ui', 'dispatch'); result(last().token, 'a')
req('install', 'a', 'ui', 'shutdown'); local shutdown = last().token
handlers.onResourceStop('tLib'); eq(replies[#replies].p.token, shutdown)
eq(replies[#replies].p.ok, false)
-- Inspection shares authority/lifecycle fencing but never emits mutation hooks.
reg('a', 'ui', { installPath = 'layouts', onInstall = cb, onUninstall = cb })
allowed = false; rejected('inspect', 'a', 'ui', 'item', 'view-1'); allowed = true
rejected('inspect', 'unknown', 'ui', 'item', 'view-1')
for _, id in ipairs({ '', '../bad', string.rep('a', 129) }) do
    rejected('inspect', 'a', 'ui', 'item', id)
end
req('inspect', 'a', 'ui', 'item', 'view-2'); local inspectionToken = last().token
eq(dispatched[#dispatched].event, 'tlib:marketplace:doInspect:a')
eq(last().url, nil, 'inspection cannot download a package')
local hookCount, callbackCount = #hooks, calls
r = #replies; result(inspectionToken, 'b'); eq(#replies, r, 'wrong inspection producer ignored')
result(inspectionToken, 'a', false)
eq(replies[#replies].p.requestId, 'view-2', 'caller identity bound by coordinator')
eq(#hooks, hookCount); eq(calls, callbackCount)
r = #replies; result(inspectionToken, 'a'); eq(#replies, r, 'duplicate inspection result ignored')
local function inspected(changes)
    local value = { token = last().token, ok = true, requestId = 'forged', installedAt = '/private/root',
        inspection = { resourceName = 'forged', type = 'forged', slug = 'forged',
            status = 'unverified', lock = 'absent', policyAvailable = false, path = '/private/root' } }
    for key, item in pairs(changes or {}) do value[key] = item end
    invoking = 'a'; handlers['tlib:marketplace:agentResult'](value)
end
req('inspect', 'a', 'ui', 'callback', 'view-success'); inspected()
local inspectedReply = replies[#replies].p
eq(inspectedReply.ok, true); eq(inspectedReply.requestId, 'view-success')
eq(inspectedReply.inspection.resourceName, 'a'); eq(inspectedReply.inspection.type, 'ui')
eq(inspectedReply.inspection.slug, 'callback'); eq(inspectedReply.inspection.status, 'unverified')
eq(inspectedReply.inspection.path, nil); eq(inspectedReply.installedAt, nil)
eq(#hooks, hookCount); eq(calls, callbackCount)
req('inspect', 'a', 'ui', 'item', 'view-malformed'); inspected({ inspection = { status = 'managed', lock = 'absent', policyAvailable = 'yes' } })
eq(replies[#replies].p.ok, false); eq(replies[#replies].p.inspection, nil)
for _, data in ipairs({
    { status = 'approved-for-delete', lock = 'absent', policyAvailable = true },
    { status = 'managed', lock = 'unlocked-by-age', policyAvailable = true },
    { status = {}, lock = 'absent', policyAvailable = false },
}) do
    req('inspect', 'a', 'ui', 'item', 'view-invalid-enum'); inspected({ inspection = data })
    eq(replies[#replies].p.ok, false); eq(replies[#replies].p.inspection, nil)
end
req('inspect', 'a', 'ui', 'item', 'view-revoked'); allowed = false; inspected(); allowed = true
eq(replies[#replies].p.ok, false); eq(replies[#replies].p.inspection, nil)
req('inspect', 'a', 'ui', 'timeout-inspect', 'view-3'); inspectionToken = last().token
r = #replies; advance(9999); eq(#replies, r, 'inspection remains pending before deadline')
advance(1); eq(replies[#replies].p.token, inspectionToken); eq(replies[#replies].p.ok, false)
eq(replies[#replies].p.error, 'management inspection unavailable; the consumer may need an update')
req('inspect', 'a', 'ui', 'drop-inspect', 'view-4', 42); inspectionToken = last().token
source = 42; handlers.playerDropped(); r = #replies
result(inspectionToken, 'a'); eq(#replies, r, 'inspection never replies to recycled player ID')
req('inspect', 'a', 'ui', 'stop-inspect', 'view-5'); inspectionToken = last().token
handlers.onResourceStop('a'); eq(replies[#replies].p.token, inspectionToken); eq(replies[#replies].p.ok, false)
print(('marketplace-coordinator: %d checks passed'):format(checks))
