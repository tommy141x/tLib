-- The feedback door's two limits: one message per player per minute, and six per
-- minute for the whole server. The order they are applied in is what is asserted:
-- a refusal by one must not spend the other.
--
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/feedback-admit.lua

local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

local now = 0
function GetGameTimer() return now end
function AddEventHandler() end
function GetCurrentResourceName() return 'tLib' end
function GetResourceMetadata() return nil end

_TLIB_SIDE = 'server'
Logger = { create = function() return function() end end }
StudioApi = { baseUrl = function() return 'https://example.test' end }
json = { encode = function() return '{}' end, decode = function() return { url = 'https://example.test/x', body = '{}', headers = {} } end }
exports = { tLib = { fbPrepare = function() return '{}' end, fbClassify = function() return nil end } }
setmetatable(exports, { __index = function(t) return t.tLib end })
function PerformHttpRequest(_, cb) cb(200) end

local RateLimit = assert(loadfile('shared/imports/ratelimit/server.lua', 't', _G))()
Platform = {
    now = function() return now end,
    setTimeout = function() end,
    rateLimit = function(name, interval) return RateLimit.bucket(name, interval) end,
}

local F = assert(loadfile('server/sv_feedback.lua', 't', _G))() or MenuFeedback
F = MenuFeedback

local function send(src)
    local result
    F.submit(src, { message = 'hello' }, function(r) result = r end)
    return result
end

check(send(1).ok == true, "a player's first message goes")
check(send(1).error == 'rate-limited', 'a second inside the minute is refused')
for src = 2, 6 do check(send(src).ok == true, 'player ' .. src .. ' is admitted') end
local seventh = send(7)
check(seventh.error == 'rate-limited', 'the seventh in the minute hits the server ceiling')

-- Refused twice by their own minute, player 1 spent nothing of the server's six.
now = 59999
check(send(1).error == 'rate-limited', 'still inside the first minute')

-- The server window rolls at 60 s; player 7 was turned away by the ceiling, not by
-- their own minute, so they can send at once.
now = 60000
check(send(7).ok == true, 'a player the ceiling refused keeps their own minute')
check(send(1).ok == true, 'and player 1 is clear again a minute on')

-- Fresh state: a player refused by their own minute does not use up a server slot.
do
    now = 200000
    for _ = 1, 20 do send(1) end
    local admitted = 0
    for src = 10, 20 do if send(src).ok then admitted = admitted + 1 end end
    check(admitted == 5, 'twenty refused retries by one player leave five of the six for others: ' .. admitted)
end

-- A game timer that wrapped must not freeze the server window.
do
    now = 4294960000
    for src = 30, 35 do send(src) end
    check(send(36).error == 'rate-limited', 'ceiling holds just before the wrap')
    now = 100
    check(send(37).ok == true, 'a backwards clock opens a fresh window')
end

print(('PASS feedback-admit (%d checks)'):format(checks))
