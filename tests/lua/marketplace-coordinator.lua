-- Run: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/marketplace-coordinator.lua
local handlers, net, timers, dispatched, replies, hooks = {}, {}, {}, {}, {}, {}
local invoking, register, now, allowed, dispatchError = nil, nil, 0, true, false
-- Per-ACE grants. `allowed` stays the blanket switch every existing case uses;
-- `aces` overrides it for the cases that care WHICH permission is held, which
-- is the whole point of the marketplace no longer inlining `tlib.admin`.
local aces = nil
Logger = { create = function() return function() end end }
Platform = {
    export = function(_, _, cb) register = cb end,
    AddNetEventHandler = function() end,
    TriggerClientEvent = function() end,
}
-- Install now asks the Node bridge whether the ITEM's own `resource` matches
-- the product it is being installed into — the one thing the registry key
-- `resource:type` never proved. The default mode answers `ok` SYNCHRONOUSLY so
-- every case written before this check existed still reads as a straight-line
-- dispatch; the other modes drive the new cases at the bottom of this file.
local ownership = { mode = 'ok', pending = nil, calls = 0, last = nil }
exports = { tLib = {
    mpRegisterType = function() return true end,
    mpAssertItemResource = function(_, resource, slug, cb)
        ownership.calls = ownership.calls + 1
        ownership.last = { resource = resource, slug = slug }
        if ownership.mode == 'throw' then error('ownership bridge unavailable') end
        if ownership.mode == 'defer' then ownership.pending = cb return end
        if ownership.mode == 'deny' then cb(false, 'item_resource_mismatch') return end
        if ownership.mode == 'unreachable' then cb(false, 'request_timed_out') return end
        cb(true, nil)
    end,
} }
function GetInvokingResource() return invoking end
function GetCurrentResourceName() return 'tLib' end
function GetGameTimer() return now end
function GetConvar(_, default) return default end
function IsPlayerAceAllowed(_, key)
    if aces then return aces[key] == true end
    return allowed
