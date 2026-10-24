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
    env.printed = {}
    env.GetCurrentResourceName = function() return 'tLib' end
    env.IsDuplicityVersion = function() return side == 'server' end
    env.GetInvokingResource = function() return 'consumer' end
    env.GetGameTimer = function() return 0 end
    env.print = function(line) env.printed[#env.printed + 1] = tostring(line) end
    -- Recorded rather than inert, because an alias published under a retired
    -- resource name IS an event handler and there is nothing else to observe
    -- it by. Keyed by event name, as a list: a second handler for one name is
    -- itself a defect this suite checks for.
    env.handlers = {}
    env.AddEventHandler = function(event, fn)
        local list = env.handlers[event]
        if not list then
            list = {}
            env.handlers[event] = list
        end
        list[#list + 1] = fn
    end

    -- `exports(name, fn)` REGISTERS AN EVENT HANDLER, and this stub has to do
    -- that too or the alias tests below cannot fail.
    --
    -- The engine's own definition, citizen/scripting/lua/scheduler.lua:731:
    --
    --     __call = function(t, exportName, func)
    --         AddEventHandler(getExportEventName(GetCurrentResourceName(), exportName),
    --             function(setCB) setCB(func) end)
    --     end
    --
    -- Note it ignores any resource argument and always uses the CALLING
    -- resource -- which is why wrapExport's `resource` parameter is a label.
    --
    -- This stub used to only record into `env.exported`. That made publishing
    -- under the resource's OWN name invisible: the own-name registration never
    -- reached `env.handlers`, so a self-alias produced exactly one handler and
    -- looked identical to a real alias. Verified by making the retired name
    -- equal the current one -- the suite stayed green. It does not now.
    env.exported = {}
    env.exports = function(name, fn)
        env.exported[name] = fn
        env.AddEventHandler(('__cfx_export_%s_%s'):format(env.GetCurrentResourceName(), name),
            function(setCB) setCB(fn) end)
    end
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

-- ══════════════════════════════════════════════════════════════════
--  publishExportsAs -- a renamed resource keeps answering its old name
--
--  ⚠️ THE NAMES BELOW ARE DELIBERATELY NOT REAL PRODUCT NAMES.
--
--  They were, and the rename of 2026-10-24 swept this file: every mention of
--  the old name became the new one, so these tests ended up publishing a name
--  AS ITSELF and asserting that a handler appeared. They still passed. They had
--  simply stopped being able to tell an alias from a self-alias, which is the
--  entire bug the section exists to catch. `tProduct` / `tRetired` are inert, so
--  no future rename can quietly hollow this out the same way.
--
--  The real case: a resource with a documented, public export API gets renamed.
--  Scripts we do not ship and cannot edit still call the old name, and a folder
--  rename alone turns every one of those into "No such export".
--
--  `provide '<old name>'` in the manifest does NOT fix it. tDB measured that on a
--  live server: `provide` makes GetResourceState report `started` -- which is
--  why it looks sufficient -- while the export call still fails. The mechanism
--  that works is answering `__cfx_export_<resource>_<name>`, which is verbatim
--  what the engine does for a resource's own exports
--  (citizen/scripting/lua/scheduler.lua:627-666) and what oxmysql, rpemotes and
--  qb-policejob all already use for their own legacy names.
--
--  THE ORDERING IS THE TRAP THIS MOSTLY GUARDS. Exports are registered across
--  many files and tLS registers part of its surface in a loop, so "declare the
--  legacy name first" would be a rule that holds on a dev machine and drops a
--  random subset of exports on a customer's server. Both orders are tested
--  because only testing one is how that ships.
-- ══════════════════════════════════════════════════════════════════

-- Inert stand-ins, NOT product names -- see the note above.
local CURRENT        = 'tProduct'
local LEGACY         = 'tRetired'
local SECOND_RETIRED = 'tRetiredToo'

local function handlerFor(env, legacy, name)
    return env.handlers[('__cfx_export_%s_%s'):format(legacy, name)]
end

--- What a consumer gets back. `exports[LEGACY].Foo` TriggerEvents the name with
--- a setter; whatever the handler passes to it is the function that gets called.
local function resolve(env, legacy, name)
    local list = handlerFor(env, legacy, name)
    if not list or #list == 0 then return nil, 0 end
    local resolved
    list[1](function(fn) resolved = fn end)
    return resolved, #list
end

for _, entry in ipairs(SOURCES) do
    local path, side = entry[1], entry[2]

    -- Order A: exports first, legacy name declared afterwards.
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        check(type(platform.publishExportsAs) == 'function', path .. ': publishExportsAs exists')

        platform.wrapExport(CURRENT, 'GetLightState', function(veh) return { veh = veh } end)

        -- NEGATIVE CONTROL. Until the legacy name is declared there must be no
        -- handler for it -- otherwise every later check passes vacuously and
        -- this suite would also pass against a publishExportsAs that did nothing.
        check(
            handlerFor(env, LEGACY, 'GetLightState') == nil,
            path .. ': no legacy handler before publishExportsAs is called'
        )

        platform.publishExportsAs(LEGACY)
        local resolved = resolve(env, LEGACY, 'GetLightState')
        check(resolved ~= nil, path .. ': order A — the old name resolves after the fact')
        check(
            resolved == env.exported['GetLightState'],
            path .. ': order A — the old name resolves to the SAME function, not a copy'
        )
        check(resolved(7).veh == 7, path .. ': order A — arguments reach the body')
    end

    -- Order B: legacy name declared before any export exists. This is the one a
    -- registration loop lands in.
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        platform.publishExportsAs(LEGACY)
        platform.wrapExport(CURRENT, 'AreLightsActive', function() return true end)

        local resolved = resolve(env, LEGACY, 'AreLightsActive')
        check(resolved ~= nil, path .. ': order B — an export registered later is still aliased')
        check(
            resolved == env.exported['AreLightsActive'],
            path .. ': order B — same function object'
        )
    end

    -- The alias is the WRAPPED function, so a throw via the old name is caught
    -- and reported once. Wrapping it a second time would print twice and name
    -- the wrong resource, which is why one object is shared rather than re-made.
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        platform.publishExportsAs(LEGACY)
        platform.wrapExport(CURRENT, 'Boom', function() error('inner') end)

        local resolved = resolve(env, LEGACY, 'Boom')
        check(resolved() == nil, path .. ': a throw via the old name answers nil')
        check(#env.printed == 1, path .. ': a throw via the old name is reported exactly once')
        check(env.printed[1]:find(CURRENT, 1, true), path .. ': the report names the CURRENT resource')
    end

    -- Declaring the same retired name twice must not register the handler twice.
    -- Two handlers both answer, the second setter wins, and nothing visibly
    -- breaks -- which is exactly why it would survive unnoticed.
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        platform.wrapExport(CURRENT, 'IsSirenActive', function() return false end)
        platform.publishExportsAs(LEGACY)
        platform.publishExportsAs(LEGACY)

        local _, count = resolve(env, LEGACY, 'IsSirenActive')
        check(count == 1, path .. ': a repeated publishExportsAs registers one handler, not two')
    end

    -- More than one retired name, because this is a general primitive and tDB
    -- needs three of them (oxmysql, mysql-async, ghmattimysql).
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        platform.publishExportsAs(LEGACY)
        platform.publishExportsAs('tls')
        platform.wrapExport(CURRENT, 'GetTlsState', function() return 'state' end)

        check(resolve(env, LEGACY, 'GetTlsState') ~= nil, path .. ': first retired name answers')
        check(resolve(env, 'tls', 'GetTlsState') ~= nil, path .. ': second retired name answers')
    end

    -- Garbage in is ignored rather than registering `__cfx_export__<name>`,
    -- which would silently answer exports addressed to the empty resource.
    do
        local env = host(side)
        local platform = assert(loadfile(path, 't', env))()
        platform.publishExportsAs('')
        platform.publishExportsAs(nil)
        platform.wrapExport(CURRENT, 'Quiet', function() return 1 end)
        check(handlerFor(env, '', 'Quiet') == nil, path .. ': an empty legacy name registers nothing')
    end
end

print(('PASS: %d wrapExport guard checks'):format(checks))
