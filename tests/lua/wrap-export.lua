-- `wrapExport` has to wrap, because roughly 40 call sites across the estate
-- believe it does.
--
--  WHAT WAS WRONG 
--
-- All three implementations — `shared/lib/adapter/shim.lua` for tLib's own VM
-- and `shared/imports/platform/{client,server}.lua` for a consumer's — were a
-- bare `exports(name, fn)`. The only comment on them explained why the
-- `resource` argument is ignored, so nothing said the guard was absent, and
-- tRadio, tRadar, tAFK and tChirp all adopted it as one.
--
-- A Lua error inside an export body does not cross the FiveM export boundary.
-- The call returns `undefined`, the message is gone, and it reappears somewhere
-- unrelated as `"undefined" is not valid JSON`. The function named after
-- preventing that was a rename of it.
--
-- THE CONTRACT IS "THE REASON SURVIVES", NOT "THE CALL SUCCEEDS". A throwing
-- export still answers nil — that is what it did before and consumers are
-- written against it. What changed is that the error is now printed under the
-- resource and export name instead of vanishing. The multi-value test is the
-- other half: `ok, reason` is the house return shape, and a guard that
-- truncated it to one value would have been a new bug for an old one.

local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

--- A host just large enough to load one platform adapter and call what it registered.
---
--- The adapters run module-level setup (event handlers, a resource-name cache),
--- so the stubs below are what it takes to get to `wrapExport` rather than a
--- claim about any of them. Everything here is inert except `exports` and
--- `print`, which are the two this suite reads.
local function host(side)
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.exported, env.printed = {}, {}
    env.GetCurrentResourceName = function() return 'tLib' end
    env.IsDuplicityVersion = function() return side == 'server' end
    env.GetInvokingResource = function() return 'consumer' end
    env.GetGameTimer = function() return 0 end
    env.exports = function(name, fn) env.exported[name] = fn end
    env.print = function(line) env.printed[#env.printed + 1] = tostring(line) end
    env.AddEventHandler = function() end
    env.RegisterNetEvent = function() end
    env.RemoveEventHandler = function() end
    env.TriggerEvent = function() end
    env.RegisterCommand = function() end
    env.RegisterKeyMapping = function() end
    env.RegisterNuiCallbackType = function() end
    env.SendNUIMessage = function() end
    env.SetNuiFocus = function() end
    env.SetNuiFocusKeepInput = function() end
    env.LoadResourceFile = function() return nil end
    env.GetConvar = function(_, fallback) return fallback end
    env.Citizen = {
        CreateThread = function() end,
        CreateThreadNow = function() end,
        Wait = function() end,
        SetTimeout = function() end,
    }
    return env
end

local SOURCES = {
    { 'shared/imports/platform/client.lua', 'client', function(env) return env.platform end },
    { 'shared/imports/platform/server.lua', 'server', function(env) return env.platform end },
}

for _, entry in ipairs(SOURCES) do
    local path, side, pick = entry[1], entry[2], entry[3]
    local env = host(side)
    local platform = assert(loadfile(path, 't', env))()
    check(type(platform.wrapExport) == 'function', path .. ': wrapExport exists')

    -- A body that throws: the call answers nil AND the reason is printed.
    platform.wrapExport('tChirp', 'IsSirenActive', function()
        error('provider cascade blew up')
    end)
    local answered = env.exported['IsSirenActive']()
    check(answered == nil, path .. ': a throwing export still answers nil')
    check(#env.printed == 1, path .. ': a throwing export prints exactly once')
    check(env.printed[1]:find('tChirp', 1, true), path .. ': the print names the resource')
    check(env.printed[1]:find('IsSirenActive', 1, true), path .. ': the print names the export')
    check(
        env.printed[1]:find('provider cascade blew up', 1, true),
        path .. ': the print carries the original message'
    )

    -- THE HALF A NAIVE pcall WRAPPER GETS WRONG. `ok, reason` is the house
    -- shape and `return fn(...)` inside a pcall collapses it to `ok`.
    platform.wrapExport('tLib', 'Grant', function(a, b)
        return false, 'no permission', a + b
    end)
    local ok, reason, sum = env.exported['Grant'](2, 3)
    check(ok == false, path .. ': first return value survives')
    check(reason == 'no permission', path .. ': second return value survives')
    check(sum == 5, path .. ': third return value survives, and arguments got through')

    -- A nil in the middle of a return list is a value, not a terminator. Without
    -- `table.pack`'s `n`, `unpack` stops at the hole and the trailing value is lost.
    platform.wrapExport('tLib', 'Sparse', function() return 1, nil, 3 end)
    local one, two, three = env.exported['Sparse']()
    check(one == 1 and two == nil and three == 3, path .. ': a nil mid-list does not truncate')

    -- A successful call prints nothing. A guard that logged on every call would
    -- be worse than no guard on an export called every frame.
    check(#env.printed == 1, path .. ': a successful export prints nothing')
end

-- tLib's own VM copy. Loaded through the adapter entry so it is the real file in
-- its real order, not a hand-picked one — the two copies exist because a
-- consumer's natives must run in the consumer's VM, and they must not diverge.
do
    local env = host('client')
    env.Platform = {}
    assert(loadfile('shared/lib/adapter/shim.lua', 't', env))()
    local Platform = env.Platform
    check(type(Platform.wrapExport) == 'function', 'shim: wrapExport exists')

    Platform.wrapExport('tLib', 'Boom', function() error('inner') end)
    check(env.exported['Boom']() == nil, 'shim: a throwing export answers nil')
    check(#env.printed == 1 and env.printed[1]:find('Boom', 1, true), 'shim: the reason is printed')

    Platform.wrapExport('tLib', 'Pair', function() return false, 'why' end)
    local ok, why = env.exported['Pair']()
    check(ok == false and why == 'why', 'shim: multiple return values survive')

    -- `Platform.export` is an alias and has to inherit the guard rather than
    -- being a second, unguarded door to the same thing.
    Platform.export('tLib', 'AliasBoom', function() error('alias inner') end)
    check(env.exported['AliasBoom']() == nil, 'shim: Platform.export answers nil too')
    check(#env.printed == 2, 'shim: Platform.export is guarded, not a bypass')
end

print(('PASS: %d wrapExport guard checks'):format(checks))
