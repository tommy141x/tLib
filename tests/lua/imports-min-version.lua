-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/imports-min-version.lua
--
-- Oracle for the `tlib_min_version` gate in imports.lua.
--
-- Why this exists: `1.0` sorts below every pin it replaced under any reading
-- that is not component-wise semver.
--
--   * a plain numeric read gets the old pins wrong among themselves:
--     tonumber('0.17') == 0.17 < tonumber('0.6') == 0.6, so a tLib declaring
--     0.17.0 would have been refused by a resource pinning 0.6.
--   * a plain string read gets '1.0' > '0.17' right by luck, and '0.9' > '0.17'
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

local stopped, printed = {}, {}
local realPrint = print

--- Load the REAL imports.lua with a consumer pinning `required` against a tLib
--- declaring `installed` (and, optionally, stamped `build`). Returns nil on success, or
--- the gate's error message. `side` is 'server' or 'client'.
local function gate(required, installed, build, side)
    stopped, printed = {}, {}
    _ENV.StopResource = function(name) stopped[#stopped + 1] = name end
    _ENV.print = function(line) printed[#printed + 1] = tostring(line) end
    _ENV.tlib = nil
    _ENV.GetCurrentResourceName = function() return 'consumer' end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.GetNumResourceMetadata = function() return 0 end
    _ENV.GetResourceMetadata = function(resource, key)
        if key == 'tlib_min_version' then
            return resource == 'consumer' and required or nil
        end
        if key == 'version' then return resource == 'tLib' and installed or nil end
        if key == 'tlib_build' then return resource == 'tLib' and build or nil end
        return nil
    end
    _ENV.LoadResourceFile = function() return nil end
    _ENV.IsDuplicityVersion = function() return side ~= 'client' end
    _ENV.exports = setmetatable({}, { __index = function() return {} end })

    local chunk = assert(loadfile('imports.lua'))
    local ok, err = pcall(chunk)
    _ENV.print = realPrint
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
    local box = table.concat(printed, '\n')
    assert(box:find('needs tLib ' .. required .. ' or newer', 1, true),
        ('expected the message to name the required version %s, got: %s'):format(required, box))
    assert(box:find('this server has tLib ' .. installed, 1, true),
        ('expected the message to name the installed version %s, got: %s'):format(installed, box))
end

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

test('a resource with no pin at all is never gated', function()
    allows(nil, '0.6')
    allows('', '0.6')
end)

test('an unparseable installed version is treated as 0.0.0, i.e. refused', function()
    -- GetResourceMetadata answering nil means `or '0.0.0'` in imports.lua.
    local err = gate('1.0', nil)
    assert(err ~= nil, 'a tLib with no declared version must not satisfy a 1.0 pin')
    assert(table.concat(printed, ' '):find('this server has tLib 0.0.0', 1, true),
        'expected the message to name 0.0.0, got: ' .. table.concat(printed, ' '))
end)

test('a refusal prints the version, a download link and stops the consumer', function()
    local err = gate('1.1.2', '1.1', '20261028-6e6b22fa')
    assert(err ~= nil, 'a 1.1 tLib must not satisfy a 1.1.2 pin')
    local box = table.concat(printed, '\n')
    -- The build id is what separates this tLib from the three other 1.1 downloads.
    assert(box:find('this server has tLib 1.1 (build 20261028-6e6b22fa)', 1, true), box)
    assert(box:find('https://github.com/tommy141x/tLib/releases/latest', 1, true), box)
    assert(box:find('not "Source code"', 1, true), box)
    assert(#stopped == 1 and stopped[1] == 'consumer',
        'the consumer must be stopped, or it starts without tlib and fails somewhere else')
    -- The one error line names the pin and nothing else: the box above is the message.
    assert(err == 'consumer needs tLib 1.1.2 or newer', err)
end)

test('a client VM gets one plain error with the link and does not stop anything', function()
    local err = gate('1.1.2', '1.1', nil, 'client')
    assert(err ~= nil)
    assert(err:find('needs tLib 1.1.2 or newer; this server has tLib 1.1', 1, true), err)
    assert(err:find('releases/latest', 1, true), err)
    assert(#stopped == 0 and #printed == 0, 'the client VM cannot stop a server resource')
end)

test('a patch release is told apart from the minor it follows', function()
    -- The reason releases get a patch number: four different tLib builds all said 1.1, and a
    -- consumer pinned to 1.1 accepted every one. 1.1.1 is refused by all of them.
    refuses('1.1.1', '1.1')
    refuses('1.1.2', '1.1.1')
    allows('1.1.1', '1.1.1')
    allows('1.1.1', '1.1.2')
    allows('1.1', '1.1.2')
    allows('1.1.2', '1.2')
end)

test('a satisfied pin prints nothing and stops nothing', function()
    allows('1.1.1', '1.1.1')
    assert(#printed == 0 and #stopped == 0)
end)

report(('Passed %d imports.lua min-version tests'):format(passed))
