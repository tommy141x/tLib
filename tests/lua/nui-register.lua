-- tlib.nui.register: every NUI callback is answered, whatever its handler does.
--
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/nui-register.lua
--
-- The failure this exists for is the one cfx's own RegisterNUICallback has: it
-- catches a throw and prints it but never calls `cb`, so the page's fetch hangs
-- to its 10 s deadline and F8 says `callback "X" did not answer within
-- 10000ms`. Every assertion here is about what the PAGE receives (the
-- resultCallback argument), not about which internals ran.

local report = print
local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

-- Host: a cooperative scheduler so a handler can Wait, and the cfx NUI natives.

local now = 0
local threads = {}
local handlers = {}
local declared = {}
local printed = {}

function GetCurrentResourceName() return 'consumer' end
function GetGameTimer() return now end
function RegisterNuiCallbackType(name) declared[name] = (declared[name] or 0) + 1 end
function AddEventHandler(event, fn) handlers[event] = handlers[event] or {}; table.insert(handlers[event], fn) end
function print(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    printed[#printed + 1] = table.concat(parts, ' ')
end
--- Run `fn` as a cfx thread: until its first Wait, then whenever time reaches it.
local function spawn(fn)
    local co = coroutine.create(fn)
    local entry = { co = co, wake = now }
    threads[#threads + 1] = entry
    local ok, err = coroutine.resume(co)
    if not ok then error(err, 0) end
    entry.wake = coroutine.status(co) == 'suspended' and now + (err or 0) or nil
    return entry
end

Citizen = {
    Wait = function(ms) coroutine.yield(ms) end,
    CreateThread = function(fn) return spawn(fn) end,
}
function Wait(ms) Citizen.Wait(ms) end

--- Advance the clock, resuming every sleeping thread whose time has come.
local function advance(ms)
    local target = now + ms
    while true do
        local nextWake
        for _, t in ipairs(threads) do
            if t.wake and (not nextWake or t.wake < nextWake) then nextWake = t.wake end
        end
        if not nextWake or nextWake > target then break end
        now = math.max(now, nextWake)
        for _, t in ipairs(threads) do
            if t.wake and t.wake <= now and coroutine.status(t.co) == 'suspended' then
                local ok, wait = coroutine.resume(t.co)
                if not ok then error(wait, 0) end
                t.wake = coroutine.status(t.co) == 'suspended' and now + (wait or 0) or nil
            end
        end
    end
    now = target
end

local function load()
    handlers, declared, printed, threads = {}, {}, {}, {}
    return assert(loadfile('shared/imports/nui/client.lua', 't', _G))()
end

--- Post to a registered callback the way the engine does, from its own thread
--- (so a handler may Wait). Returns a record of every answer the page got.
local function post(name, body)
    local record = { answers = {}, count = 0 }
    for _, fn in ipairs(handlers['__cfx_nui:' .. name] or {}) do
        spawn(function()
            fn(body, function(value)
                record.count = record.count + 1
                record.answers[record.count] = value
            end)
        end)
    end
    return record
end

local function printedContains(text)
    for _, line in ipairs(printed) do
        if line:find(text, 1, true) then return true end
    end
    return false
end

-- A handler that answers is passed through untouched

do
    local nui = load()
    nui.register('ping', function(data, reply) reply({ pong = data.n }) end)
    check(declared.ping == 1, 'the callback type is declared to the host')
    local r = post('ping', { n = 7 })
    check(r.count == 1 and r.answers[1].pong == 7, 'the handler\'s own reply reaches the page')
    check(#printed == 0, 'a clean call prints nothing')
end
report('PASS a handler\'s own reply is delivered')

-- Forgetting the cb is the bug class

do
    local nui = load()
    nui.register('forgot', function() end)
    local r = post('forgot', {})
    check(r.count == 1, 'a handler that never calls cb is still answered')
    check(r.answers[1].ok == true, 'the default answer is { ok = true }')
end
report('PASS a handler that returns without answering is answered')

do
    local nui = load()
    nui.register('returns', function() return { ok = true, via = 'return' } end)
    local r = post('returns', {})
    check(r.count == 1 and r.answers[1].via == 'return', 'a returned value is the answer')
end
report('PASS a returned value answers')

do
    local nui = load()
    nui.register('twice', function(_, reply) reply({ n = 1 }); reply({ n = 2 }) end)
    local r = post('twice', {})
    check(r.count == 1 and r.answers[1].n == 1, 'only the first reply reaches the page')
    local r2 = (function()
        nui.register('replied-and-returned', function(_, reply) reply({ n = 1 }); return { n = 9 } end)
        return post('replied-and-returned', {})
    end)()
    check(r2.count == 1 and r2.answers[1].n == 1, 'a return after a reply does not answer twice')
end
report('PASS a request is answered exactly once')

-- A throw is answered AND reported, once per distinct error

do
    local nui = load()
    nui.register('boom', function(data) return data.missing.field end)
    local first = post('boom', {})
    check(first.count == 1, 'a throwing handler is answered')
    check(first.answers[1].ok == false and first.answers[1].error == 'handler_error',
        'the answer is a structured error')
    check(type(first.answers[1].detail) == 'string' and first.answers[1].detail ~= '',
        'the error names what happened')
    check(#printed == 1 and printedContains('callback "boom" threw'), 'the first throw is printed')
    post('boom', {}); post('boom', {}); post('boom', {})
    check(#printed == 1, 'the same error is not printed again')
    local list = nui.failures()
    check(#list == 1 and list[1].kind == 'threw' and list[1].count == 4, 'every occurrence is counted')

    nui.register('boom2', function() error('different', 0) end)
    post('boom2', {})
    check(#printed == 2, 'a different error is printed')
end
report('PASS a throw is answered and logged once per distinct error')

do
    local nui = load()
    nui.register('varying', function(data) error('bad value ' .. data.n, 0) end)
    for n = 1, 200 do post('varying', { n = n }) end
    check(#printed <= 66, 'distinct failures are bounded; printed ' .. #printed)
    check(printedContains('further new ones are counted'), 'the suppression is announced once')
end
report('PASS the distinct-failure table is bounded')

-- A handler that blocks is bounded

do
    local nui = load()
    nui.register('slow', function(_, reply) Wait(20000); reply({ ok = true, late = true }) end)
    local r = post('slow', {})
    advance(7000)
    check(r.count == 0, 'nothing is answered before the bound')
    advance(1500)
    check(r.count == 1 and r.answers[1].ok == false and r.answers[1].error == 'timeout',
        'a blocked handler is answered with a timeout inside the NUI deadline')
    check(printedContains('callback "slow" did not answer within 8000ms'), 'the timeout is printed')
    advance(20000)
    check(r.count == 1, 'its late reply does not answer twice')
    check(printedContains('answered after its 8000ms bound'), 'the late reply is reported')
end
report('PASS a blocked handler is answered at the bound')

do
    local nui = load()
    nui.register('custom', function(_, reply) Wait(3000); reply({ ok = true }) end, { timeoutMs = 2000 })
    local r = post('custom', {})
    advance(2600)
    check(r.count == 1 and r.answers[1].error == 'timeout', 'timeoutMs overrides the default')

    local ok = pcall(nui.register, 'badtimeout', function() end, { timeoutMs = 0 })
    check(not ok, 'a non-positive timeoutMs is a programming error')
end
report('PASS timeoutMs is honoured')

do
    local nui = load()
    nui.register('waits', function(_, reply) Wait(1000); reply({ ok = true, waited = true }) end)
    local r = post('waits', {})
    check(r.count == 0, 'a handler that yields has not answered yet')
    advance(1500)
    check(r.count == 1 and r.answers[1].waited == true, 'a yielding handler\'s own reply wins when inside the bound')
    check(#printed == 0, 'and it is not reported')
end
report('PASS a handler that waits inside the bound is not interfered with')

-- A handler that answers later, on purpose

do
    local nui = load()
    local held
    nui.register('later', function(_, reply) held = reply end, { deferred = true })
    local r = post('later', {})
    check(r.count == 0, 'a deferred handler returning does not answer')
    advance(1000)
    held({ ok = true, later = true })
    check(r.count == 1 and r.answers[1].later == true, 'its reply is delivered')
end
report('PASS a deferred handler answers when it chooses')

do
    local nui = load()
    nui.register('never', function() end, { deferred = true })
    local r = post('never', {})
    advance(9000)
    check(r.count == 1 and r.answers[1].error == 'timeout', 'a deferred handler that forgets is still bounded')
end
report('PASS a deferred handler is still bounded')

do
    local nui = load()
    nui.register('deferred-throws', function() error('early', 0) end, { deferred = true })
    local r = post('deferred-throws', {})
    check(r.count == 1 and r.answers[1].error == 'handler_error', 'a deferred handler that throws is answered at once')
end
report('PASS a deferred handler that throws is answered')

-- The watchdog does not keep running for nothing

do
    local nui = load()
    nui.register('quick', function(_, reply) reply({ ok = true }) end)
    for _ = 1, 50 do post('quick', {}) end
    advance(1000)
    for _, t in ipairs(threads) do
        check(coroutine.status(t.co) == 'dead', 'the watchdog thread exits once nothing is pending')
    end
end
report('PASS the watchdog stops when nothing is pending')

-- Registering twice

do
    local nui = load()
    nui.register('dup', function(_, reply) reply({ v = 1 }) end)
    nui.register('dup', function(_, reply) reply({ v = 2 }) end)
    check(declared.dup == 1, 'the host sees one registration')
    check(#handlers['__cfx_nui:dup'] == 1, 'one host handler')
    local r = post('dup', {})
    check(r.count == 1 and r.answers[1].v == 2, 'the later handler replaces the earlier')
    check(printedContains('already registered'), 'the replacement is said once')
end
report('PASS a name registered twice is replaced, not doubled')

do
    local nui = load()
    check(not pcall(nui.register, '', function() end), 'an empty name is refused')
    check(not pcall(nui.register, 'x', nil), 'a missing handler is refused')
end
report('PASS bad arguments are a programming error')

report(('PASS nui-register (%d checks)'):format(checks))
