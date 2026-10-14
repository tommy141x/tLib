-- shared/imports/net — the two guards that must be impossible to forget.
--
-- Both halves in one suite because the point is that they are one idea: a net
-- event's preamble belongs to the registration, not to the handler. The
-- client's is `source == 65535`; the server's is a positive source, a rate
-- limit, and optionally a permission gate.
--
-- The rate limit here is the REAL tlib.ratelimit, not a stub. Composition with
-- it is the whole reason the server half exists, and a stubbed bucket would
-- prove the call was made and nothing about whether it refuses.

local realPrint = print
local lines = {}
local function capture() lines = {}; print = function(s) lines[#lines + 1] = tostring(s) end end
local function release() print = realPrint end
local function lineCount(needle)
    local n = 0
    for _, l in ipairs(lines) do if l:find(needle, 1, true) then n = n + 1 end end
    return n
end

local registered = {}
GetCurrentResourceName = function() return 'tRadar' end
RegisterNetEvent = function(name, fn) registered[name] = fn end
AddEventHandler  = function() end

local now = 0
GetGameTimer = function() return now end

local ratelimit = dofile('shared/imports/ratelimit/server.lua')
tlib = { ratelimit = ratelimit }

--  CLIENT: fromServer

local client = dofile('shared/imports/net/client.lua')

local got
client.fromServer('tels:serverDefaults', function(a, b) got = { a, b } end)
assert(registered['tels:serverDefaults'], 'the event is registered under its real name')

source = 65535
registered['tels:serverDefaults']('quality', 4)
assert(got and got[1] == 'quality' and got[2] == 4,
    'a server-triggered event runs the handler with its own arguments')

-- THE SECURITY PROPERTY. Each spoof below is a plausible WEAKENING of the
-- guard rather than a stray value, which is what makes the set worth asserting:
--   * nil passes `if source and source ~= 65535 then return end`
--   * the string '65535' passes a tostring comparison
--   * 0 passes a truthiness test
capture()
for _, spoof in ipairs({ 1, 0, 7, -1, '65535', 65534 }) do
    got = nil
    source = spoof
    registered['tels:serverDefaults']('spoofed')
    assert(got == nil, 'source ' .. tostring(spoof) .. ' must not reach the handler')
end
source = nil
registered['tels:serverDefaults']('spoofed')
assert(got == nil, 'a nil source must not reach the handler')

-- Reported, not silently dropped: a resource in this estate firing a
-- server-only event locally by mistake is otherwise completely invisible — the
-- handler simply never runs. ONCE per event name, because the Nth rejection
-- carries nothing the first did not and a per-call print hands an attacker a
-- console flood as the payload.
assert(lineCount('tels:serverDefaults') == 1,
    'seven rejections produce exactly one line')
assert(lineCount('tlib.net.fromServer') == 1, 'and it names the function that dropped it')
release()

-- A second event name gets its own line; the budget is per name, not global.
capture()
client.fromServer('tels:other', function() end)
source = 3
registered['tels:other']()
assert(lineCount('tels:other') == 1, 'a different event name reports separately')
release()

-- Every handler still runs. tRadar registers a SECOND handler for
-- tradar:soundConfigUpdated rather than hooking cl_hud.lua's, precisely so
-- neither depends on which ran first — de-duplicating by name would break it.
local hits = 0
local both = {}
RegisterNetEvent = function(name, fn)
    both[name] = both[name] or {}
    both[name][#both[name] + 1] = fn
end
client.fromServer('tradar:soundConfigUpdated', function() hits = hits + 1 end)
client.fromServer('tradar:soundConfigUpdated', function() hits = hits + 1 end)
assert(#both['tradar:soundConfigUpdated'] == 2, 'two registrations, two handlers')
source = 65535
for _, fn in ipairs(both['tradar:soundConfigUpdated']) do fn() end
assert(hits == 2, 'and both run')
RegisterNetEvent = function(name, fn) registered[name] = fn end

assert(not pcall(client.fromServer, '', function() end), 'an empty event name is refused')
assert(not pcall(client.fromServer, 'x', 'not a function'), 'a non-function handler is refused')

-- The side-mismatch signpost. Not a shim — it raises. Without it a server file
-- calling fromServer gets "attempt to call a nil value (field 'fromServer')",
-- which names the field and says nothing about it existing on the other side.
local ok, err = pcall(client.fromClient, 'x', function() end)
assert(not ok and tostring(err):find('server-side only', 1, true),
    'fromClient on the client says where it lives')

--  SERVER: fromClient

local server = dofile('shared/imports/net/server.lua')

local function fire(name, src, ...)
    source = src
    registered[name](...)
end

-- The source guard ----------------------------------------------------------
ratelimit.reset()
local seenSrc, seenArgs
server.fromClient('tradar:requestServerSettings', function(src, a) seenSrc, seenArgs = src, a end)

fire('tradar:requestServerSettings', 7, 'payload')
assert(seenSrc == 7 and seenArgs == 'payload', 'the handler is called as fn(src, ...)')

for _, bad in ipairs({ 0, -1 }) do
    seenSrc = nil
    now = now + 5000
    fire('tradar:requestServerSettings', bad)
    assert(seenSrc == nil, 'source ' .. tostring(bad) .. ' is not a player')
end
seenSrc = nil
now = now + 5000
fire('tradar:requestServerSettings', nil)
assert(seenSrc == nil, 'a nil source is not a player')

-- The rate limit, on by default ---------------------------------------------
-- 1000 ms, because that is what every tlib.ratelimit.bucket call site in this
-- tree already passes and because an unlimited request-shaped handler is a free
-- amplifier: a few bytes in, a framework job lookup and a panel payload out.
ratelimit.reset()
local calls = 0
registered = {}
server.fromClient('tradar:requestOpenSettings', function() calls = calls + 1 end)

now = 10000
fire('tradar:requestOpenSettings', 7)
assert(calls == 1, 'the first call is served')
fire('tradar:requestOpenSettings', 7)
assert(calls == 1, 'a second call in the same millisecond is refused — the default is ON')
now = 10999
fire('tradar:requestOpenSettings', 7)
assert(calls == 1, 'still inside the floor')
now = 11000
fire('tradar:requestOpenSettings', 7)
assert(calls == 2, 'and served again once the floor has passed')

-- Per player, not globally: one player spamming must not lock everyone out.
fire('tradar:requestOpenSettings', 8)
assert(calls == 3, 'another player has their own floor')

-- Refusal is SILENT, and that is a contract rather than an oversight.
-- tRadar's and tDetector's cl_settings.lua both reopen their dialog WITHOUT
-- going through the request path precisely because the second call inside a
-- second is dropped and the player would otherwise get nothing back. A line per
-- refusal would also be the flood the limit exists to prevent.
capture()
fire('tradar:requestOpenSettings', 8)
assert(#lines == 0, 'a rate-limited refusal prints nothing')
release()

-- rateLimit = 0 opts out, visibly.
ratelimit.reset()
registered = {}
local free = 0
server.fromClient('tradar:tick', { rateLimit = 0 }, function() free = free + 1 end)
now = 20000
for _ = 1, 5 do fire('tradar:tick', 7) end
assert(free == 5, 'rateLimit = 0 serves every call')

-- allow ---------------------------------------------------------------------
-- fromClient without `allow` is a SOURCE GUARD AND A RATE LIMIT, not a
-- permission gate. The two handlers in this tree that captured `local src =
-- source` and never used it in a decision are what `allow` is for.
ratelimit.reset()
registered = {}
local admins = { [7] = true }
local served, denied = 0, {}
server.fromClient('tradar:saveLayout', {
    rateLimit = 0,
    allow     = function(src) return admins[src] == true end,
    onDenied  = function(src) denied[#denied + 1] = src end,
}, function() served = served + 1 end)

capture()
fire('tradar:saveLayout', 7)
assert(served == 1 and #denied == 0, 'an allowed player is served')
fire('tradar:saveLayout', 9)
assert(served == 1 and #denied == 1 and denied[1] == 9, 'a denied player gets onDenied')
-- One line per event name per session. tLib own RegisterAdminEvent prints per
-- denial, which on an event any client may fire is an amplifier of its own.
fire('tradar:saveLayout', 10)
fire('tradar:saveLayout', 11)
assert(served == 1 and #denied == 3, 'every denial reaches onDenied')
assert(lineCount('tradar:saveLayout') == 1, 'but only the first one is printed')
release()

-- Only a boolean true is a grant. A truthy 1 crossing from a framework export
-- is not: `IsPlayerAceAllowed` is the one native in this estate that answers
-- with it, and it is reached through tlib.permission, which normalises it. A
-- raw truthy value here means the caller did not go through that.
ratelimit.reset()
registered = {}
local loose = 0
server.fromClient('tradar:loose', { rateLimit = 0, allow = function() return 1 end },
    function() loose = loose + 1 end)
capture()
fire('tradar:loose', 7)
release()
assert(loose == 0, 'a truthy non-boolean from allow is not a grant')

-- An allow that THROWS denies. An owner function erroring must never become an
-- open event — the rule tlib.access applies to its own `custom` mode.
ratelimit.reset()
registered = {}
local thrown = 0
local sawDenied = false
server.fromClient('tradar:throws', {
    rateLimit = 0,
    allow     = function() error('framework not loaded') end,
    onDenied  = function() sawDenied = true end,
}, function() thrown = thrown + 1 end)
capture()
fire('tradar:throws', 7)
release()
assert(thrown == 0, 'a throwing allow denies')
assert(sawDenied, 'and the player is still told')
assert(lineCount('errored') >= 1, 'and the error itself is printed, not swallowed')

-- An onDenied that throws must not take the handler down with it either.
ratelimit.reset()
registered = {}
server.fromClient('tradar:deniedthrows', {
    rateLimit = 0,
    allow     = function() return false end,
    onDenied  = function() error('consumer bug') end,
}, function() end)
capture()
local okDenied = pcall(fire, 'tradar:deniedthrows', 7)
release()
assert(okDenied, 'a throwing onDenied does not escape the handler')

-- Arity flex and validation -------------------------------------------------
ratelimit.reset()
registered = {}
local flex = 0
server.fromClient('tradar:flex', function(src) flex = src end)
fire('tradar:flex', 7)
assert(flex == 7, 'fromClient(name, fn) is fromClient(name, {}, fn)')

assert(not pcall(server.fromClient, '', {}, function() end), 'an empty event name is refused')
assert(not pcall(server.fromClient, 'x', {}, nil), 'a missing handler is refused')
assert(not pcall(server.fromClient, 'x', { allow = 'yes' }, function() end),
    'a non-function allow is refused rather than read as truthy')
assert(not pcall(server.fromClient, 'x', { onDenied = 'yes' }, function() end),
    'a non-function onDenied is refused')

local okSide, errSide = pcall(server.fromServer, 'x', function() end)
assert(not okSide and tostring(errSide):find('client-side only', 1, true),
    'fromServer on the server says where it lives')

print('net-guards: ok')
