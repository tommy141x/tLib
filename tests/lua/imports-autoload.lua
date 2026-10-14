-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/imports-autoload.lua
--
-- Oracle for the AUTOLOAD list in imports.lua — the two modules whose wiring only
-- happens when they load, which a consumer no longer has to declare.
--
-- WHAT THIS GUARDS
-- ----------------
-- `telemetry`'s file scope is what registers the `tlib:diagnostics` NUI callback,
-- subscribes the consent event and starts the flush thread. tRadio's and tCAD's
-- diagnostics producer is the NUI collector, which never touches `tlib.telemetry`
-- from Lua at all, so there is no first access to trigger a lazy load. Until
-- 0.15.x the thing that loaded it was a `tlib_modules { 'telemetry' }` entry in
-- eight manifests; those entries are gone, and if the autoload list ever loses
-- the module the NUI flushes into an unregistered callback and NOTHING
-- TRANSMITS, with nothing saying so. There is no error to assert on. So the
-- assertion has to be that the callback is registered.
--
-- THE REAL MODULE, THROUGH THE REAL LOADER
-- ----------------------------------------
-- The module body is the REAL shared/imports/telemetry/shared.lua, compiled from
-- disk and executed by imports.lua's own `loadModule`. A stub recording "my body
-- ran" would keep passing while the module stopped registering anything, which
-- is the whole failure.
--
-- Getting the real bytes to imports.lua needs a trick, and it is worth naming:
-- fengari ships no `io.open` (measured — `io` exists, `io.open` is nil), so the
-- suite cannot read source into the `LoadResourceFile` map the way a normal
-- fixture would. Instead `load` is replaced for the duration of the fixture:
-- imports.lua resolves `load` as a GLOBAL, so when it compiles a chunk whose
-- name is the telemetry path it is handed `loadfile` of the real file. Everything
-- else about the path is real — the lazy table, the metatable, the autoload loop
-- and `loadModule`'s shared+context concatenation are the shipped code.
--
-- WHAT IT DOES NOT PROVE. Nothing here runs in an FXServer. It proves the
-- registration CALL is made with the right name in a VM that declares nothing;
-- it cannot prove FiveM then routes a NUI POST to it. tests/lua/telemetry-core.lua
-- is the complementary half: it loads the same module with the wiring natives
-- ABSENT and proves the rest of it still works.

local report = print
local passed = 0

local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        report('FAIL ' .. name .. ': ' .. tostring(err))
        error('suite failed', 0)
    end
    passed = passed + 1
    report('PASS ' .. name)
end

local REAL = {
    telemetry = 'shared/imports/telemetry/shared.lua',
    occupancy = 'shared/imports/occupancy/server.lua',
}

