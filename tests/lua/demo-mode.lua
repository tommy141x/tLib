-- shared/imports/demo: the demo-server switch, and tLib's own authority over it.
--
-- This module is the only fail-OPEN thing in tLib: while it says yes, every
-- access gate and every permission check says yes too. So the cases below are
-- mostly about the ways it could say yes when it should not -- a convar spelling
-- misread, a client left holding a stale answer, an override that outlives the
-- command that set it.
--
-- server/sv_demo.lua is loaded here as well, because it is tLib's own copy of
-- the rule and a syntax error in it would otherwise only surface on a live
-- server, at boot, on the one file whose job is to say the server is insecure.

local realPrint = print
local rawassert = assert
local printed = {}
local verbose = os.getenv('TLIB_TEST_VERBOSE') == '1'

print = function(s)
    printed[#printed + 1] = tostring(s)
    if verbose then realPrint(s) end
end

local function assert(condition, message)
    if not condition then
        print = realPrint
        for _, line in ipairs(printed) do realPrint('  captured: ' .. line) end
    end
    return rawassert(condition, message)
end

local function printedContains(needle)
    for _, line in ipairs(printed) do
        if line:find(needle, 1, true) then return true end
    end
    return false
end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local convars = {}
local netHandlers, eventHandlers, commands = {}, {}, {}
local clientEvents, serverEvents, triggeredEvents = {}, {}, {}
local threads = {}

GetConvar = function(name, default) return convars[name] or default end
GetCurrentResourceName = function() return 'tLib' end
IsDuplicityVersion = function() return _SIDE == 'server' end
RegisterNetEvent = function(name, fn) netHandlers[name] = fn end
AddEventHandler = function(name, fn) eventHandlers[name] = fn end
TriggerEvent = function(name, ...) triggeredEvents[#triggeredEvents + 1] = { name, ... } end
TriggerServerEvent = function(name, ...) serverEvents[#serverEvents + 1] = { name, ... } end
TriggerClientEvent = function(name, target, value)
    clientEvents[#clientEvents + 1] = { name = name, target = target, value = value }
end
RegisterCommand = function(name, fn, restricted)
    commands[name] = { fn = fn, restricted = restricted }
end
CreateThread = function(fn) threads[#threads + 1] = fn end
Wait = function() end
Platform = { export = function() end }

local SRC = 'shared/imports/demo/shared.lua'

--- Fresh copy of the module for a given side. It caches the convar at load on
--- the client, so a suite that reused one instance could not tell a stale answer
--- from a correct one -- which is the bug worth catching here.
local function loadDemo(side)
    _SIDE = side
    return dofile(SRC)
end

-- ── The convar spelling ─────────────────────────────────────────────────────
--
-- An owner who writes `setr tlib_demo true` and gets a LIVE server is the worst
-- outcome this module can produce, so every spelling either side accepts is
-- pinned. The TypeScript half (tRadio/server/lib/demo.ts) has the same list and
-- the two must not drift.

local demo = loadDemo('server')

for _, yes in ipairs({ '1', 'true', 'TRUE', 'yes', 'on', 'On' }) do
    convars.tlib_demo = yes
    assert(demo.active(), ('%q must read as demo mode'):format(yes))
end

for _, no in ipairs({ '0', 'false', 'no', 'off', '', 'maybe', '2' }) do
    convars.tlib_demo = no
    assert(demo.active() == false, ('%q must NOT read as demo mode'):format(no))
end

convars.tlib_demo = nil
assert(demo.active() == false, 'an unset convar is not demo mode')

-- ── The server reads the convar live ────────────────────────────────────────
--
-- Not cached at load. A server VM that cached would never see `set tlib_demo 1`
-- typed into the console, and the command below sets an override rather than the
-- convar, so nothing else would notice.

convars.tlib_demo = '1'
assert(demo.active(), 'the server re-reads the convar rather than caching it')
convars.tlib_demo = '0'
assert(demo.active() == false, 'and sees it turn off again')

-- ── The override ────────────────────────────────────────────────────────────

demo.set(true)
assert(demo.active(), 'an override of true wins over a convar that says off')
convars.tlib_demo = '1'
demo.set(false)
assert(demo.active() == false, 'and an override of false wins over a convar that says on')
demo.set(nil)
assert(demo.active(), 'clearing the override falls back to the convar')
convars.tlib_demo = '0'

-- ── dropWrite ───────────────────────────────────────────────────────────────

printed = {}
assert(demo.dropWrite('data.json') == false, 'nothing is dropped while demo mode is off')
assert(#printed == 0, 'and nothing is said about it')

convars.tlib_demo = '1'
assert(demo.dropWrite('tRadar/data.json'), 'a write is dropped while demo mode is on')
assert(printedContains('tRadar/data.json'), 'and the file is named, so the drop is not silent')
assert(printedContains('resets on restart'), 'and it says why, not just that')

-- Once per target, not once per write. A demo server saves constantly and a line
-- per save would bury every other message in the console.
printed = {}
for _ = 1, 20 do demo.dropWrite('tRadar/data.json') end
assert(#printed == 0, 'the same target is announced once, not on every write')
demo.dropWrite('tELS/data.json')
assert(#printed == 1, 'but a different target gets its own line')

-- ── The client half ─────────────────────────────────────────────────────────
--
-- A client can only read a convar set with `setr`. Rather than make that
-- spelling load-bearing, tLib pushes the state -- so the client must accept a
-- push, and must ask for one on load rather than sitting on its convar guess.

convars.tlib_demo = nil
serverEvents, netHandlers = {}, {}
local client = loadDemo('client')

assert(client.active() == false, 'a client with no replicated convar starts out not-demo')
assert(#serverEvents == 1 and serverEvents[1][1] == 'tlib:demo:request',
    'and asks the server, rather than holding that guess forever')

local push = netHandlers['tlib:demo:changed']
assert(type(push) == 'function', 'the client listens for the push')
push(true)
assert(client.active(), 'a push of true turns the client on')
push(false)
assert(client.active() == false, 'and a push of false turns it off again')

-- Only a real boolean. A payload that arrives as a string -- which is what a
-- hand-fired event or a future transport change would deliver -- must not be
-- read as truthy, because on the client every non-nil value is.
push('nonsense')
assert(client.active() == false, 'a non-boolean push is not a grant')

-- ── tLib's own copy ─────────────────────────────────────────────────────────
--
-- sv_demo.lua is server_scripts, so nothing else in this repository parses it.
-- Loading it here is what turns a typo in the banner or the command from a
-- boot-time failure on a live server into a failing suite.

_SIDE = 'server'
convars.tlib_demo = '1'
LoadResourceFile = function(_, path)
    assert(path == SRC, 'sv_demo.lua must load the shared module, not reimplement it')
    local f = io and io.open and io.open(path)
    if f then local src = f:read('*a'); f:close(); return src end
    -- fengari ships no io; trampoline into the real file so the module under
    -- test is the real one rather than a copy.
    return ('return dofile(%q)'):format(path)
end

printed, triggeredEvents, clientEvents, commands = {}, {}, {}, {}
dofile('server/sv_demo.lua')

assert(type(Demo) == 'table' and Demo.active(), 'sv_demo.lua exposes the module as `Demo`')
assert(type(Demo.sweepMarketplace) == 'function', 'and adds the marketplace sweep to it')

local cmd = commands.tlib_demo
assert(cmd and cmd.restricted == true,
    'the toggle is registered restricted -- an unrestricted one lets any player open the server')

-- The sweep is addressed to the consumer's own agent, because FiveM's Node
-- runtime refuses a cross-resource write and tLib cannot delete tRadio's files.
triggeredEvents = {}
Demo.sweepMarketplace('tRadio')
assert(#triggeredEvents == 1 and triggeredEvents[1][1] == 'tlib:marketplace:doDemoReset:tRadio',
    'the sweep is dispatched to the owning resource')

-- and never on a server that is not in demo mode, whatever calls it.
Demo.set(false)
triggeredEvents = {}
Demo.sweepMarketplace('tRadio')
assert(#triggeredEvents == 0, 'no sweep is dispatched while demo mode is off')
Demo.sweepMarketplace(nil)
assert(#triggeredEvents == 0, 'and a missing resource name dispatches nothing')

print = realPrint
print('PASS demo-mode')
