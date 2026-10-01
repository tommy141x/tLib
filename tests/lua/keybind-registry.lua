-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/keybind-registry.lua
--
-- Oracle for `client/cl_keybinds.lua`, the CROSS-resource keybind registry.
--
-- The thing under test is the case a per-resource check is structurally blind to.
-- `platform.keybindConflicts()` runs in the consumer's own VM and sees only that
-- resource's binds, so it catches tELS binding siren tone 6 on top of its own
-- cruise control, and cannot ever catch:
--
--     B      tELS "ELS: PA Mic (hold)"   vs  tRadio "Radio: Push to Talk"
--     RMENU  tELS "ELS: Toggle Rumbler"  vs  tRadar "tRadar: work the radar keys"
--
-- Both are real, both are on this repo's defaults today, and both are certainties
-- on a police server. Only a registry that outlives a single VM can see them.
--
-- The REAL file is loaded with mocked natives. A reimplementation would keep
-- passing while the shipped file changed.

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

local function assertEq(got, want, what)
    if got ~= want then
        error(('%s: expected %q, got %q'):format(what, tostring(want), tostring(got)), 2)
    end
end

--- Load the REAL cl_keybinds.lua and hand back its three exports.
local function fixture()
    local registered = {}

    _ENV.Logger = { create = function() return function() end end }
    _ENV.Platform = {
        export = function(_, name, fn) registered[name] = fn end,
    }
    -- The deferred conflict print runs in a thread; never running it keeps the
    -- assertions about the registry exact and the output quiet.
    _ENV.CreateThread = function() end
    _ENV.Wait = function() end

    local chunk = assert(loadfile('client/cl_keybinds.lua'))
    chunk()
    return registered.ReportKeybind, registered.GetKeybinds, registered.GetKeybindConflicts
end

test('all three exports are registered', function()
    local r, g, c = fixture()
    assertEq(type(r), 'function', 'ReportKeybind')
    assertEq(type(g), 'function', 'GetKeybinds')
    assertEq(type(c), 'function', 'GetKeybindConflicts')
end)

test('the real cross-resource B collision is detected', function()
    local reportBind, _, conflicts = fixture()
    reportBind{ resource = 'tELS', token = 'lbar_pa', label = 'ELS: PA Mic (hold)',
                default = 'B', group = 'keyboard' }
    reportBind{ resource = 'tRadio', token = 'talkOnRadio', label = 'Radio: Push to Talk',
                default = 'B', group = 'keyboard' }
    local found = conflicts()
    assertEq(#found, 1, 'one conflict')
    assertEq(found[1].key, 'B', 'on B')
    assertEq(#found[1].claims, 2, 'two claimants')
end)

test('two binds from the SAME resource are not reported here', function()
    -- That is the consumer's own business and `platform.keybindConflicts()`
    -- already reports it. Duplicating it here would double every intra-resource
    -- warning and bury the cross-resource ones this file exists for.
    local reportBind, _, conflicts = fixture()
    reportBind{ resource = 'tELS', token = 'lbar_cruise', default = '6', group = 'keyboard' }
    reportBind{ resource = 'tELS', token = 'lbar_tone6', default = '6', group = 'keyboard' }
    assertEq(#conflicts(), 0, 'same-resource pair ignored')
end)

test('unbound entries never collide with each other', function()
    -- Twenty unbound rows all share the empty string. Treating that as a
    -- collision would bury every real conflict in noise.
    local reportBind, _, conflicts = fixture()
    reportBind{ resource = 'tRadio', token = 'radio_menuUp', default = '', group = 'keyboard' }
    reportBind{ resource = 'tELS', token = 'lbar_blackout', default = '', group = 'keyboard' }
    assertEq(#conflicts(), 0, 'no conflict')
end)

test('the same key in different input groups is not a conflict', function()
    local reportBind, _, conflicts = fixture()
    reportBind{ resource = 'tELS', token = 'a', default = 'MOUSE_MIDDLE', group = 'MOUSE_BUTTON' }
    reportBind{ resource = 'tAFK', token = 'b', default = 'MOUSE_MIDDLE', group = 'keyboard' }
    assertEq(#conflicts(), 0, 'groups are independent namespaces')
end)

test('three resources on one key report three claims, not three conflicts', function()
    local reportBind, _, conflicts = fixture()
    for _, res in ipairs({ 'tELS', 'tAFK', 'tRadio' }) do
        reportBind{ resource = res, token = res .. '_mmb',
                    default = 'MOUSE_MIDDLE', group = 'MOUSE_BUTTON' }
    end
    local found = conflicts()
    assertEq(#found, 1, 'one key in conflict')
    assertEq(#found[1].claims, 3, 'three claimants')
end)

test('GetKeybinds returns unbound entries too', function()
    -- A controls UI must list a row the player can assign; omitting unbound
    -- entries would hide exactly the ones needing attention.
    local reportBind, keybinds = fixture()
    reportBind{ resource = 'tRadio', token = 'radio_menuUp', default = '', group = 'keyboard' }
    reportBind{ resource = 'tELS', token = 'lbar_toggle', default = 'Q', group = 'keyboard' }
    assertEq(#keybinds(), 2, 'both listed')
end)

test('a malformed entry is dropped, not raised', function()
    -- This runs inside the consumer's bind path. A keybind registry is not worth
    -- breaking another resource's startup over.
    local reportBind, keybinds = fixture()
    reportBind(nil)
    reportBind('not a table')
    reportBind{ resource = 'tELS' }           -- no token
    reportBind{ token = '' }                  -- empty token
    assertEq(#keybinds(), 0, 'nothing recorded')
end)

test('a missing resource name does not crash the grouping', function()
    local reportBind, keybinds, conflicts = fixture()
    reportBind{ token = 'orphan', default = 'K', group = 'keyboard' }
    assertEq(#keybinds(), 1, 'recorded')
    assertEq(keybinds()[1].resource, '?', 'placeholder resource')
    assertEq(#conflicts(), 0, 'single claim is not a conflict')
end)

report(('PASS: %d keybind registry checks'):format(passed))
