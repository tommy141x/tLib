-- Giving NUI focus back to the game: the native ordering, and the deferred
-- release's generation guard.
--
-- ## What this suite can and cannot prove
--
-- It cannot prove which of `SetNuiFocus(false, false)` and
-- `SetNuiFocusKeepInput(false)` must come first. That is a fact about CitizenFX
-- and there is no offline oracle for it: neither native is in the native
-- reference (only the `IsNuiFocused` / `IsNuiFocusKeepingInput` readers are),
-- and this tree held three different orderings with two mutually incompatible
-- comments justifying them, neither carrying a measurement.
--
-- So it proves something weaker and more useful: that the sequence the shared
-- helper emits ends with keepInput off under *either* of the two semantics the
-- comments imply, while each two-call ordering is broken under one of them.
-- That is why the helper makes three calls instead of two.
--
-- `IsNuiFocusKeepingInput()` is the real oracle. Read it in game after a
-- release before anyone shortens this.

local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end


-- Host

local function host()
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.calls = {}
    env.threads = {}
    env.Citizen = {
        CreateThread = function(fn) env.threads[#env.threads + 1] = coroutine.create(fn) end,
        CreateThreadNow = function(fn) fn() end,
        Wait = function(ms) return coroutine.yield(ms) end,
    }
    env.GetCurrentResourceName = function() return 'tLib' end
    env.IsDuplicityVersion = function() return false end
    env.SetNuiFocus = function(a, b)
        env.calls[#env.calls + 1] = { 'SetNuiFocus', a, b }
    end
    env.SetNuiFocusKeepInput = function(a)
        env.calls[#env.calls + 1] = { 'SetNuiFocusKeepInput', a }
    end
    env.DisableControlAction = function() env.disabled = (env.disabled or 0) + 1 end
    env.GetResourceState = function() return 'missing' end
    env.GetConvar = function(_, d) return d end
    env.GetConvarInt = function(_, d) return d end
    env.exports = function() end
    env.AddEventHandler = function() end
    env.RegisterNetEvent = function() end
    env.RegisterNuiCallbackType = function() end
    env.SendNUIMessage = function() end
    env.Logger = { create = function() return function() end end }
    env.Utils = { warnOnce = function() end }
    return env
end

--- Run every queued thread to completion, resuming through its Citizen.Wait
--- yields. One pass is one frame for the purposes of this suite.
local function pump(env, frames)
    for _ = 1, frames or 40 do
        local pending = env.threads
        if #pending == 0 then return end
        env.threads = {}
        for _, thread in ipairs(pending) do
            local ok, err = coroutine.resume(thread)
            check(ok, 'deferred thread errored: ' .. tostring(err))
            if coroutine.status(thread) ~= 'dead' then
                env.threads[#env.threads + 1] = thread
            end
        end
    end
end

local function load(env)
    -- Relative to the resource root, which is test-lua.ts's cwd.
    local path = 'shared/imports/platform/client.lua'
    local chunk = assert(loadfile(path, 't', env))
    return chunk()
end

--- The native names in call order, as one string, for readable assertions.
local function sequence(env)
    local out = {}
    for _, call in ipairs(env.calls) do
        if call[1] == 'SetNuiFocus' then
            out[#out + 1] = 'focus(' .. tostring(call[2]) .. ')'
        else
            out[#out + 1] = 'keep(' .. tostring(call[2]) .. ')'
        end
    end
    return table.concat(out, ' ')
end

-- The two candidate semantics
--
-- Each is a tiny model of what CitizenFX might be doing, taken straight from
-- one of the two incompatible comments this code used to carry. Replaying a
-- release sequence through both is how the three-call form is justified.

--- "setKeepInputActive is a no-op until focus has been granted."
--- Clearing keepInput while unfocused does nothing, so an ordering that only
--- clears after the release leaves it on.
local function semanticsNoOpWhileUnfocused(calls)
    local focused, keepInput = true, true
    for _, call in ipairs(calls) do
        if call[1] == 'SetNuiFocus' then
            focused = call[2] == true
        elseif focused then
            keepInput = call[2] == true
        end
    end
    return keepInput
end

--- "a prior setKeepInputActive(true) leaks into the next focus cycle."
--- Read as: the release restores whatever keepInput was in force when focus was
--- granted, so an ordering that clears it before the release has its clear
--- undone.
local function semanticsReleaseRestores(calls)
    local keepInput, atGrant = true, true
    for _, call in ipairs(calls) do
        if call[1] == 'SetNuiFocus' then
            if call[2] == true then atGrant = keepInput else keepInput = atGrant end
        else
            keepInput = call[2] == true
        end
    end
    return keepInput
end

local SEMANTICS = {
    { name = 'no-op-while-unfocused', fn = semanticsNoOpWhileUnfocused },
    { name = 'release-restores', fn = semanticsReleaseRestores },
}

local CANDIDATES = {
    {
        name = 'keepInput then focus (two calls)',
        calls = { { 'SetNuiFocusKeepInput', false }, { 'SetNuiFocus', false, false } },
        safeUnder = { ['no-op-while-unfocused'] = true },
    },
    {
        name = 'focus then keepInput (two calls)',
        calls = { { 'SetNuiFocus', false, false }, { 'SetNuiFocusKeepInput', false } },
        safeUnder = { ['release-restores'] = true },
    },
    {
        name = 'keepInput, focus, keepInput (what the helper emits)',
        calls = {
            { 'SetNuiFocusKeepInput', false },
            { 'SetNuiFocus', false, false },
            { 'SetNuiFocusKeepInput', false },
        },
        safeUnder = { ['no-op-while-unfocused'] = true, ['release-restores'] = true },
    },
}

for _, candidate in ipairs(CANDIDATES) do
    for _, semantics in ipairs(SEMANTICS) do
        local leaked = semantics.fn(candidate.calls)
        local expectedSafe = candidate.safeUnder[semantics.name] == true
        check(
            (not leaked) == expectedSafe,
            ('%s under %s: expected %s, keepInput ended %s'):format(
                candidate.name,
                semantics.name,
                expectedSafe and 'safe' or 'leaking',
                tostring(leaked)
            )
        )
    end
end
print('PASS release ordering: each two-call form leaks under one semantics, the three-call form under neither')

-- The negative control for the table above: a semantics model that nothing can
-- satisfy would make every row vacuously consistent. Assert instead that the
-- two models actually disagree, which is the whole reason there are two.
check(
    semanticsNoOpWhileUnfocused(CANDIDATES[1].calls) ~= semanticsReleaseRestores(CANDIDATES[1].calls),
    'the two semantics models must disagree about the keepInput-first ordering, or neither is testing anything'
)
check(
    semanticsNoOpWhileUnfocused(CANDIDATES[2].calls) ~= semanticsReleaseRestores(CANDIDATES[2].calls),
    'the two semantics models must disagree about the focus-first ordering'
)
print('PASS negative control: the two semantics models genuinely disagree')

-- The helper really emits that sequence

do
    local env = host()
    local platform = load(env)
    platform.releaseCursor()
    check(
        sequence(env) == 'keep(false) focus(false) keep(false)',
        'releaseCursor emits the three-call form, got: ' .. sequence(env)
    )
end

do
    local env = host()
    local platform = load(env)
    platform.setInputMode(0)
    check(
        sequence(env) == 'keep(false) focus(false) keep(false)',
        'setInputMode(0) emits the three-call form, got: ' .. sequence(env)
    )
end

do
    local env = host()
    local platform = load(env)
    platform.setInputMode(1)
    check(sequence(env) == 'focus(true)', 'setInputMode(1) only grants focus, got: ' .. sequence(env))
end

do
    local env = host()
    local platform = load(env)
    platform.releaseCursorSuppressPause()
    check(
        sequence(env) == 'keep(false) focus(false) keep(false)',
        'releaseCursorSuppressPause releases the same way, got: ' .. sequence(env)
    )
    pump(env)
    check((env.disabled or 0) > 0, 'releaseCursorSuppressPause holds the pause menu shut')
end
print('PASS every release path in the platform adapter emits one ordering')

-- The deferred release and its generation guard

do
    local env = host()
    local platform = load(env)
    local session = 7
    platform.releaseCursorDeferred(session, function() return session end)
    -- Nothing may happen in the calling frame: SetNuiFocus from inside a NUI
    -- callback can fail silently, which is why this defers at all.
    check(#env.calls == 0, 'the deferred release does nothing in the calling frame')
    pump(env)
    check(
        sequence(env) == 'keep(false) focus(false) keep(false)',
        'the deferred release emits the same ordering, got: ' .. sequence(env)
    )
end

do
    local env = host()
    local platform = load(env)
    local session = 7
    platform.releaseCursorDeferred(session, function() return session end)
    -- The UI reopened before the thread resumed, so it has already taken focus
    -- synchronously. Releasing now would revoke the NEW session's focus.
    session = 8
    pump(env)
    check(
        #env.calls == 0,
        'a stale deferred release must not touch focus, got: ' .. sequence(env)
    )
    check((env.disabled or 0) == 0, 'a stale deferred release must not suppress the pause menu either')
end

do
    local env = host()
    local platform = load(env)
    -- No generation at all is the right shape for a UI that cannot reopen
    -- within a frame, and must still release.
    platform.releaseCursorDeferred()
    pump(env)
    check(
        sequence(env) == 'keep(false) focus(false) keep(false)',
        'an unguarded deferred release still releases, got: ' .. sequence(env)
    )
end

do
    local env = host()
    local platform = load(env)
    local session = 1
    platform.releaseCursorDeferred(session, function() return session end)
    pump(env, 1)
    local before = env.disabled or 0
    -- Reopening after the release has landed must stop the pause-menu
    -- suppression too, or the new session cannot open the map either.
    session = 2
    pump(env)
    check(
        (env.disabled or 0) - before <= 4,
        'pause suppression stops when the session changes mid-hold'
    )
end
print('PASS the deferred release defers a frame and is guarded by the session generation')

print(('Passed %d NUI focus release checks'):format(checks))
