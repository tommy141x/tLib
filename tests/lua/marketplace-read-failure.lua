-- The panel's browse/preview/theme/like reads: what a failure carries to the NUI.
--
-- Run: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/marketplace-read-failure.lua
--
-- The Node bundle classifies a failed request and passes the kind as the fourth
-- callback argument; the panel chooses its wording from it. What is asserted is
-- that Lua forwards it untouched, adds its own kinds for the failures that never
-- reach the bundle, and says plainly when the bundle is not running at all.

local handlers, timers, replies, logs = {}, {}, {}, {}
local now, allowed = 0, true
local register
local bundle = { browse = nil, throw = nil }

-- FiveM provides `json`; only the two payloads this suite sends back are decodable.
local decodes = {
    ['{"items":"nope"}'] = { items = 'nope' },
    ['{"items":[],"total":0,"nextCursor":0,"hasMore":false}'] = { items = {}, total = 0, nextCursor = 0, hasMore = false },
}
json = {
    encode = function() return '{}' end,
    decode = function(text) return decodes[text] or error('not JSON') end,
}
Logger = { create = function() return function(message) logs[#logs + 1] = message end end }
Platform = {
    export = function(_, _, cb) register = cb end,
    AddNetEventHandler = function() end,
    TriggerClientEvent = function() end,
}
exports = setmetatable({}, { __index = function(_, name)
    if name ~= 'tLib' then return nil end
    return setmetatable({}, { __index = function(_, fn)
        return function(_, ...)
            if bundle.throw then error(bundle.throw) end
            if fn == 'mpRegisterType' then
                if bundle.registerThrows then error('No such export mpRegisterType in resource tLib') end
                return true
            end
            return bundle[fn](...)
        end
    end })
end })
function GetInvokingResource() return 'tDetector' end
function GetCurrentResourceName() return 'tLib' end
function GetGameTimer() return now end
function GetConvar(_, default) return default end
function GetPlayerIdentifierByType() return 'license:' .. ('a'):rep(40) end
function IsPlayerAceAllowed() return allowed end
function RegisterNetEvent(event, cb) handlers[event] = cb end
function AddEventHandler(event, cb) handlers[event] = cb end
function SetTimeout(ms, cb) timers[#timers + 1] = { due = now + ms, cb = cb } end
function TriggerClientEvent(event, target, payload)
    replies[#replies + 1] = { event = event, target = target, p = payload }
end
function TriggerEvent() end

_TLIB_IS_FIVEM = true
dofile('shared/sh_api.lua')
dofile('server/sv_permission.lua')
dofile('server/sv_marketplace.lua')

local checks = 0
local function eq(a, b, why)
    checks = checks + 1
    assert(a == b, (why or 'equal') .. ': got ' .. tostring(a) .. ', expected ' .. tostring(b))
end

local seq = 0
local function ask(event, opts)
    seq = seq + 1
    opts = opts or {}
    opts.requestId = opts.requestId or ('req-' .. seq)
    source = 7
    local before = #replies
    handlers['tlib:marketplace:' .. event](opts)
    source = nil
    return replies[before + 1] and replies[before + 1].p, opts.requestId
end

-- A failure the bundle classified keeps its kind and its technical line.
for _, case in ipairs({
    { event = 'browse', fn = 'mpBrowse', opts = { type = 'sound' } },
    { event = 'preview', fn = 'mpPreviewHtml', opts = { slug = 'midnight' } },
    { event = 'themeJson', fn = 'mpThemeJson', opts = { slug = 'midnight' } },
    { event = 'like', fn = 'mpLike', opts = { slug = 'midnight', next = true } },
}) do
    bundle[case.fn] = function(...)
        local args = { ... }
        args[#args](false, 'http_404 (HTTP 404)', nil, 'not_found')
    end
    local p = ask(case.event, case.opts)
    eq(p.ok, false, case.event .. ' fails')
    eq(p.kind, 'not_found', case.event .. ' forwards the bundle kind')
    eq(p.error, 'http_404 (HTTP 404)', case.event .. ' keeps the technical line')
end

-- A reply that claims success but is not the contract.
bundle.mpBrowse = function(_, cb) cb(true, nil, '{"items":"nope"}') end
eq(ask('browse', { type = 'ui' }).kind, 'bad_response', 'a malformed list is bad_response')
bundle.mpPreviewHtml = function(_, cb) cb(true, nil, nil) end
eq(ask('preview', { slug = 'midnight' }).kind, 'bad_response', 'a missing document is bad_response')

-- An empty catalogue is a success.
bundle.mpBrowse = function(_, cb) cb(true, nil, '{"items":[],"total":0,"nextCursor":0,"hasMore":false}') end
local empty = ask('browse', { type = 'sound' })
eq(empty.ok, true, 'an empty list is not a failure')
eq(#empty.items, 0, 'and carries no items')
eq(empty.kind, nil, 'and no kind')

-- Failures that never reach the bundle.
allowed = false
eq(ask('browse', { type = 'sound' }).kind, 'denied', 'a player without the ACE is denied')
allowed = true

bundle.mpBrowse = function() end
ask('browse'); ask('browse'); ask('browse')
local busy = ask('browse')
eq(busy.kind, 'busy', 'the fourth read in flight is busy')
now = now + 25000
local remaining = {}
for _, t in ipairs(timers) do
    if t.due <= now then t.cb() else remaining[#remaining + 1] = t end
end
timers = remaining
eq(replies[#replies].p.kind, 'timeout', 'a callback that never arrives ends as a timeout')

-- The bundle not running: the export does not exist.
bundle.throw = 'No such export mpBrowse in resource tLib'
local down = ask('browse', { type = 'sound' })
eq(down.kind, 'bridge', 'a missing export is a bridge failure')
checks = checks + 1
assert(down.error:find('server bundle is not running', 1, true), 'and says what to look at: ' .. down.error)
bundle.throw = 'something else'
eq(ask('browse', { type = 'sound' }).error, 'marketplace bridge unavailable', 'any other throw keeps the short line')
bundle.throw = nil

-- RegisterMarketplaceType names the cause when the bundle is missing.
logs = {}
bundle.registerThrows = true
eq(register('ui', { installPath = 'layouts' }), false, 'registration fails without the bundle')
checks = checks + 1
assert(logs[#logs]:find('No such export mpRegisterType', 1, true), 'the log keeps the real error: ' .. tostring(logs[#logs]))
assert(logs[#logs]:find('server bundle is not running', 1, true), 'and the hint: ' .. tostring(logs[#logs]))

print(('PASS marketplace-read-failure (%d checks)'):format(checks))
