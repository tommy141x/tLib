-- shared/imports/access: the server-side gate.
--
-- The real adapters.lua is loaded off disk rather than stubbed, so the framework
-- and inventory call shapes are covered here too. Those were transcribed from
-- the vendored framework sources in internal/reference/frameworks, and the ones
-- that are easy to get subtly wrong -- nested vs flat grade, GetGroups vs
-- PlayerData, geteverything vs getdept -- are pinned below by name.

-- Stub host

local resourceStates = {}
local printed = {}
local clientEvents = {}      -- { event, target, value }
local netHandlers = {}
local resourceStartHandlers = {}
local playerDroppedHandlers = {}
local timers = {}
local gameTime = 0

GetCurrentResourceName = function() return 'tProbe' end
GetResourceState = function(name) return resourceStates[name] or 'missing' end
GetGameTimer = function() return gameTime end
RegisterNetEvent = function(name, fn) netHandlers[name] = fn end
TriggerClientEvent = function(event, target, value)
    clientEvents[#clientEvents + 1] = { event = event, target = target, value = value }
end
AddEventHandler = function(name, fn)
    if name == 'onResourceStart' then resourceStartHandlers[#resourceStartHandlers + 1] = fn end
    if name == 'playerDropped' then playerDroppedHandlers[#playerDroppedHandlers + 1] = fn end
end
SetTimeout = function(ms, fn) timers[#timers + 1] = { ms = ms, fn = fn } end

-- This suite has to capture what the module prints, because "the console told
-- the owner what was wrong" IS the behaviour under test. Capturing it means
-- reassigning the global `print` -- and scripts/run-lua-suite.lua reports a
-- failed suite by calling `print(err)`, so a naive hijack eats the failure
-- message and a broken suite exits 1 with no output at all. (It did. That is why
-- this is here.)
--
-- So: the local `assert` below restores the real print before failing, and
-- TLIB_TEST_VERBOSE=1 echoes everything through for debugging.
local realPrint = print
local rawassert = assert
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

-- server.lua reads adapters.lua with LoadResourceFile and `load()`s the source,
-- so the stub has to hand back a STRING. fengari ships no io.open, so the string
-- is a one-line trampoline into the real file via dofile -- which keeps the real
-- adapters under test rather than a stubbed copy of them, and that is the point:
-- these call shapes were transcribed by hand from vendored framework sources.
LoadResourceFile = function(resource, path)
    assert(resource == 'tLib', 'adapters must be loaded from tLib, got ' .. tostring(resource))
    return ('return dofile(%q)'):format(path)
end

-- Framework / inventory stubs. Each is only reachable when its resource is
-- 'started', which is what detection tests.
local qbxGroups, qbPlayer, esxPlayer, ndPlayer, oxGroups, natOnDuty
local oxCount, qsCount, qbHasItem

exports = setmetatable({}, {
    __index = function(_, name)
        local api = {
            qbx_core = { GetGroups = function(_, src) return qbxGroups(src) end },
            ['qb-core'] = { GetPlayer = function(_, src) return qbPlayer(src) end },
            es_extended = { getSharedObject = function()
                return { GetPlayerFromId = function(src) return esxPlayer(src) end }
            end },
            ND_Core = { getPlayer = function(_, src) return ndPlayer(src) end },
            ox_core = { CallPlayer = function(_, src, method)
                assert(method == 'getGroups', 'ox_core adapter must call getGroups, got ' .. tostring(method))
                return oxGroups(src)
            end },
            nat2k15framework = { geteverything = function() return natOnDuty end },
            ox_inventory = { GetItemCount = function(_, src, item, meta, strict)
                assert(strict == false, 'ox_inventory must be asked with strict = false')
                return oxCount(src, item)
            end },
            ['qs-inventory'] = { GetItemTotalAmount = function(_, src, item) return qsCount(src, item) end },
            ['qb-inventory'] = { HasItem = function(_, src, item, n) return qbHasItem(src, item, n) end },
        }
        return api[name] or error('No such export resource ' .. tostring(name))
    end,
})

local aceGrants = {}
-- `demo` is stubbed rather than omitted because server.lua now consults it on
-- every evaluation. Off for every case below except the demo section at the end,
-- so the rest of this suite keeps asserting the configured rule and not the
-- override.
local demoOn = false
local recordedTimings = {}

tlib = {
    permission = { has = function(src, key) return aceGrants[tostring(src) .. '|' .. tostring(key)] == true end },
    demo = { active = function() return demoOn end },
    -- `tlib.telemetry.record` is called from the instrumented write path. A
    -- RECORDER rather than a no-op, so this suite can assert that a slow write
    -- is actually measured -- a stub that discarded the call would let the
    -- instrumentation be deleted with every test still green.
    telemetry = { record = function(op, budget, ms)
        recordedTimings[#recordedTimings + 1] = { op = op, budget = budget, ms = ms }
    end },
}

local access = dofile('shared/imports/access/server.lua')

-- Detection is cached until a resource starts, which is correct in production
-- and a trap in a suite: without firing the start handlers, every case after the
-- first would silently reuse the first case's framework and assert nothing.
-- (It did. Three cases here passed vacuously before this line existed.)
local function reset()
    resourceStates, printed, clientEvents, timers = {}, {}, {}, {}
    aceGrants = {}
    demoOn = false
    gameTime = gameTime + 10000
    access.use('auto', 'auto')
    for _, fn in ipairs(resourceStartHandlers) do fn() end
end

local function printedContains(needle)
    for _, line in ipairs(printed) do
        if line:find(needle, 1, true) then return true end
    end
    return false
end


-- Modes

reset()
local everyone = access.gate({ mode = 'everyone' }, { key = 'a', label = 'the radio' })
assert(everyone:allowed(1), 'mode everyone allows anyone')
assert(everyone:allowed(nil) == false, 'a nil source is never allowed')
assert(#printed == 0, 'a valid block prints nothing at startup')

reset()
local aceGate = access.gate({ mode = 'ace', ace = 'tradio.use' }, { key = 'b', label = 'the radio' })
assert(aceGate:allowed(7) == false, 'no ace => denied')
aceGrants['7|tradio.use'] = true
aceGate:invalidate()
assert(aceGate:allowed(7), 'granted ace => allowed')

-- Framework axis

reset()
resourceStates.qbx_core = 'started'
qbxGroups = function() return { police = 2 } end
local jobGate = access.gate({ mode = 'job', job = { police = 2, sheriff = 0 } }, { key = 'c', label = 'the detector' })
assert(access.framework() == 'qbx_core', 'qbx_core detected')
assert(jobGate:allowed(7), 'grade 2 meets a minimum of 2')

qbxGroups = function() return { police = 1 } end
jobGate:invalidate()
assert(jobGate:allowed(7) == false, 'grade 1 does not meet a minimum of 2')

qbxGroups = function() return { sheriff = 0 } end
jobGate:invalidate()
assert(jobGate:allowed(7), 'a minimum of 0 accepts any grade')

-- qbx BEFORE qb-core. qbx_core declares `provide 'qb-core'` and registers the
-- qb-core export names, so on a QBox server the qb-core path also "works" and
-- silently returns a deprecated shim. Detection order is the only thing
-- preventing that, so it is pinned.
reset()
resourceStates.qbx_core = 'started'
resourceStates['qb-core'] = 'started'
qbxGroups = function() return { police = 4 } end
qbPlayer = function() error('qb-core adapter must not be reached when qbx_core is running') end
assert(access.framework() == 'qbx_core', 'qbx_core wins over qb-core')
assert(access.jobs(7).police == 4, 'jobs come from the qbx adapter')

-- qb-core nests grade (job.grade.level); ESX keeps it flat (job.grade). Getting
-- these the wrong way round is the classic copy-paste bug, so both are pinned.
reset()
resourceStates['qb-core'] = 'started'
qbPlayer = function() return { PlayerData = { job = { name = 'police', grade = { level = 3 } },
                                              gang = { name = 'ballas', grade = { level = 1 } } } } end
assert(access.jobs(7).police == 3, 'qb-core grade is nested at job.grade.level')
assert(access.jobs(7).ballas == 1, 'qb-core gangs count as jobs for gating')

reset()
resourceStates.es_extended = 'started'
esxPlayer = function() return { job = { name = 'ambulance', grade = 5 } } end
assert(access.jobs(7).ambulance == 5, 'ESX grade is a flat number on job.grade')

reset()
resourceStates.ND_Core = 'started'
ndPlayer = function() return { job = 'police', groups = { police = { rank = 6 } } } end
assert(access.jobs(7).police == 6, 'ND_Core rank comes from groups[name].rank, not the job string')

reset()
resourceStates.ox_core = 'started'
oxGroups = function() return { police = 2 } end
assert(access.jobs(7).police == 2, 'ox_core groups come back through CallPlayer(getGroups)')

-- nat2k15 has no rank of any kind, and `getdept(id)` returns the WHOLE on_duty
-- table rather than one player's dept -- so the adapter must use geteverything
-- and index by src. Reporting grade 0 means a grade requirement denies rather
-- than being silently ignored.
reset()
resourceStates.nat2k15framework = 'started'
natOnDuty = { [7] = { src = 7, dept = 'LSPD' }, [9] = { src = 9, dept = 'BCSO' } }
assert(access.jobs(7).LSPD == 0, 'nat2k15 reports the players own dept at grade 0')
assert(access.jobs(9).LSPD == nil and access.jobs(9).BCSO == 0, 'nat2k15 does not give every player every dept')

local natStrict = access.gate({ mode = 'job', job = { LSPD = 3 } }, { key = 'nat', label = 'x' })
assert(natStrict:allowed(7) == false, 'a grade requirement on a gradeless framework denies, it does not ignore the grade')

-- Inventory axis, independent of the framework

-- The whole point of two axes: nat2k15 for jobs, ox_inventory for items, on the
-- same server. Neither adapter knows the other exists.
reset()
resourceStates.nat2k15framework = 'started'
resourceStates.ox_inventory = 'started'
natOnDuty = { [7] = { src = 7, dept = 'LSPD' } }
oxCount = function() return 2 end
assert(access.framework() == 'nat2k15framework' and access.inventory() == 'ox_inventory',
    'framework and inventory are detected independently')
local itemGate = access.gate({ mode = 'item', item = 'radio', count = 2 }, { key = 'd', label = 'the radio' })
assert(itemGate:allowed(7), 'holding 2 meets a required count of 2')
oxCount = function() return 1 end
itemGate:invalidate()
assert(itemGate:allowed(7) == false, 'holding 1 does not meet a required count of 2')

-- A server with NO framework can still gate on an item.
reset()
resourceStates['qs-inventory'] = 'started'
qsCount = function() return 1 end
assert(access.framework() == nil, 'no framework is a supported state, not an error')
local noFw = access.gate({ mode = 'item', item = 'scanner' }, { key = 'e', label = 'the scanner' })
assert(noFw:allowed(7), 'item gating works with no framework at all')

-- qs returns nil for an unknown item; that must read as 0, not blow up.
qsCount = function() return nil end
noFw:invalidate()
assert(noFw:allowed(7) == false, 'a nil count from an inventory reads as zero')

-- The boolean-only inventories get the threshold passed through, because they
-- can answer "at least n?" but have no count export to answer "how many?".
reset()
resourceStates['qb-inventory'] = 'started'
local askedFor
qbHasItem = function(_, _, n) askedFor = n; return true end
local qbGate = access.gate({ mode = 'item', item = 'radio', count = 3 }, { key = 'f', label = 'the radio' })
assert(qbGate:allowed(7), 'qb-inventory HasItem satisfies the gate')
assert(askedFor == 3, 'the required count reaches a boolean-only inventory instead of being compared locally')

-- Detection rules

-- 'stopped' is not 'started'. community_bridge tests `~= "missing"`, so a
-- leftover stopped inventory folder knocks out the live one there; this must not.
reset()
resourceStates.ox_inventory = 'stopped'
resourceStates['qs-inventory'] = 'started'
qsCount = function() return 1 end
assert(access.inventory() == 'qs-inventory', 'a stopped resource does not win detection')

-- Detection is redone when a resource starts, so a gate built before the
-- framework does not deny forever.
reset()
assert(access.framework() == nil, 'nothing detected yet')
resourceStates.ox_core = 'started'
for _, fn in ipairs(resourceStartHandlers) do fn() end
assert(access.framework() == 'ox_core', 'a framework that starts later is picked up')

-- A pinned choice survives that re-detection; otherwise the pin would silently
-- evaporate the next time any resource restarted.
reset()
resourceStates.ox_core = 'started'
resourceStates['qb-core'] = 'started'
access.use('qb-core')
assert(access.framework() == 'qb-core', 'use() pins the framework')
for _, fn in ipairs(resourceStartHandlers) do fn() end
assert(access.framework() == 'qb-core', 'a pinned framework survives re-detection')

reset()
access.use('not_a_framework')
assert(printedContains('no framework adapter named'), 'pinning an unknown adapter says so')

-- Custom, and failing closed

reset()
local customGate = access.gate({ mode = 'custom', custom = function(src) return src == 7 end },
    { key = 'g', label = 'the radio' })
assert(customGate:allowed(7) and customGate:allowed(8) == false, 'custom decides')

reset()
local throwing = access.gate({ mode = 'custom', custom = function() error('boom') end },
    { key = 'h', label = 'the radio' })
assert(throwing:allowed(7) == false, 'a custom function that errors denies -- it does not become an open gate')
assert(printedContains('errored'), 'and the error is reported rather than swallowed')

-- A custom function returning a truthy non-true value is NOT a grant. Owners
-- write `return player` by accident; that must not open the gate.
reset()
local truthy = access.gate({ mode = 'custom', custom = function() return 'yes' end }, { key = 'i', label = 'x' })
assert(truthy:allowed(7) == false, 'only a real boolean true grants access')

-- Combining modes

reset()
resourceStates.ox_inventory = 'started'
oxCount = function() return 0 end
local either = access.gate({ mode = { 'ace', 'item' }, ace = 'tradio.admin', item = 'radio' },
    { key = 'j', label = 'the radio' })
assert(either:allowed(7) == false, 'neither branch satisfied => denied')
aceGrants['7|tradio.admin'] = true
either:invalidate()
assert(either:allowed(7), 'a list of modes is an OR')

-- Bad config denies, loudly

reset()
local broken = access.gate({ mode = 'jobb', job = { police = 0 } }, { key = 'k', label = 'the detector' })
assert(broken:allowed(7) == false, 'a misspelled mode denies everyone rather than guessing')
assert(printedContains('unknown entry "jobb"'), 'and names the bad value')

reset()
local noAce = access.gate({ mode = 'ace' }, { key = 'l', label = 'the detector' })
assert(noAce:allowed(7) == false, 'mode ace with no ace key denies')
assert(printedContains('access.ace is not set'), 'and says which key is missing')
assert(printedContains('add_ace'), 'and shows the server.cfg line that grants it')

reset()
local missing = access.gate(nil, { key = 'm', label = 'the detector' })
assert(missing:allowed(7) == false, 'a missing access block denies')
assert(printedContains('must be a table'), 'and says so')

-- "mode is job but no framework" is environmental, not structural: the
-- framework may simply not have started yet. It must NOT be reported at
-- construction, and must NOT disable the gate.
reset()
local pending = access.gate({ mode = 'job', job = { police = 0 } }, { key = 'n', label = 'the detector' })
assert(not printedContains('no supported framework'), 'a not-yet-started framework is not an error at startup')
resourceStates.qbx_core = 'started'
for _, fn in ipairs(resourceStartHandlers) do fn() end
qbxGroups = function() return { police = 0 } end
assert(pending:allowed(7), 'the gate starts working once the framework appears, with no restart')

reset()
access.gate({ mode = 'job', job = { police = 0 } }, { key = 'o', label = 'the detector' })
for _, timer in ipairs(timers) do timer.fn() end
assert(printedContains('no supported framework'), 'but it IS reported once the server has settled')

-- Memoisation and pushing

reset()
local calls = 0
local memoGate = access.gate({ mode = 'custom', custom = function() calls = calls + 1; return true end },
    { key = 'p', label = 'x' })
memoGate:allowed(7); memoGate:allowed(7); memoGate:allowed(7)
assert(calls == 1, 'repeat checks inside the window reuse the answer')
gameTime = gameTime + 1000
memoGate:allowed(7)
assert(calls == 2, 'the answer expires')
memoGate:invalidate(7)
memoGate:allowed(7)
assert(calls == 3, 'invalidate forces a recheck')

-- Memoisation is per player, not global -- sharing one answer across players
-- would be the worst possible bug in this file.
reset()
local seen = {}
local perPlayer = access.gate({ mode = 'custom', custom = function(src) seen[#seen + 1] = src; return src == 7 end },
    { key = 'q', label = 'x' })
assert(perPlayer:allowed(7) and perPlayer:allowed(8) == false, 'each player is decided on their own')

reset()
local pushGate = access.gate({ mode = 'everyone' }, { key = 'r', label = 'x' })
pushGate:push(7)
assert(#clientEvents == 1 and clientEvents[1].target == 7 and clientEvents[1].value == true,
    'push sends the answer to that one client')
assert(clientEvents[1].event == 'tProbe:tlib:access:r',
    'the event is namespaced by resource, since FiveM net event names are global')

-- The client can only REQUEST an answer. Anything it sends is ignored, and the
-- reply is recomputed server-side.
reset()
local netGate = access.gate({ mode = 'custom', custom = function() return false end }, { key = 's', label = 'x' })
source = 7
netHandlers['tProbe:tlib:access:s'](true)   -- a client asserting "I am allowed"
assert(#clientEvents == 1 and clientEvents[1].value == false,
    'the server ignores what the client claims and answers with its own decision')

-- Extension points

-- A custom `detect`, rather than the default resource-name check -- both because
-- that is the extension point a fork needs, and because a registered adapter
-- that detected unconditionally would silently win every later case in this file.
access.registerFramework({ name = 'my_fork',
    detect = function() return resourceStates.my_fork == 'started' end,
    jobs = function() return { chief = 9 } end })
access.registerFramework({ name = 'bad_fork',
    detect = function() return resourceStates.bad_fork == 'started' end,
    jobs = function() return 'not a table' end })

reset()
resourceStates.qbx_core = 'started'
resourceStates.my_fork = 'started'
qbxGroups = function() return { police = 1 } end
assert(access.framework() == 'my_fork', 'a registered adapter takes priority over the built-ins')
assert(access.jobs(7).chief == 9, 'and answers the job query')

-- An adapter returning the wrong type must read as "no jobs", not crash a gate.
reset()
resourceStates.bad_fork = 'started'
local r = access.jobs(7)
assert(type(r) == 'table' and next(r) == nil, 'a malformed adapter response is an empty job set')

-- describe()

reset()
resourceStates.ox_inventory = 'started'
local described = access.gate({ mode = { 'ace', 'item' }, ace = 'tradio.use', item = 'radio', count = 2 },
    { key = 't', label = 'the radio' }):describe()
assert(described:find('the radio', 1, true), 'describe names the gate')
assert(described:find('ace "tradio.use"', 1, true), 'describe shows the ace')
assert(described:find('item "radio" x2 via ox_inventory', 1, true),
    'describe shows the item, the count and which inventory answers it')
assert(described:find(' OR ', 1, true), 'describe shows that the modes are an OR')

reset()
local blind = access.gate({ mode = 'job', job = { police = 0 } }, { key = 'u', label = 'the detector' }):describe()
assert(blind:find('NO FRAMEWORK DETECTED', 1, true),
    'describe says plainly when nothing can answer the gate -- that is the diagnostic that matters')

-- Registering an adapter AFTER something has already asked a gate a question is
-- the normal case, not an edge case: a consumer's server script registering a
-- fork's adapter runs after startup. Rebuilding the adapter list without also
-- clearing the cached detection result would leave the new adapter in the list
-- and never let it win.
reset()
resourceStates['qb-core'] = 'started'
qbPlayer = function() return { PlayerData = { job = { name = 'police', grade = { level = 1 } } } } end
assert(access.framework() == 'qb-core', 'detection has already happened and is cached')
resourceStates.late_fork = 'started'
access.registerFramework({ name = 'late_fork',
    detect = function() return resourceStates.late_fork == 'started' end,
    jobs = function() return { chief = 5 } end })
assert(access.framework() == 'late_fork',
    'an adapter registered after detection still takes effect, without a restart')

-- A pin was set deliberately and outranks a later registration.
reset()
resourceStates['qb-core'] = 'started'
resourceStates.late_fork = 'started'
access.use('qb-core')
access.registerFramework({ name = 'late_fork2',
    detect = function() return resourceStates.late_fork == 'started' end,
    jobs = function() return {} end })
assert(access.framework() == 'qb-core', 'registering an adapter does not silently undo a pin')

-- report(): the shape a diagnostic asserts on

reset()
resourceStates.qbx_core = 'started'
local rep = access.gate({ mode = { 'job', 'item' }, job = { police = 2 }, item = 'radar' },
    { key = 'v', label = 'the radar' }):report()
assert(rep.label == 'the radar' and rep.modes[1] == 'job' and rep.modes[2] == 'item',
    'report lists the modes in order')
assert(rep.job.police == 2 and rep.item == 'radar' and rep.count == 1,
    'report carries the thresholds, with count defaulted')
assert(rep.framework == 'qbx_core' and rep.inventory == nil,
    'report says what is actually answering each axis')
assert(rep.broken == false, 'report says whether the gate is disabled')

-- report() must be a copy: `self.block` IS the owner's live Config table, so a
-- diagnostic that mutated what report() handed back would be corrupting the
-- server's configuration by reading it.
reset()
local liveBlock = { mode = 'job', job = { police = 2 } }
local copyGate = access.gate(liveBlock, { key = 'w', label = 'x' })
local first = copyGate:report()
first.job.police = 99
first.modes[1] = 'everyone'
assert(copyGate:report().job.police == 2, 'report hands back a copy of the job table, not the live one')
assert(copyGate:report().modes[1] == 'job', 'and a copy of the mode list')
assert(liveBlock.job.police == 2, 'and the owner config table itself is untouched')

-- Fail closed when the framework cannot answer

-- A framework that is not loaded is not a reason to hand out the resource. This
-- is the same rule tRadar's sv_access.lua reached independently, and it is the
-- single most important default in this file, so it is pinned rather than left
-- to fall out of the implementation.
reset()
local orphan = access.gate({ mode = 'job', job = { police = 0 } }, { key = 'x', label = 'the radar' })
assert(access.framework() == nil and orphan:allowed(7) == false,
    'job mode with no framework denies -- it never fails open')

reset()
resourceStates.qbx_core = 'started'
qbxGroups = function() error('framework exploded') end
local exploded = access.gate({ mode = 'job', job = { police = 0 } }, { key = 'y', label = 'the radar' })
assert(exploded:allowed(7) == false, 'a framework that throws denies, it does not fail open')

-- Demo mode
--
-- The one override in this module that grants rather than denies. Each case
-- below pins a way the override could be applied by halves and silently leave a
-- demo visitor locked out of the thing the demo exists to show.

reset()
local shut = access.gate({ mode = 'ace', ace = 'tradio.use' }, { key = 'd1', label = 'the radio' })
assert(shut:allowed(7) == false, 'an unheld ace denies while demo mode is off')
demoOn = true
shut:invalidate()
assert(shut:allowed(7), 'demo mode grants a gate the player would fail')

-- Ahead of the memo, not behind it: the 250ms answer cache would otherwise hold
-- a denial across a runtime `tlib_demo on` for a quarter second per player.
-- Invalidate is the documented way to clear it, and this asserts nothing else is
-- needed once it has been called.
demoOn = false
shut:invalidate()
assert(shut:allowed(7) == false, 'and stops granting the moment demo mode is off')

-- A broken block disables a gate outright. Demo mode has to beat that too: the
-- config error is in a file the visitor cannot see, so a gate left shut would
-- look like a missing feature with no way to diagnose it from in-game.
reset()
local broken = access.gate({ mode = 'nonsense' }, { key = 'd2', label = 'the radio' })
assert(broken:allowed(7) == false, 'a broken block denies everyone while demo mode is off')
demoOn = true
broken:invalidate()
assert(broken:allowed(7), 'demo mode grants even a gate broken by a config error')

-- and says so, so that a support dump from a demo server cannot be read as
-- evidence that the configured rule evaluates open.
assert(broken:report().demo == true, 'report() names demo mode as the reason')
assert(broken:describe():find('demo mode', 1, true), 'describe() says so in prose too')
demoOn = false
assert(broken:report().demo == false, 'and reports it false again once off')

reset()
local nilSrc = access.gate({ mode = 'everyone' }, { key = 'd3', label = 'the radio' })
demoOn = true
assert(nilSrc:allowed(nil) == false, 'demo mode still refuses a nil source')

-- A GATE SWEEPS ITSELF ON DISCONNECT
--
-- Gate:allowed memoises one answer per player it has ever been asked about, and
-- the TTL makes an entry stale rather than making it go away. Nothing in the
-- gate ever removed one, so every gate in the tree was a slow leak: one table
-- entry per unique player per gate, held for the life of the process.
--
-- It was found because exactly two resources happened to notice and swept their
-- own gates by hand from their own playerDropped handlers. A consumer cannot
-- reasonably be expected to know a gate needs sweeping, so the gate does it.
--
-- Asserted through the OBSERVABLE consequence -- the memo is private -- by
-- flipping what the gate reads underneath it. Inside the TTL a memoised answer
-- survives that flip; after a disconnect it must not.

reset()
local sweepGate = access.gate({ mode = 'ace', ace = 'tprobe.admin' },
    { key = 'sweep', label = 'the radio' })

assert(#playerDroppedHandlers == 1,
    'the disconnect sweep must be installed exactly once, not once per gate; got '
    .. #playerDroppedHandlers)

local function dropPlayer(src)
    source = src
    for _, fn in ipairs(playerDroppedHandlers) do fn() end
    source = nil
end

gameTime = 1000
aceGrants['11|tprobe.admin'] = true
assert(sweepGate:allowed(11), 'precondition: the ace grant opens the gate')

aceGrants['11|tprobe.admin'] = nil
assert(sweepGate:allowed(11),
    'precondition: inside the TTL the memoised answer is reused, so there IS '
    .. 'something for the sweep to drop')

dropPlayer(11)
assert(sweepGate:allowed(11) == false,
    'a disconnected player kept their memoised answer; the gate leaks one entry '
    .. 'per unique player for the life of the server')

-- Every gate, not just the most recent one.
local second = access.gate({ mode = 'ace', ace = 'tprobe.admin' },
    { key = 'sweep2', label = 'the radio' })
assert(#playerDroppedHandlers == 1, 'a second gate registered a second handler')
aceGrants['12|tprobe.admin'] = true
assert(second:allowed(12) and sweepGate:allowed(12), 'precondition: both gates memoised 12')
aceGrants['12|tprobe.admin'] = nil
dropPlayer(12)
assert(second:allowed(12) == false and sweepGate:allowed(12) == false,
    'the sweep reached only some of the live gates')

-- A disconnect with no source must not wipe every player from every gate.
aceGrants['13|tprobe.admin'] = true
assert(sweepGate:allowed(13), 'precondition')
aceGrants['13|tprobe.admin'] = nil
dropPlayer(nil)
assert(sweepGate:allowed(13),
    'a sourceless playerDropped invalidated everyone')

-- The instrumentation is reachable, and ONLY on the miss path
--
-- Two assertions, and the second is the one worth having. A memo HIT returns
-- before `evaluate` and is not a measurement of anything, so recording it would
-- bury every real framework round trip under thousands of near-zero samples and
-- make the p95 meaningless. Deleting the record call entirely leaves every case
-- above green, which is why this is asserted at all.
local evaluations = 0
for _, t in ipairs(recordedTimings) do
    if t.op == 'access:evaluate' then
        evaluations = evaluations + 1
        if t.budget ~= 50 then
            fail('the access evaluate budget is ' .. tostring(t.budget) .. ' ms, not 50')
        end
    end
end
if evaluations == 0 then
    fail('Gate:allowed recorded no timing; the diagnostics instrumentation is gone')
end

local before = evaluations
local memoGate = access.gate({ mode = 'everyone' }, { key = 'memo', label = 'memo' })
memoGate:allowed(4242)
for _ = 1, 20 do memoGate:allowed(4242) end
local after = 0
for _, t in ipairs(recordedTimings) do
    if t.op == 'access:evaluate' then after = after + 1 end
end
if (after - before) ~= 1 then
    fail(('21 allowed() calls for one player recorded %d evaluations, not 1 -- a memo hit '
        .. 'is being timed, which buries every real framework round trip'):format(after - before))
end

print = realPrint
print('PASS access-gate')
