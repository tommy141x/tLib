-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/imports-has.lua
--
-- Oracle for `tlib.has(module)` in imports.lua.
--
-- The thing under test is a trap, not a feature: `tlib.<anything>` is NEVER falsy,
-- because an unresolvable name falls through to an export proxy. So the guard every
-- consumer reaches for first --  `if tlib.diag then`  -- passes against a tLib that has
-- no `diag` at all, and the crash arrives a line later as "attempt to index a function
-- value" pointing at the consumer. These tests assert the trap still behaves that way
-- (so the docs on `has` stay true) AND that `has` answers correctly either side of it.
--
-- imports.lua is loaded as real source with mocked natives rather than reimplemented,
-- so this is an oracle for the shipped file. A stand-in would keep passing while the
-- real proxy changed shape, which is the entire failure this guards.

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

--- Build a tlib table from the REAL imports.lua against a fake tLib install.
--- `files` maps resource-relative paths to contents; anything absent is absent.
local function fixture(files, ctx)
    local exportCalls = {}

    _ENV.GetCurrentResourceName = function() return 'consumer' end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.GetNumResourceMetadata = function() return 0 end
    _ENV.GetResourceMetadata = function(_, key)
        if key == 'version' then return '9.9.9' end -- never the thing under test here
        return nil
    end
    local probes = {}
    _ENV.LoadResourceFile = function(_, path)
        probes[#probes + 1] = path
        return files[path]
    end
    _ENV.IsDuplicityVersion = function() return ctx == 'server' end
    _ENV.exports = setmetatable({}, {
        __index = function()
            return setmetatable({}, {
                __index = function(_, name)
                    return function(...)
                        exportCalls[#exportCalls + 1] = name
                        return 'export:' .. name
                    end
                end,
            })
        end,
    })

    -- loadfile, not io.open: fengari ships no `io` library, and versioncheck.lua
    -- loads real source the same way.
    assert(loadfile('imports.lua'))()

    return _ENV.tlib, exportCalls, probes
end

local SHARED_ONLY = { ['shared/imports/diag/shared.lua'] = 'return { info = function() end }' }

-- ── The trap itself ─────────────────────────────────────────────────────────

test('a missing module is still truthy — the reason has() exists', function()
    local tlib = fixture({})
    assert(tlib.diag, 'expected the export proxy to make tlib.diag truthy')
    assert(type(tlib.diag) == 'function', 'proxy should be a function, got ' .. type(tlib.diag))
end)

test('indexing a missing module throws the undebuggable error, as documented', function()
    local tlib = fixture({})
    local ok, err = pcall(function() return tlib.diag.info end)
    assert(not ok, 'expected indexing the proxy to throw')
    assert(tostring(err):find('index a function value', 1, true),
        'expected "attempt to index a function value", got: ' .. tostring(err))
end)

-- ── has() ───────────────────────────────────────────────────────────────────

test('has() is false when the module is absent', function()
    local tlib = fixture({})
    assert(tlib.has('diag') == false, 'expected false for an absent module')
end)

test('has() is true when only shared.lua exists', function()
    local tlib = fixture(SHARED_ONLY)
    assert(tlib.has('diag') == true, 'expected true when shared.lua is present')
end)

test('has() is true when only the context file exists', function()
    local tlib = fixture({ ['shared/imports/diag/client.lua'] = 'return {}' }, 'client')
    assert(tlib.has('diag') == true, 'expected true when client.lua is present')
end)

test('has() does not consult the export proxy', function()
    local tlib, exportCalls = fixture({})
    tlib.has('diag')
    assert(#exportCalls == 0, 'has() must not call into tLib exports; it made ' .. #exportCalls)
end)

test('has() never loads the module it is asked about', function()
    local loaded = false
    local files = {
        ['shared/imports/diag/shared.lua'] = 'error("module body must not run", 0)',
    }
    local tlib = fixture(files)
    local ok = pcall(function() loaded = tlib.has('diag') end)
    assert(ok, 'has() must not execute the module body')
    assert(loaded == true, 'expected true for a present-but-broken module')
end)

test('has() rejects non-string and empty names WITHOUT touching the filesystem', function()
    -- Asserting the probe count, not just the answer. `('%s'):format(nil)` yields the
    -- string "nil" rather than erroring, so a bad name still produces a well-formed path
    -- that simply misses -- meaning the return value alone cannot tell whether the type
    -- guard ran. A first version of this test asserted only `== false` and survived
    -- deleting the guard entirely.
    local tlib, _, probes = fixture(SHARED_ONLY)
    assert(tlib.has(nil) == false, 'nil should be false')
    assert(tlib.has('') == false, 'empty string should be false')
    assert(tlib.has(42) == false, 'a number should be false')
    assert(tlib.has({}) == false, 'a table should be false')
    assert(#probes == 0, 'expected no file probes for invalid names, got ' .. #probes)
end)

-- ── The bootstrap trap: has() cannot probe for its own absence ──────────────

test('on a tLib without has(), tlib.has is the proxy and CALLING it hits exports', function()
    -- Simulates every released tLib: `has` is not a real key, so __index returns the
    -- export proxy. This is why a bare `tlib.has('diag')` is unsafe on an old library --
    -- it raises in the consumer's first script rather than answering "absent".
    local tlib, exportCalls = fixture({})
    rawset(tlib, 'has', nil)                       -- as if imports.lua predated has()
    local probe = tlib.has
    assert(type(probe) == 'function', 'expected the proxy, got ' .. type(probe))
    probe('diag')
    assert(exportCalls[1] == 'has',
        'expected the proxy to call exports.tLib.has; calls: ' .. #exportCalls)
end)

test('the documented pcall form survives a has() that is not there', function()
    local tlib = fixture(SHARED_ONLY)
    rawset(tlib, 'has', nil)
    _ENV.exports = setmetatable({}, {
        __index = function()
            return setmetatable({}, {
                __index = function()
                    return function() error('No such export has in resource tLib', 0) end
                end,
            })
        end,
    })
    local ok, present = pcall(function() return tlib.has('diag') end)
    assert(not ok, 'an old tLib should raise from the proxy')
    assert(present ~= false, 'a throw must not be mistaken for a definitive false')
end)

test('has() is not fooled by a partial path match', function()
    local tlib = fixture(SHARED_ONLY)
    assert(tlib.has('dia') == false, 'a prefix of a real module must not report present')
    assert(tlib.has('diagnostics') == false, 'a superstring must not report present')
end)

test('the guard that works reads correctly both ways', function()
    local absent = fixture({})
    assert(not absent.has('diag'), 'absent install should refuse')

    local present = fixture(SHARED_ONLY)
    assert(present.has('diag'), 'present install should allow')
    assert(type(present.diag) == 'table', 'a real module loads as a table')
    assert(type(present.diag.info) == 'function', 'and its members are reachable')
end)

report(('PASS imports-has: %d checks passed'):format(passed))
