-- The menu request channel's per-player token bucket (burst 30, 15 a second).
-- It is the one limiter every menu, layout and dialog request passes through, so
-- what is asserted is the three things a held key and a flood each depend on: a
-- burst passes, the sustained rate is bounded, and one player's flood does not
-- touch another's.
--
-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/menu-request-gate.lua

local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

local now = 0
function GetGameTimer() return now end
function AddEventHandler() end
function GetCurrentResourceName() return 'tLib' end
local printed = {}
local realPrint = print
function print(...) printed[#printed + 1] = table.concat({ ... }, ' ') end

_TLIB_SIDE = 'server'
Logger = { create = function() return function() end end }
Permission = { pushAll = function() return 0 end }

local RateLimit = assert(loadfile('shared/imports/ratelimit/server.lua', 't', _G))()
local handlers, sent = {}, {}
Platform = setmetatable({
    now = function() return now end,
    AddNetEventHandler = function(name, fn) handlers[name] = fn end,
    TriggerClientEvent = function(_, src, requestId, payload) sent[#sent + 1] = { src = src, id = requestId, p = payload } end,
    rateTokens = function(name, opts) return RateLimit.tokens(name, opts) end,
    hasPermission = function() return true end,
    getInvokingResource = function() return nil end,
    isStudioResource = function() return false end,
    onResourceStop = function() end,
    onPlayerDropped = function() end,
    registerCommand = function() end,
    export = function() end,
    createThread = function() end,
    setTimeout = function() end,
}, { __index = function() return function() end end })

for _, file in ipairs({ 'shared/lib/menu/schema.lua', 'server/lib/menu/registry.lua', 'server/sv_menu.lua' }) do
    assert(loadfile(file, 't', _G))()
end

local request = assert(handlers[MenuSchema.events.request], 'sv_menu registered no request handler')

local function ask(src)
    source = src
    local before = #sent
    request('req-' .. src .. '-' .. before, { kind = 'permissions', actions = {} })
    source = nil
    local reply = sent[#sent]
    return reply and reply.p and reply.p.error
end

local limited = 0
for _ = 1, 40 do if ask(5) == 'Rate limit exceeded' then limited = limited + 1 end end
check(limited == 10, 'a 40-request instant against a burst of 30 refuses the last 10: ' .. limited)

check(ask(6) ~= 'Rate limit exceeded', "one player's flood leaves another player's first request alone")

now = 1000
local passed = 0
for _ = 1, 30 do if ask(5) ~= 'Rate limit exceeded' then passed = passed + 1 end end
check(passed == 15, 'a second later the refill rate has returned 15 tokens: ' .. passed)

check(#printed >= 1 and printed[1]:find('menu:request', 1, true), 'the refusal is reported on the console, once')
local lines = 0
for _, line in ipairs(printed) do if line:find('menu:request', 1, true) then lines = lines + 1 end end
check(lines == 1, 'one line for the whole flood, not one per refusal: ' .. lines)

print = realPrint
print(('PASS menu-request-gate (%d checks)'):format(checks))
