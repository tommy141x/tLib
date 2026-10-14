-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/imports-min-version.lua
--
-- Oracle for the `tlib_min_version` gate in imports.lua.
--
-- WHY THIS EXISTS: `1.0` sorts BELOW every pin it replaced under any reading
-- that is not component-wise semver.
--
--   * a plain NUMERIC read gets the old pins wrong among themselves:
--     tonumber('0.17') == 0.17 < tonumber('0.6') == 0.6, so a tLib declaring
--     0.17.0 would have been refused by a resource pinning 0.6.
--   * a plain STRING read gets '1.0' > '0.17' right by luck, and '0.9' > '0.17'
--     wrong, for the same reason: it compares the digit '9' against the digit '1'.
--
-- imports.lua reads neither way: `parseVer` splits on every run of digits and
-- compares major, then minor, then patch, each as a NUMBER. These tests pin that,
-- against the shipped file rather than a reimplementation, and they pin the two
-- directions that matter for the 1.0.0 release: every consumer pin is `1.0`, and
-- the one tLib that was ever released before it is 0.6.

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

--- Load the REAL imports.lua with a consumer pinning `required` against a tLib
--- declaring `installed`. Returns nil on success, or the gate's error message.
local function gate(required, installed)
    _ENV.tlib = nil
    _ENV.GetCurrentResourceName = function() return 'consumer' end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.GetNumResourceMetadata = function() return 0 end
    _ENV.GetResourceMetadata = function(resource, key)
        if key == 'tlib_min_version' then
            return resource == 'consumer' and required or nil
        end
        if key == 'version' then return resource == 'tLib' and installed or nil end
        return nil
    end
    _ENV.LoadResourceFile = function() return nil end
    _ENV.IsDuplicityVersion = function() return false end
    _ENV.exports = setmetatable({}, { __index = function() return {} end })

    local chunk = assert(loadfile('imports.lua'))
    local ok, err = pcall(chunk)
    if ok then return nil end
    return tostring(err)
end

local function allows(required, installed)
    local err = gate(required, installed)
    assert(err == nil, ('pin %s should accept tLib %s, got: %s')
        :format(required, installed, tostring(err)))
end

local function refuses(required, installed)
    local err = gate(required, installed)
    assert(err ~= nil, ('pin %s should REFUSE tLib %s, but it loaded'):format(required, installed))
    assert(err:find('requires tLib v' .. required, 1, true),
        ('expected the "update tLib" message naming %s, got: %s'):format(required, err))
    assert(err:find('installed tLib is v' .. installed, 1, true),
        ('expected the message to name the installed version %s, got: %s'):format(installed, err))
end

-- The release this is for: every consumer pins 1.0, tLib declares 1.0.0

test('every consumer pin (1.0) accepts the tLib being shipped (1.0.0)', function()
    allows('1.0', '1.0.0')
end)

test('1.0 refuses 0.6 — the only tLib ever released before it', function()
    refuses('1.0', '0.6')
    refuses('1.0', '0.6.0')
end)

test('1.0 refuses every unreleased development version below it', function()
    for _, v in ipairs({ '0.7.0', '0.8.0', '0.9.0', '0.11.0', '0.12.0', '0.14.0', '0.16.0', '0.17.0' }) do
        refuses('1.0', v)
    end
end)

test('1.0 accepts anything above it, major and minor alike', function()
    for _, v in ipairs({ '1.0.1', '1.1.0', '1.9.0', '2.0.0', '10.0.0' }) do
        allows('1.0', v)
    end
end)

-- The comparison is component-wise and NUMERIC, not textual

test('a NUMERIC read of the whole string would have mis-ordered the old pins', function()
    -- The proof that parseVer is not `tonumber`: 0.17 < 0.6 as a number, and a
    -- tLib declaring 0.17.0 therefore had to satisfy a 0.6 pin, which it does.
    allows('0.6', '0.17.0')
    -- And the reverse is still a refusal, so this is ordering and not permissiveness.
    refuses('0.17', '0.6.0')
end)

test('a TEXTUAL read would have mis-ordered minor versions', function()
    -- '0.9' > '0.17' lexically, because '9' > '1'. Numerically 9 > 17 is false.
    refuses('0.17', '0.9.0')
    allows('0.9', '0.17.0')
end)

test('a two-part declaration is padded, not truncated', function()
    -- Both sides may be written with two components. Neither reads as a patch.
    allows('1.0', '1.0')
    refuses('1.1', '1.0')
end)

test('a v prefix on either side is stripped', function()
    allows('v1.0', 'v1.0.0')
    refuses('v1.0', 'v0.6')
end)

-- Degenerate inputs must not accidentally open or close the gate

test('a resource with no pin at all is never gated', function()
    allows(nil, '0.6')
    allows('', '0.6')
end)

test('an unparseable installed version is treated as 0.0.0, i.e. refused', function()
    -- GetResourceMetadata answering nil means `or '0.0.0'` in imports.lua.
    local err = gate('1.0', nil)
    assert(err ~= nil, 'a tLib with no declared version must not satisfy a 1.0 pin')
    assert(err:find('installed tLib is v0.0.0', 1, true),
        'expected the message to name 0.0.0, got: ' .. err)
end)

report(('Passed %d imports.lua min-version tests'):format(passed))
