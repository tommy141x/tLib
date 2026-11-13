-- tlib.ratelimit.tokens: the burst-tolerant gate, and its log-once-per-window report.
--
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/ratelimit-tokens.lua
--
-- Three hand-rolled copies of this lived in tRadio. What they got right is what
-- is asserted: a join burst passes, a flood is bounded by the refill rate, a
-- refusal costs one console line per window rather than one per call, and a
-- disconnect frees the player's state. What they had no way to say is asserted
-- too: a server-side emit is never limited.

local report = print
local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

local now = 0
function GetGameTimer() return now end
function GetCurrentResourceName() return 'consumer' end

local dropHandlers = {}
function AddEventHandler(name, fn)
    dropHandlers[name] = dropHandlers[name] or {}
    table.insert(dropHandlers[name], fn)
end
local function drop(src)
    source = src
    for _, fn in ipairs(dropHandlers.playerDropped or {}) do fn() end
    source = nil
end

local printed = {}
function print(...)
    local parts = {}
    for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
    printed[#printed + 1] = table.concat(parts, ' ')
end

local function fresh()
    now, printed, dropHandlers = 0, {}, {}
    return assert(loadfile('shared/imports/ratelimit/server.lua', 't', _G))()
end

-- The shape of the access/NAC gate this replaces: burst 15, 2 a second

do
    local RateLimit = fresh()
    local gate = RateLimit.tokens('requestAccess', { burst = 15, refillPerSecond = 2 })

    now = 1000
    local refused = 0
    for _ = 1, 15 do if gate(6) then refused = refused + 1 end end
    check(refused == 0, 'a 15-call join burst in one instant passes')
    local blocked, retryAfter = gate(6)
    check(blocked == true, 'the 16th call in the same instant is refused')
    check(retryAfter == 500, 'it says when one token is back: ' .. tostring(retryAfter))

    now = 1500
    check(gate(6) == false, 'half a second later one token has come back')
    check(gate(6) == true, 'and only one')

    now = 1500 + 7500
    local passed = 0
    for _ = 1, 20 do if not gate(6) then passed = passed + 1 end end
    check(passed == 15, 'tokens refill up to the burst and no further: ' .. passed)
end
report('PASS a join burst passes and the refill rate bounds a flood')

do
    local RateLimit = fresh()
    local gate = RateLimit.tokens('sustained', { burst = 15, refillPerSecond = 2 })
    local passed = 0
    for second = 0, 59 do
        now = second * 1000
        for _ = 1, 10 do if not gate(3) then passed = passed + 1 end end
    end
    check(passed >= 15 + 2 * 59 - 1 and passed <= 15 + 2 * 59 + 1,
        'ten calls a second for a minute admits about burst + refill * 59, got ' .. passed)
end
report('PASS a sustained flood is held to the refill rate')

-- A call can cost more than one token

do
    local RateLimit = fresh()
    local gate = RateLimit.tokens('scan', { burst = 40, refillPerSecond = 10 })
    now = 0
    check(gate(5, 30) == false, 'a 30-token request passes from a full bucket')
    local blocked, retryAfter = gate(5, 30)
    check(blocked == true and retryAfter == 2000, 'the next is refused until 20 tokens are back: ' .. tostring(retryAfter))
    check(gate(5, 5) == false, 'a cheaper call still fits in the 10 left')
    check(not pcall(gate, 5, 41), 'a cost above the burst can never pass and is a programming error')
    check(not pcall(gate, 5, 0), 'a free call is a programming error')
end
report('PASS a call may cost several tokens')

-- Who is limited

do
    local RateLimit = fresh()
    local gate = RateLimit.tokens('who', { burst = 1, refillPerSecond = 1 })
    now = 0
    check(gate(1) == false and gate(1) == true, 'a real player is limited')
    check(gate(2) == false, 'per player: one client flooding does not refuse another')
    for _, trusted in ipairs({ 0, -1, '', 'net:1234', {} }) do
        check(gate(trusted) == false and gate(trusted) == false, 'a non-player source is never limited: ' .. tostring(trusted))
    end
    check(gate(nil) == false, 'nil is never limited')
    check(gate('1') == true, 'a numeric string is the same player as the number')
end
report('PASS only real players are limited, and by numeric id')

-- The report

do
    local RateLimit = fresh()
    local gate = RateLimit.tokens('requestAccess', { burst = 1, refillPerSecond = 0.001, logWindowMs = 30000 })
    now = 0
    gate(9)
    for _ = 1, 50 do gate(9) end
    check(#printed == 1, 'fifty refusals inside one window print one line, got ' .. #printed)
    check(printed[1]:find('requestAccess', 1, true) and printed[1]:find('player 9', 1, true),
        'the line names the gate and the player: ' .. printed[1])

    now = 29999
    gate(9)
    check(#printed == 1, 'still inside the window')
    now = 30000
    gate(9)
    check(#printed == 2, 'the next window reports again')
    check(printed[2]:find('(51 refused', 1, true), 'and says how many were refused since: ' .. printed[2])

    gate(10)
    gate(10)
    check(#printed == 3 and printed[3]:find('player 10', 1, true), 'each player has their own window')
end
report('PASS a refusal is reported once per window per player, with the count')

do
    local RateLimit = fresh()
    local seen = {}
    local gate = RateLimit.tokens('hook', {
        burst = 1, refillPerSecond = 1, logWindowMs = 0,
        onRefuse = function(src, info) seen[#seen + 1] = { src = src, info = info } end,
    })
    now = 0
    gate(4); gate(4); gate(4)
    check(#seen == 2, 'logWindowMs = 0 reports every refusal')
    check(seen[1].src == 4 and seen[1].info.name == 'hook' and seen[1].info.refused == 1, 'onRefuse gets the player and the info')
    check(seen[1].info.retryAfterMs == 1000, 'including when to retry')
    check(#printed == 0, 'onRefuse replaces the printed line')

    local boom = RateLimit.tokens('boom', {
        burst = 1, refillPerSecond = 1, onRefuse = function() error('hook broke', 0) end,
    })
    boom(5)
    check(boom(5) == true, 'a throwing onRefuse still refuses')
    check(#printed == 1 and printed[1]:find('hook broke', 1, true), 'and is reported')
end
report('PASS onRefuse replaces the line and cannot break the gate')

-- Disconnect

do
    local RateLimit = fresh()
    local a = RateLimit.tokens('a', { burst = 1, refillPerSecond = 0.001 })
    local b = RateLimit.tokens('b', { burst = 1, refillPerSecond = 0.001 })
    now = 0
    a(7); b(7)
    check(a(7) == true and b(7) == true, 'precondition: player 7 is empty in both')
    drop(7)
    check(a(7) == false and b(7) == false, 'one disconnect gives back a full bucket in every gate')
    check(#(dropHandlers.playerDropped or {}) == 1, 'one sweep handler for every gate, bucket and tokens alike')

    RateLimit.bucket('floor', 1000)
    check(#dropHandlers.playerDropped == 1, 'mixing the two kinds still installs it once')

    a(8)
    RateLimit.forget(nil)
    check(a(8) == false, 'forget(nil) clears token state too')
    RateLimit.reset()
end
report('PASS a disconnect frees token state in every gate')

-- Same name

do
    local RateLimit = fresh()
    local one = RateLimit.tokens('shared', { burst = 2, refillPerSecond = 0.001 })
    local two = RateLimit.tokens('shared', { burst = 2, refillPerSecond = 0.001 })
    now = 0
    one(1); two(1)
    check(one(1) == true and two(1) == true, 'two closures over one name share one budget')
end
report('PASS the same name is one budget')

-- Arguments

do
    local RateLimit = fresh()
    local function bad(name, opts) return not pcall(RateLimit.tokens, name, opts) end
    check(bad('', { burst = 1, refillPerSecond = 1 }), 'an empty name')
    check(bad('x', nil), 'no options')
    check(bad('x', { refillPerSecond = 1 }), 'no burst')
    check(bad('x', { burst = 0, refillPerSecond = 1 }), 'a burst below 1')
    check(bad('x', { burst = 1 }), 'no refill rate')
    check(bad('x', { burst = 1, refillPerSecond = 0 }), 'a refill rate of zero would never recover')
    check(bad('x', { burst = 1, refillPerSecond = 1, logWindowMs = -1 }), 'a negative window')
    check(bad('x', { burst = 1, refillPerSecond = 1, onRefuse = 'nope' }), 'a non-function onRefuse')
end
report('PASS bad arguments are a programming error')

-- tLib's own VM reaches the module through Platform.rateLimit

do
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env._TLIB_IS_FIVEM, env._TLIB_SIDE = true, 'server'
    env.Logger = { create = function() return function() end end }
    env.Platform = { _stub = function() return function() end end }
    env.GetCurrentResourceName = function() return 'tLib' end
    dofile('tests/fixtures/real-module.lua')(env, 'shared/imports/ratelimit/server.lua')
    assert(loadfile('shared/lib/adapter/lifecycle.lua', 't', env))()

    now, printed, dropHandlers = 0, {}, {}
    local gate = env.Platform.rateLimit('demo:config_request', 1000)
    check(gate(1) == false and gate(1) == true, 'Platform.rateLimit is a minimum-interval gate')
    now = 1000
    check(gate(1) == false, 'and lets the next call through at the interval')
    check(env.Platform.rateLimit('demo:config_request', 1000)(1) == true, 'the same name is the same budget')

    local offFiveM = setmetatable({ _TLIB_IS_FIVEM = false }, { __index = env })
    offFiveM.Platform = { _stub = function() return function() end end }
    offFiveM._G = offFiveM
    assert(loadfile('shared/lib/adapter/lifecycle.lua', 't', offFiveM))()
    local never = offFiveM.Platform.rateLimit('x', 1000)
    check(never(1) == false and never(1) == false, 'off FiveM there is nothing to limit')
end
report('PASS Platform.rateLimit gives the library VM the same gate')

report(('PASS ratelimit-tokens (%d checks)'):format(checks))
