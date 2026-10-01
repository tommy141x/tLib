-- FiveM adapter contract and manifest-loading regression, with no game required.
local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end
local function run(path, env)
    return assert(loadfile(path, 't', env))()
end
local function host(side)
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.handlers, env.exported, env.threads, env.commands = {}, {}, {}, {}
    env.Citizen = {
        CreateThread = function(fn) env.threads[#env.threads + 1] = coroutine.create(fn) end,
        CreateThreadNow = function(fn) env.immediate = true; fn() end,
        Wait = function(ms) return coroutine.yield(ms) end,
    }
    env.GetCurrentResourceName = function() return 'tLib' end
    env.IsDuplicityVersion = function() return side == 'server' end
    env.GetGameTimer = function() return 4321 end
    env.GetInvokingResource = function() return 'consumer' end
    env.AddEventHandler = function(name, fn)
        env.handlers[name] = env.handlers[name] or {}
        table.insert(env.handlers[name], fn)
    end
    env.emit = function(name, ...)
        for _, fn in ipairs(env.handlers[name] or {}) do fn(...) end
    end
    env.RegisterNetEvent = function(name) env.netEvent = name end
    env.TriggerEvent = function(...) env.event = table.pack(...) end
    env.TriggerServerEvent = env.TriggerEvent
    env.TriggerClientEvent = env.TriggerEvent
    env.RegisterCommand = function(name, fn) env.commands[name] = fn end
    env.RegisterKeyMapping = function(...) env.mapping = table.pack(...) end
    env.exports = function(name, fn) env.exported[name] = fn end
    env.RegisterNuiCallbackType = function(name) env.nuiType = name end
    env.SendNUIMessage = function(msg) env.message = msg end
    env.SetNuiFocus = function(a, b) env.focus = {a, b} end
    env.SetNuiFocusKeepInput = function(a) env.keepInput = a end
    env.Logger = { create = function() return function() end end }
    env.Utils = { warnOnce = function() end }
    env.PerformHttpRequest = function(...) env.http = table.pack(...) end
    env.IsPlayerAceAllowed = function() return env.ace end
    env.PlayerPedId = function() return 11 end
    env.GetEntityCoords = function() return { x = 1, y = 2, z = 3 } end
    env.IsPedInAnyVehicle = function() return env.inVehicle end
    env.GetVehiclePedIsIn = function() return 22 end
    env.GetVehicleNumberPlateText = function() return '  TEST  ' end
    env.GetEntitySpeed = function() return 15 end
    env.VehToNet = function() return 99 end
    env.PlayerId = function() return 5 end
    env.GetPlayerServerId = function() return 42 end
    env.GetPlayerName = function() return 'Tester' end
    env.GetPlayerPed = function(id) if id == 99 then error('disconnected') end; return 11 end
    env.GetPlayers = function() return { '42' } end
    env.LoadResourceFile = function(resource, path)
        check(resource == 'tLib', 'platform import uses tLib resource')
        -- loadfile is provided by the CLI; string.dump avoids relying on io.open,
        -- which the fengari runtime does not implement.
        return string.dump(assert(loadfile(path)))
    end
    env.load = function(src, name) return load(src, name, 'bt', env) end
    return env
end

-- Execute the adapter entries in the real manifest order, on both sides. Missing
-- files or wrong shared/client/server placement must fail instead of being skipped.
local manifest = {}
local meta = setmetatable({
    shared_scripts = function(paths) manifest.shared = paths end,
    client_scripts = function(paths) manifest.client = paths end,
    server_scripts = function(paths) manifest.server = paths end,
}, { __index = function() return function() end end })
run('fxmanifest.lua', meta)
for _, side in ipairs({'client', 'server'}) do
    local env = host(side)
    local loaded = {}
    for _, group in ipairs({manifest.shared, manifest[side]}) do
        for _, path in ipairs(group) do
            -- The adapter spans VMs, so it appears under three prefixes:
            -- shared/lib/adapter/, client/lib/adapter/ and server/lib/adapter/.
            -- Matching only one of them silently drops that side's entries and
            -- the contract below then fails on a nil the suite should have
            -- loaded -- which is exactly how this read after the move.
            if path:match('^%a+/lib/adapter/') then
                check(not path:match('helix') and not path:match('polyfill'), 'manifest excludes removed adapter')
                run(path, env)
                loaded[path] = true
            end
        end
    end
    local p = env.Platform
    check(p.name == 'fivem' and p.isFiveM(), 'FiveM identity')
    check(p.context().side == side and p.context().package == 'tLib', 'context follows host')
    check(p.context() == p.context(), 'context is cached')
    check(p.now() == 4321 and p.getInvokingResource() == 'consumer', 'clock and caller identity')
    check(not pcall(p._stub('missing')), 'unsupported capability raises an error')
    local fn = function() return 7 end
    p.export('tLib', 'Probe', fn)
    check(env.exported.Probe == fn and p.storeCallback(fn) == fn, 'native funcref identity is preserved')
    check(p.releaseCallback == nil and env._unwrapValue == nil, 'no callback-key shim APIs')

    p.createThreadNow(function() env.ranNow = true end)
    check(env.immediate and env.ranNow, 'immediate scheduler remains immediate')
    local fired = 0
    local handle = p.setTimeout(function() fired = fired + 1 end, 20)
    local timer = env.threads[#env.threads]
    local ok, delay = coroutine.resume(timer)
    check(ok and delay == 20 and fired == 0, 'timeout waits before firing')
    p.clearTimeout(handle)
    check(coroutine.resume(timer) and fired == 0, 'cancelled timeout never fires')
    p.setTimeout(function() fired = fired + 1 end, 30)
    timer = env.threads[#env.threads]
    coroutine.resume(timer); coroutine.resume(timer)
    check(fired == 1 and coroutine.status(timer) == 'dead', 'timeout fires exactly once')
    local interval = p.setInterval(function() fired = fired + 1 end, 10)
    timer = env.threads[#env.threads]
    coroutine.resume(timer); coroutine.resume(timer)
    check(fired == 2, 'interval fires after wait')
    p.clearInterval(interval); coroutine.resume(timer)
    check(fired == 2 and coroutine.status(timer) == 'dead', 'interval cancellation releases coroutine')

    local eventValue
    p.AddNetEventHandler('probe:net', function(v) eventValue = v end)
    env.emit('probe:net', 17)
    check(env.netEvent == 'probe:net' and eventValue == 17, 'net registration and event payload')
    p.TriggerClientEvent('probe:client', 4, 'value')
    check(env.event[2] == 4 and env.event[3] == 'value', 'targeted event argument order')
    local stopped, shutdown = {}, 0
    p.onResourceStop(function() error('isolated failure') end)
    p.onResourceStop(function(name) stopped[#stopped + 1] = name end)
    p.onShutdown(function() shutdown = shutdown + 1 end)
    env.emit('onResourceStop', 'consumer')
    check(stopped[1] == 'consumer' and shutdown == 0, 'consumer cleanup does not shut down tLib')
    env.emit('onResourceStop', 'tLib')
    check(stopped[2] == 'tLib' and shutdown == 1, 'own shutdown runs with lifecycle cleanup')

    if side == 'server' then
        check(env.nuiType == nil and not loaded['client/lib/adapter/player.lua'], 'server avoids client native loading')
        local dropped
        p.onPlayerDropped(function(id) dropped = id end)
        env.source = 42; env.emit('playerDropped')
        check(dropped == 42, 'disconnect uses event source')
        local commands = 0
        p.registerCommand('probe', function() commands = commands + 1 end, true)
        env.commands.probe(7, {}); env.commands.probe(0, {})
        check(commands == 1, 'restricted command only accepts console')
        for _, value in ipairs({true, false, 1, 0}) do
            env.ace = value
            check(p.hasPermission(42, 'probe') == (value == true or value == 1), 'ACE BOOL normalization')
        end

        -- hasPermissionBatch: ONE call for a key list, so a consumer asking 40+
        -- keys pays one reference call instead of 40+. Checked here, against the
        -- real adapter, because its whole contract is "the same answer per key as
        -- hasPermission" -- the two share one decision helper precisely so they
        -- cannot drift, and these are what notice if someone splits them again.
        local aceByKey = function(_, key)
            if key == 'yes' then return true end
            if key == 'one' then return 1 end     -- legal BOOL marshalling of true
            if key == 'zero' then return 0 end    -- ... and of false, which Lua calls truthy
            return false
        end
        env.IsPlayerAceAllowed = aceByKey
        local batch = p.hasPermissionBatch(42, {'yes', 'no', 'one', 'zero'})
        check(batch.yes == true and batch.no == false, 'batch returns grants and denials in one map')
        check(batch.one == true and batch.zero == false, 'batch keeps the 1/0 BOOL normalization')
        for _, key in ipairs({'yes', 'no', 'one', 'zero'}) do
            check(batch[key] == p.hasPermission(42, key), 'batch agrees with hasPermission for ' .. key)
        end
        local aceCalls = 0
        env.IsPlayerAceAllowed = function(...) aceCalls = aceCalls + 1; return aceByKey(...) end
        p.hasPermissionBatch(42, {'yes', 'yes', 'yes'})
        check(aceCalls == 1, 'a duplicated key is decided once')
        local function count(t) local n = 0; for _ in pairs(t) do n = n + 1 end; return n end
        check(count(p.hasPermissionBatch(42, nil)) == 0, 'a nil key list is an empty map')
        check(count(p.hasPermissionBatch(42, 'yes')) == 0, 'a non-table key list is an empty map')
        check(count(p.hasPermissionBatch(nil, {'yes'})) == 0, 'no source is an empty map')
        -- Fails closed the same way the single-key guard does: a non-string or
        -- empty key has nothing to file an answer under, so it gets no entry and
        -- reads back as nil -- never as a grant.
        local mixed = p.hasPermissionBatch(42, {'yes', 7, '', false})
        check(count(mixed) == 1 and mixed.yes == true, 'non-string and empty keys are dropped, not granted')
        env.IsPlayerAceAllowed = function() return env.ace end

        p.registerPermissionResolver(function() error('failure') end)
        check(not p.hasPermission(42, 'probe'), 'resolver exception fails closed')
        p.registerPermissionResolver(function() return true end)
        check(p.hasPermission(42, 'probe'), 'framework resolver preserved')

        -- A resolver outranks ACE in the batch path too, and an exception for ONE
        -- key must deny that key without abandoning the rest of the list. The
        -- `~= nil` check is the load-bearing one: an aborted batch would leave
        -- 'nope' nil, which is falsy, so the denial assertion above it would pass
        -- while the whole tail of the list went unanswered.
        env.ace = true
        p.registerPermissionResolver(function(_, key)
            if key == 'boom' then error('resolver failure for one key') end
            return key == 'ok'
        end)
        local viaResolver = p.hasPermissionBatch(42, {'ok', 'boom', 'nope'})
        check(viaResolver.ok == true, 'batch routes through the resolver')
        check(viaResolver.nope == false, 'and the resolver, not ACE, decides -- ACE grants everything here')
        check(viaResolver.boom == false, 'a resolver error denies only its own key')
        check(viaResolver.nope ~= nil, 'a resolver error does not abort the remaining keys')

        -- Demo mode short-circuits ahead of the resolver in both forms. The
        -- resolver still registered above denies 'nope'.
        env.Demo = { active = function() return true end }
        check(p.hasPermissionBatch(42, {'nope'}).nope == true and p.hasPermission(42, 'nope'),
            'demo mode grants every key, batch and single alike')
        env.Demo = nil
        check(p.hasPermissionBatch(42, {'nope'}).nope == false, 'and stops granting when demo mode is off')
        p.Fetch({url = 'https://example.invalid'}, fn)
        check(env.http[2] == fn and env.http[3] == 'GET' and env.http[6].followLocation, 'HTTP native contract')
    else
        check(env.nuiType == '__tlib_nui_ready', 'client installs NUI handshake')
        local ui = p.createUI('test', 'client/ui/index.html')
        p.sendUIEvent(ui, 'probe', {value = 2})
        check(env.message == nil and not p.isNUIReady(), 'messages buffer until browser ready')
        env.emit('__cfx_nui:__tlib_nui_ready', {}, function(reply) check(reply.ok, 'ready reply') end)
        check(p.isNUIReady() and env.message.name == 'probe', 'ready flushes outbound messages')
        p.setInputMode(ui, 1); p.setKeepInputActive(ui, true)
        check(env.focus[1] and env.keepInput and p.getInputMode() == 1, 'focus/input preserved')
        p.setInputMode(ui, 0)
        check(not env.focus[1] and not env.keepInput and p.getInputMode() == 0, 'focus release clears keep-input')
        local pressed, released = 0, 0
        p.bindKey('Enter', {press = function() pressed = pressed + 1 end, release = function() released = released + 1 end})
        env.commands['+tLib_key_Enter'](); env.commands['-tLib_key_Enter']()
        check(pressed == 1 and released == 1 and env.mapping[4] == 'RETURN', 'key aliases and release mapping preserved')
        env.inVehicle = true
        check(p.getPlayerVehicle() == 22 and p.getVehicleNetId(22) == 99, 'vehicle native handles preserved')
        check(p.getVehiclePlate(22) == 'TEST' and p.getVehicleSpeed(22) == 15, 'vehicle plate and speed preserved')
        check(p.getPlayerCoords().z == 3 and p.getPlayerPed() == 11, 'world/ped adapter preserved')
    end
    local imported = run('shared/imports/platform/' .. side .. '.lua', env)
    check(imported._engine == 'fivem', 'consumer import selects FiveM')
    if side == 'client' then
        check(imported.getMyId() == 42 and imported.getMyName() == 'Tester', 'consumer identity natives')
    else
        check(imported.isServer() and imported.now() == 4321, 'consumer server runtime')
        check(imported.getPlayerPed(99) == nil, 'disconnected player remains nil-safe')
    end
end

-- Real unsupported hosts fail before loading a missing adapter or installing
-- misleading no-op methods, even when they expose former platform globals.
local unsupported = setmetatable({WebUI = function() end, Input = {}, Timer = {}}, {__index = _G})
for _, path in ipairs({'shared/lib/adapter/init.lua', 'shared/imports/platform/client.lua', 'shared/imports/platform/server.lua'}) do
    local ok, err = pcall(run, path, unsupported)
    check(not ok and tostring(err):find('Unsupported runtime', 1, true), 'unsupported runtime rejected: ' .. path)
end
print(('PASS: %d FiveM adapter and manifest-loading checks'):format(checks))