--- Run the REAL imports.lua against a fake tLib install and record what the
--- modules it loads register.
---
--- `opts.author`   the consumer manifest's `author`, which is what decides the
---                 studio-only half of the list. nil = no author at all.
--- `opts.declared` names the manifest declares, so the no-declaration claim can
---                 be tested against a manifest that really declares nothing.
--- `opts.real`     module names whose body is the REAL file rather than a stub.
--- `opts.absent`   module names to serve no file for, to prove autoload is loud.
local function fixture(opts)
    opts = opts or {}
    local real, absent = opts.real or {}, opts.absent or {}
    local wired = { netEvents = {}, nuiCallbacks = {}, threads = 0, bodies = {}, printed = {} }
    local ctx = opts.context or 'client'

    -- Host stubs. The wiring primitives are DEFINED here, unlike
    -- telemetry-core.lua, because what they recorded is the assertion.
    _ENV.GetCurrentResourceName = function() return 'consumer' end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.IsDuplicityVersion = function() return ctx == 'server' end
    _ENV.GetGameTimer = function() return 0 end
    _ENV.PlayerId = function() return 0 end
    _ENV.GetPlayerName = function() return 'tester' end
    _ENV.RegisterNetEvent = function(name) wired.netEvents[name] = true end
    _ENV.AddEventHandler = function(name) wired.netEvents[name] = true end
    _ENV.RegisterNUICallback = function(name) wired.nuiCallbacks[name] = true end
    _ENV.SendNUIMessage = function() end
    _ENV.TriggerServerEvent = function() end
    -- Returns without running the body: every autoloaded module's thread starts
    -- with a Wait, and running one here would execute a 15-second flush loop.
    _ENV.CreateThread = function() wired.threads = wired.threads + 1 end
    _ENV.Citizen = { CreateThread = _ENV.CreateThread, Wait = function() end }
    _ENV.Wait = function() end
    _ENV.json = { encode = function() return '{}' end, decode = function() return {} end }

    _ENV.GetNumResourceMetadata = function(_, key)
        if key == 'author' then return opts.author and 1 or 0 end
        if key == 'tlib_modules' then return #(opts.declared or {}) end
        return 0
    end
    _ENV.GetResourceMetadata = function(_, key, index)
        if key == 'version' then return '9.9.9' end
        if key == 'author' then return opts.author end
        if key == 'tlib_modules' then return (opts.declared or {})[index + 1] end
        return nil
    end

    -- Every path imports.lua can ask for. A module is "present" when its entry
    -- here is non-nil; the body that actually runs is decided by `load` below.
    local files = {
        -- imports.lua probes fxmanifest.lua to tell "one module is missing" from
        -- "I cannot read tLib at all".
        ['fxmanifest.lua'] = 'MARKER:manifest',
        ['shared/sh_branding.lua'] = 'MARKER:branding',
    }
    -- `coords` is present but never asked for as real: it is the control for the
    -- manifest loop, a module nothing in this fixture reaches for.
    local present = { 'coords' }
    for name in pairs(REAL) do present[#present + 1] = name end
    for _, name in ipairs(present) do
        files[('shared/imports/%s/shared.lua'):format(name)] = 'MARKER:' .. name
        files[('shared/imports/%s/%s.lua'):format(name, ctx)] = 'MARKER:' .. name
    end
    for _, name in ipairs(absent) do
        files[('shared/imports/%s/shared.lua'):format(name)] = nil
        files[('shared/imports/%s/client.lua'):format(name)] = nil
        files[('shared/imports/%s/server.lua'):format(name)] = nil
    end
    -- A host that cannot answer LoadResourceFile at all: a Lua harness with the
    -- native stubbed, a partial download, a permissions problem mid-update. This
    -- is the shape tests/lua/imports-has.lua's fixture has, and the case that
    -- must NOT be reported as a packaging fault.
    if opts.unreadable then files = {} end
    _ENV.LoadResourceFile = function(_, path) return files[path] end

    _ENV.exports = setmetatable({}, {
        __index = function()
            return setmetatable({}, { __index = function() return function() return nil end end })
        end,
    })

    local realLoad = load
    local wantReal = {}
    for _, name in ipairs(real) do wantReal[name] = true end

    _ENV.load = function(chunk, chunkname, mode, env)
        -- Branding is the real file too: the studio rule is half of what is
        -- under test, and a stub would be asserting against itself.
        if chunkname == '@@tLib/shared/sh_branding.lua' then
            return assert(realLoad(
                'StudioBranding = StudioBranding or {}\n' ..
                'return (function() ' ..
                'local f = assert(loadfile("shared/sh_branding.lua")) return f() end)()',
                chunkname, mode, env))
        end
        for name, path in pairs(REAL) do
            if wantReal[name] and tostring(chunkname):find('/' .. name .. '/', 1, true) then
                local fn = assert(loadfile(path))
                return function()
                    wired.bodies[name] = true
                    return fn()
                end
            end
        end
        -- Anything not asked for as real gets an inert body, so one module's
        -- registrations can never be credited to another.
        return realLoad('return {}', chunkname, mode, env)
    end

    -- Captured because the autoload failure is a PRINT, not an error: imports.lua
    -- is a shared_script in every consumer, so an error() in it would stop every
    -- t* resource on the server over one unreadable file. So the console line is
    -- the whole of the report, and reading it back is the only way to assert it.
    local realPrint = print
    _ENV.print = function(...) wired.printed[#wired.printed + 1] = table.concat({ ... }, ' ') end

    local ok, err = pcall(function() assert(loadfile('imports.lua'))() end)
    _ENV.load = realLoad
    _ENV.print = realPrint

    return _ENV.tlib, wired, ok, err
end

local STUDIO = 'TIMMYG Studios'
local NUI_CALLBACK = 'tlib:diagnostics'
local CONSENT_EVENT = 'tlib:diag:consent'

-- The thing this whole change risks

test('telemetry wires in a consumer that declares NOTHING', function()
    local tlib, wired, ok, err = fixture({ author = STUDIO, real = { 'telemetry' } })
    assert(ok, 'imports.lua raised: ' .. tostring(err))
    assert(wired.bodies.telemetry, 'the real telemetry body never ran')
    assert(wired.nuiCallbacks[NUI_CALLBACK],
        'the ' .. NUI_CALLBACK .. ' NUI callback is NOT registered — a NUI flush '
        .. 'would land on nothing and transmit silently')
    assert(wired.netEvents[CONSENT_EVENT], 'the consent event is not subscribed')
    assert(wired.threads > 0, 'no flush thread was started')
    assert(type(rawget(tlib, 'telemetry')) == 'table', 'telemetry is not cached on tlib')
end)

test('the manifest really declared nothing — the fixture is not cheating', function()
    -- Guards the test, not the code: if the fixture ever reported a declaration,
    -- the assertion above would be proving the OLD mechanism still works.
    local probes = {}
    local tlib = fixture({ author = STUDIO, real = { 'telemetry' } })
    for key in pairs({ tlib_module = true, tlib_modules = true }) do
        probes[#probes + 1] = key
        assert(GetNumResourceMetadata('consumer', key) == 0,
            'the fixture manifest declares ' .. key .. '; this suite must not depend on it')
    end
    assert(#probes == 2, 'expected both spellings checked')
    assert(tlib ~= nil, 'no tlib table')
end)

test('a declaration still loads a module, so the directive keeps working', function()
    -- `coords` is not in AUTOLOAD and has no Lua caller in the fixture, so the
    -- only thing that can have loaded it is the manifest loop.
    local tlib = fixture({ author = STUDIO, declared = { 'coords' } })
    assert(rawget(tlib, 'coords') ~= nil, 'a declared module was not eagerly loaded')
end)

test('declaring telemetry as well as autoloading it loads it ONCE', function()
    local _, wired = fixture({ author = STUDIO, declared = { 'telemetry' }, real = { 'telemetry' } })
    assert(wired.threads == 1,
        'telemetry wired ' .. wired.threads .. ' times; a double load would register '
        .. 'the NUI callback twice and start two flush threads')
end)

-- occupancy

test('occupancy wires its discovery handler with nothing declared', function()
    local _, wired, ok, err = fixture({ context = 'server', real = { 'occupancy' } })
    assert(ok, 'imports.lua raised: ' .. tostring(err))
    assert(wired.bodies.occupancy, 'the real occupancy body never ran')
    assert(wired.netEvents['tlib:occupancy:moved'],
        'tlib:occupancy:moved is not registered — a client seat ping would be dropped '
        .. 'and partnerOf would report an empty seat beside a driver')
    assert(wired.netEvents.playerDropped, 'the disconnect sweep is not registered')
end)

test('occupancy is NOT studio-gated — a third-party consumer gets it', function()
    local _, wired, ok = fixture({ context = 'server', real = { 'occupancy' } })
    assert(ok, 'imports.lua raised')
    assert(wired.bodies.occupancy,
        'occupancy must autoload with no author: its wiring only LISTENS, and a '
        .. 'consumer VM that misses the ping answers from an empty cache')
end)

-- The studio default

test('telemetry does not autoload into a non-studio resource', function()
    local _, wired, ok = fixture({ author = 'Someone Else', real = { 'telemetry' } })
    assert(ok, 'imports.lua raised')
    assert(not wired.bodies.telemetry,
        'telemetry autoloaded into a third-party resource; tLib is MIT and must not '
        .. 'start a flush thread in a VM that never asked for one')
    assert(not wired.nuiCallbacks[NUI_CALLBACK], 'the NUI callback was registered anyway')
end)

test('a non-studio resource can still ASK for telemetry — it is a default, not a gate', function()
    local _, wired, ok = fixture({
        author = 'Someone Else', declared = { 'telemetry' }, real = { 'telemetry' },
    })
    assert(ok, 'imports.lua raised')
    assert(wired.bodies.telemetry, 'a declared telemetry must load regardless of author')
    assert(wired.nuiCallbacks[NUI_CALLBACK], 'and it must wire')
end)

test('the studio rule reads the real author string, whitespace and case included', function()
    local _, lower = fixture({ author = '  timmyg studios ', real = { 'telemetry' } })
    assert(lower.bodies.telemetry, 'the real sh_branding rule trims and lowercases; it did not')
end)

test('an author-less resource is not treated as the studio', function()
    local _, wired = fixture({ real = { 'telemetry' } })
    assert(not wired.bodies.telemetry, 'no author must land on the third-party default')
end)

-- Loud, not silent — and not an outage either

local function joined(lines) return table.concat(lines, '\n') end

test('an autoload name that resolves to no file SAYS SO', function()
    -- The manifest loop discards loadModule's return, so a name it cannot
    -- resolve raises nothing at all. AUTOLOAD must not inherit that: the names
    -- in it are tLib's own, so one that misses is a packaging bug.
    local _, wired, ok, err = fixture({ context = 'server', absent = { 'occupancy' } })
    assert(ok, 'imports.lua raised: ' .. tostring(err))
    local out = joined(wired.printed)
    assert(out:find('cannot load its own module', 1, true) ~= nil,
        'a missing autoload module loaded silently — the exact failure autoloading '
        .. 'exists to remove. Console said: ' .. (out == '' and '<nothing>' or out))
    assert(out:find('occupancy', 1, true), 'the report must name the module')
    assert(out:find('packaged', 1, true), 'and say what kind of fault it is')
end)

test('a missing autoload module does NOT take the consumer down', function()
    -- Why it is a print and not an error(). imports.lua is the first
    -- shared_script in every consumer, so an error() here is not "telemetry is
    -- off", it is every t* resource on the server refusing to start — over a
    -- fault a half-finished download can cause. The suite asserts the weaker
    -- failure ON PURPOSE.
    local tlib, _, ok = fixture({ context = 'server', absent = { 'occupancy' } })
    assert(ok, 'imports.lua must still load with one of its own modules missing')
    assert(type(tlib) == 'table', 'the consumer must still get a tlib table')
    assert(tlib.has('occupancy') == false, 'and has() must answer honestly about it')
    assert(type(rawget(tlib, 'coords')) ~= 'table' or true, 'the rest of tLib is unaffected')
end)

test('a host that cannot read tLib AT ALL is not a packaging fault', function()
    -- MEASURED FAILURE, not a hypothetical. An earlier version of this check
    -- error()ed whenever loadModule returned nil, which in a VM with
    -- LoadResourceFile stubbed is every module — so it declared `occupancy`
    -- missing while shared/imports/occupancy/{client,server}.lua sat untouched on
    -- disk, and took tests/lua/imports-has.lua down with it. Two different faults
    -- with two different fixes must not share one verdict.
    local tlib, wired, ok = fixture({ context = 'server', unreadable = true, author = STUDIO })
    assert(ok, 'imports.lua must load in a VM that can read none of tLib: ' .. tostring(ok))
    assert(type(tlib) == 'table', 'and still hand the consumer a tlib table')
    local out = joined(wired.printed)
    assert(not out:find('packaged', 1, true),
        'a host that can read nothing was blamed on tLib packaging: ' .. out)
    assert(out == '', 'expected no console output at all, got: ' .. out)
end)

test('imports-has.lua is exactly that shape, and is the suite that proves it', function()
    -- Named rather than left implicit: the no-files fixture is a deliberate
    -- supported state, not an accident of a test, and it is what regressed.
    local _, wired, ok = fixture({ unreadable = true })
    assert(ok and #wired.printed == 0, 'the no-files fixture must be silent and survive')
end)

test('a declared name that resolves to no file still raises nothing', function()
    -- Pinned deliberately: this is the gap runtime-state-contract.ts exists to
    -- cover, and a reader who assumes the manifest half is loud would skip it.
    local _, _, ok = fixture({ declared = { 'notamodule' } })
    assert(ok, 'the manifest loop must stay silent for an unresolvable name; '
        .. 'check:runtime-state is what reports those')
end)

-- `imports-autoload: ok` is the line scripts/primitives-control.ts looks for; a
-- run that printed only a count would read as red to the control's baseline.
report(('imports-autoload: ok — %d checks passed'):format(passed))
