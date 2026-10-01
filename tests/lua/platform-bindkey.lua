-- Run from tLib: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/platform-bindkey.lua
--
-- Oracle for `platform.bindKey` in shared/imports/platform/client.lua.
--
-- Two things are under test and the first matters more than the second:
--
--  1. THE POSITIONAL FORM STILL WORKS. There are 32 live call sites in tELS alone
--     using `bindKey(key, cb, eventType, bindingId, label)`. A command token IS the
--     player's stored rebind in FiveM, so a regression that changed a token would
--     silently reset every player's customised keys — with no error anywhere.
--
--  2. The new capabilities: input groups (the one line that kept three resources on
--     raw RegisterKeyMapping), `pair = false` for one-shot commands, `when` gating,
--     composed labels, the registry, and conflict detection.
--
-- The REAL module is loaded with mocked natives rather than reimplemented. A stand-in
-- would keep passing while the shipped file changed shape.

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

--- Load the REAL platform client module against recording natives.
local function fixture()
    local mappings, commands = {}, {}

    -- The module refuses to load outside FiveM (`client.lua:5` requires both of
    -- these to be functions). Providing them is what makes this an oracle for the
    -- shipped file rather than a test of a reimplementation.
    _ENV.IsDuplicityVersion = function() return false end
    _ENV.GetCurrentResourceName = function() return 'tTest' end
    _ENV.RegisterCommand = function(name, cb, restricted)
        commands[#commands + 1] = { name = name, cb = cb, restricted = restricted }
    end
    _ENV.RegisterKeyMapping = function(command, label, group, key)
        mappings[#mappings + 1] = { command = command, label = label, group = group, key = key }
    end
    -- Natives the module touches at load scope. Stubbed individually rather than
    -- via an __index metatable that returns no-ops for everything: that would also
    -- swallow a typo'd native inside bindKey itself and turn a real regression into
    -- a silent pass.
    _ENV.AddEventHandler = function() end
    _ENV.RegisterNetEvent = function() end
    _ENV.TriggerEvent = function() end
    _ENV.CreateThread = function() end
    -- `Citizen.CreateThread` spawns background threads at load; never running their
    -- bodies keeps the module inert and the assertions about bindKey exact.
    _ENV.Citizen = { CreateThread = function() end, Wait = function() end, SetTimeout = function() end }
    _ENV.SetTimeout = function() end
    _ENV.Wait = function() end
    _ENV.GetResourceState = function() return 'started' end
    _ENV.GetConvar = function(_, default) return default end
    _ENV.GetConvarInt = function(_, default) return default end

    -- The module reports each bind to tLib for cross-resource conflict detection.
    -- It is pcall-guarded on purpose (an older tLib has no such export), so an
    -- absent `exports` must not break registration. Leaving it nil proves that.
    _ENV.exports = nil
    _ENV.tlib = { name = 'tLib' }

    local chunk = assert(loadfile('shared/imports/platform/client.lua'))
    local platform = chunk()
    return platform, mappings, commands
end

-- ── 1. Backward compatibility: the positional form is untouched ──────────────

test('positional form keeps the caller-supplied token verbatim', function()
    local platform, mappings = fixture()
    platform.bindKey('Q', { press = function() end }, nil, 'lbar_toggle', 'ELS: Toggle Lights')
    assertEq(#mappings, 1, 'mapping count')
    assertEq(mappings[1].command, '+lbar_toggle', 'command')
    assertEq(mappings[1].label, 'ELS: Toggle Lights', 'label passed through unchanged')
    assertEq(mappings[1].key, 'Q', 'default key')
    assertEq(mappings[1].group, 'keyboard', 'group still defaults to keyboard')
end)

test('positional form still registers BOTH halves of the pair', function()
    local platform, _, commands = fixture()
    platform.bindKey('Q', { press = function() end }, nil, 'lbar_toggle')
    assertEq(#commands, 2, 'command count')
    assertEq(commands[1].name, '+lbar_toggle', 'press command')
    assertEq(commands[2].name, '-lbar_toggle', 'release command')
end)

test('a bare function still defaults to press', function()
    local platform, _, commands = fixture()
    local fired = false
    platform.bindKey('Q', function() fired = true end, nil, 'x')
    commands[1].cb()
    assertEq(fired, true, 'press fired')
end)

test("eventType 'Released' still routes a bare function to release", function()
    local platform, _, commands = fixture()
    local fired = false
    platform.bindKey('Q', function() fired = true end, 'Released', 'x')
    commands[1].cb()
    assertEq(fired, false, 'press must not fire')
    commands[2].cb()
    assertEq(fired, true, 'release fired')
end)

-- ── 2. Input groups — the blocker that kept three resources on raw calls ─────

test('MOUSE_BUTTON is accepted', function()
    local platform, mappings = fixture()
    platform.bindKey{ token = 'lbarnui_mmb', product = 'LED Editor', action = 'Orbit Camera',
                      default = 'MOUSE_MIDDLE', group = 'MOUSE_BUTTON', press = function() end }
    assertEq(mappings[1].group, 'MOUSE_BUTTON', 'group')
    assertEq(mappings[1].key, 'MOUSE_MIDDLE', 'key')
end)

test('an unknown input group is a hard error, not a silent keyboard fallback', function()
    -- Silently coercing to 'keyboard' would bind a mouse control to nothing and
    -- look like the bind simply did not work.
    local platform = fixture()
    local ok, err = pcall(function()
        platform.bindKey{ id = 'x', default = 'A', group = 'gamepad', press = function() end }
    end)
    assertEq(ok, false, 'must raise')
    assertEq(err:match('unknown input group') ~= nil, true, 'names the problem: ' .. tostring(err))
end)

-- ── 3. Namespacing, and the opt-out that protects stored rebinds ─────────────

test('id is namespaced to the resource', function()
    local platform, mappings = fixture()
    platform.bindKey{ id = 'toggle_lights', default = 'Q', press = function() end }
    assertEq(mappings[1].command, '+ttest_toggle_lights', 'namespaced token')
end)

test('token opts OUT of namespacing so an existing rebind survives', function()
    -- FiveM stores a player's rebind against the command token. Renaming the token
    -- discards it silently, so legacy tokens must pass through untouched.
    local platform, mappings = fixture()
    platform.bindKey{ token = 'talkOnRadio', default = 'B', press = function() end }
    assertEq(mappings[1].command, '+talkOnRadio', 'legacy token verbatim')
end)

-- ── 4. pair = false, for one-shot commands ──────────────────────────────────

test('pair=false registers one command and no release half', function()
    -- tDetector's mute/dim/mark are plain toggles. A forced +/- pair would create a
    -- dead `-token` command and a release the caller never asked for.
    local platform, mappings, commands = fixture()
    platform.bindKey{ token = 'tDetMute', product = 'tDetector', action = 'Mute alerts',
                      default = '', pair = false, press = function() end }
    assertEq(#commands, 1, 'single command')
    assertEq(commands[1].name, 'tDetMute', 'no + prefix')
    assertEq(mappings[1].command, 'tDetMute', 'mapping targets the bare token')
end)

-- ── 5. when — gating, because a mapping is permanent once seen ───────────────

test('when=false registers nothing at all', function()
    -- A RegisterKeyMapping is permanent in the player's settings from first sight,
    -- so a speculative bind leaves a dead row forever.
    local platform, mappings, commands = fixture()
    platform.bindKey{ id = 'arges_aim_up', default = 'NUMPAD8', when = false, press = function() end }
    assertEq(#mappings, 0, 'no mapping')
    assertEq(#commands, 0, 'no command')
end)

test('when=true registers normally', function()
    local platform, mappings = fixture()
    platform.bindKey{ id = 'arges_aim_up', default = 'NUMPAD8', when = true, press = function() end }
    assertEq(#mappings, 1, 'mapping registered')
end)

-- ── 6. Composed labels ──────────────────────────────────────────────────────

test('product and action compose to one house format', function()
    local platform, mappings = fixture()
    platform.bindKey{ id = 'ptt', product = 'Radio', action = 'Push to Talk',
                      default = 'B', press = function() end }
    assertEq(mappings[1].label, 'Radio: Push to Talk', 'composed label')
end)

test('an unbound entry says so, so it is findable in a 70-row list', function()
    local platform, mappings = fixture()
    platform.bindKey{ id = 'blackout', product = 'ELS', action = 'Toggle Blackout',
                      default = '', press = function() end }
    assertEq(mappings[1].label:match('unbound') ~= nil, true, 'suffix present: ' .. mappings[1].label)
end)

test('an explicit label still wins over composition', function()
    local platform, mappings = fixture()
    platform.bindKey{ id = 'x', product = 'ELS', action = 'Ignored',
                      label = 'Exactly This', default = 'Q', press = function() end }
    assertEq(mappings[1].label, 'Exactly This', 'explicit label')
end)

-- ── 7. Registry and conflict detection ──────────────────────────────────────

test('every bind lands in the registry', function()
    local platform = fixture()
    platform.bindKey{ id = 'a', default = 'Q', press = function() end }
    platform.bindKey{ id = 'b', default = 'R', press = function() end }
    assertEq(#platform.keybinds(), 2, 'registry size')
end)

test('two binds on one default key are reported as a conflict', function()
    -- This is the tELS bug in miniature: the siren-tone loop ran 1..8 while cruise,
    -- takedown and traffic advisor already held 6, 7 and 8. Both mappings register
    -- and both dispatch, so nothing errors and the car does two things per press.
    local platform = fixture()
    platform.bindKey{ id = 'cruise', default = '6', press = function() end }
    platform.bindKey{ id = 'tone6', default = '6', press = function() end }
    local conflicts = platform.keybindConflicts()
    assertEq(#conflicts, 1, 'one conflict')
    assertEq(conflicts[1].key, '6', 'on key 6')
    assertEq(#conflicts[1].tokens, 2, 'two claimants')
end)

test('unbound entries do not count as conflicting with each other', function()
    -- Twenty unbound rows all share the empty string; treating that as a collision
    -- would bury the real ones in noise.
    local platform = fixture()
    platform.bindKey{ id = 'a', default = '', press = function() end }
    platform.bindKey{ id = 'b', default = '', press = function() end }
    assertEq(#platform.keybindConflicts(), 0, 'no conflict for unbound')
end)

test('the same key in DIFFERENT input groups is not a conflict', function()
    local platform = fixture()
    platform.bindKey{ id = 'a', default = 'MOUSE_MIDDLE', group = 'MOUSE_BUTTON', press = function() end }
    platform.bindKey{ id = 'b', default = 'MOUSE_MIDDLE', group = 'keyboard', press = function() end }
    assertEq(#platform.keybindConflicts(), 0, 'groups are independent namespaces')
end)

test('registration survives tLib having no ReportKeybind export', function()
    -- The cross-resource report is pcall-guarded because a missing export RAISES
    -- rather than returning nil. An older tLib must not break a consumer's binds.
    local platform, mappings = fixture() -- fixture leaves _ENV.exports nil
    platform.bindKey{ id = 'x', default = 'Q', press = function() end }
    assertEq(#mappings, 1, 'bind still registered')
end)

report(('PASS: %d platform.bindKey checks'):format(passed))