end
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
-- Loaded FIRST, exactly as fxmanifest's server_scripts orders them. The
-- marketplace's admin gate is `Permission.isPlayerAdmin` now, so stubbing the
-- gate here instead would test the stub; this loads the real rule.
_TLIB_IS_FIVEM = true
-- shared_scripts run before server_scripts. The real StudioApi, not a stub: it
-- is the one definition of the download host and of how tmarketplace_base_url is
-- normalised, and stubbing it here would let the two drift apart unseen.
dofile('shared/sh_api.lua')
dofile('server/sv_permission.lua')
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
-- ── The admin gate is tLib's rule, not a bare `tlib.admin` ACE ──────────────
-- The gate used to inline `IsPlayerAceAllowed(src, 'tlib.admin')`, which denies
-- a player holding only `tlib.superadmin` — while sv_permission.lua, and so
-- exports.tLib:IsPlayerAdmin and every other admin surface in tLib, grants one.
-- These pin all three gates onto the shared rule. `aces` grants exactly one
-- permission at a time, so a gate that still spelled the ACE inline fails the
-- superadmin cases and only those.
eq(reg('a'), true) -- the inspect cases above stopped resource 'a'
local d = #dispatched
aces = { ['tlib.superadmin'] = true }
req('install', 'a', 'ui', 'perm-super')
eq(#dispatched, d + 1, 'superadmin may install')
result(last().token, 'a')

aces = { ['tlib.admin'] = true }
d = #dispatched
req('install', 'a', 'ui', 'perm-admin')
eq(#dispatched, d + 1, 'admin may still install')
result(last().token, 'a')

-- The inspection re-check on the way back out takes the same rule.
aces = { ['tlib.superadmin'] = true }
d = #dispatched
req('inspect', 'a', 'ui', 'perm-inspect', 'view-super')
eq(#dispatched, d + 1, 'superadmin may inspect')
local superToken = last().token
inspected()
eq(replies[#replies].p.ok, true, 'inspection survives the superadmin re-check')
eq(replies[#replies].p.token, superToken)

-- Holding neither is still a denial: this is a widened rule, not an open door.
aces = { ['some.other.ace'] = true }
rejected('install', 'a', 'ui', 'perm-none')
aces = nil

-- ── Cross-product install enforcement ──────────────────────────────────────
--
-- The gap these pin: the coordinator keys registrations `resource:type` and
-- writes into that resource's own registered installPath, so a tELS item could
-- never land in tRadar's DIRECTORY. The item's own `resource` field was the
-- unenforced half — `tlib:marketplace:install('tRadar','ui','<a-tELS-slug>')`
-- passed every check above and tLib fetched and installed it.
eq(reg('a'), true)

-- The check is asked at all, and asked about the right tuple.
local before = ownership.calls
req('install', 'a', 'ui', 'owned'); result(last().token, 'a')
eq(ownership.calls, before + 1, 'install asks who owns the slug')
eq(ownership.last.resource, 'a'); eq(ownership.last.slug, 'owned')

-- A mismatch refuses, names the refusal, and never reaches the agent.
ownership.mode = 'deny'
d = #dispatched; r = #replies
req('install', 'a', 'ui', 'foreign')
eq(#dispatched, d, 'cross-product item is never dispatched')
eq(#replies, r + 1); eq(replies[#replies].p.ok, false)
eq(replies[#replies].p.error,
    'marketplace item belongs to another resource; refusing to install it into a')

-- The lock is released by the refusal, so an admin can retry rather than being
-- told an operation is already in progress forever.
ownership.mode = 'ok'
req('install', 'a', 'ui', 'foreign'); eq(#dispatched, d + 1, 'refusal released the lock')
result(last().token, 'a')

-- FAILS CLOSED, and distinguishably: an unreachable marketplace is not a
-- mismatch and must not read as one.
ownership.mode = 'unreachable'
d = #dispatched
req('install', 'a', 'ui', 'unreachable')
eq(#dispatched, d, 'unverifiable item is never dispatched')
eq(replies[#replies].p.ok, false)
eq(replies[#replies].p.error,
    'could not confirm the marketplace item belongs to a (request_timed_out)')

-- A bridge that is missing or throws is the same refusal, not an escape hatch.
ownership.mode = 'throw'
d = #dispatched
req('install', 'a', 'ui', 'nobridge')
eq(#dispatched, d, 'broken ownership bridge does not fall through to install')
eq(replies[#replies].p.ok, false)
eq(replies[#replies].p.error, 'marketplace ownership check unavailable')

-- The answer really is asynchronous: nothing is dispatched until it arrives.
ownership.mode = 'defer'
d = #dispatched
req('install', 'a', 'ui', 'async')
eq(#dispatched, d, 'no dispatch before the ownership answer')
ownership.pending(true, nil)
eq(#dispatched, d + 1, 'dispatch resumes on the ownership answer')
result(last().token, 'a')

-- An answer that arrives after the pending deadline must not start an install
-- nobody is waiting for — its reply was already sent and would be dropped.
d = #dispatched
req('install', 'a', 'ui', 'async-late')
advance(75000)
eq(replies[#replies].p.ok, false, 'deadline fired while awaiting ownership')
r = #replies
ownership.pending(true, nil)
eq(#dispatched, d, 'late ownership answer does not dispatch')
eq(#replies, r, 'late ownership answer is silent')

-- UNINSTALL AND INSPECT ARE DELIBERATELY NOT GATED. They act on files already
-- on this server's disk, addressed by the same tuple that put them there.
-- Gating them would make a cross-product item installed before this check
-- existed impossible to remove, and would put an outbound HTTP call in the way
-- of a local delete that must keep working when the marketplace is down.
ownership.mode = 'deny'
before = ownership.calls
d = #dispatched
req('uninstall', 'a', 'ui', 'legacy-foreign')
eq(#dispatched, d + 1, 'uninstall is not gated on ownership')
result(last().token, 'a')
req('inspect', 'a', 'ui', 'legacy-foreign', 'view-own')
eq(#dispatched, d + 2, 'inspect is not gated on ownership')
result(last().token, 'a', false)
eq(ownership.calls, before, 'ownership is never asked for a local-only action')
ownership.mode = 'ok'

print(('marketplace-coordinator: %d checks passed'):format(checks))
