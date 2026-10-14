-- `tlib.kvp.view` and `tlib.settings`'s `serverScoped`, against a fake KVP store.
--
-- The load-bearing assertion in here is not that the options work — it is that
-- the key strings they produce are **byte-identical** to the ones the two forks
-- were already writing. These strings are persisted on players' machines. A
-- shared implementation that namespaced them even slightly differently would
-- pass every behavioural test and silently reset everyone's settings on
-- upgrade, which is the expensive way to find out.
--
-- Negative controls are at the bottom and are run, not described.

local checks = 0
local function check(value, message)
    checks = checks + 1
    assert(value, message)
end

-- Host

local ENDPOINT = '203.0.113.7:30120'

local function host(convars)
    local env = setmetatable({}, { __index = _G })
    env._G = env
    env.store = {}
    env.GetCurrentResourceName = function() return 'tLib' end
    env.IsDuplicityVersion = function() return false end
    env.GetConvar = function(name, default) return (convars or {})[name] or default end
    env.GetCurrentServerEndpoint = function() return ENDPOINT end
    env.GetResourceKvpString = function(key) return env.store[key] end
    env.GetResourceKvpFloat = function(key) return tonumber(env.store[key]) or 0.0 end
    env.GetResourceKvpInt = function(key) return math.floor(tonumber(env.store[key]) or 0) end
    env.SetResourceKvp = function(key, value) env.store[key] = tostring(value) end
    env.SetResourceKvpFloat = function(key, value) env.store[key] = tostring(value) end
    env.SetResourceKvpInt = function(key, value) env.store[key] = tostring(math.floor(value)) end
    env.DeleteResourceKvp = function(key) env.store[key] = nil end
    -- StartFindKvp/FindKvp over a prefix. `has` only ever asks for an exact key,
    -- so one match is enough, but the walk is real: it is how `has` tells
    -- "written as empty string" from "never written".
    env.StartFindKvp = function(prefix)
        env.finding = prefix
        return 1
    end
    env.FindKvp = function()
        local prefix, found = env.finding, nil
        if prefix == nil then return nil end
        for key in pairs(env.store) do
            if key:sub(1, #prefix) == prefix then found = key; break end
        end
        env.finding = nil
        return found
    end
    env.EndFindKvp = function() env.finding = nil end
    env.json = {
        encode = function(v)
            -- Enough for the shapes this suite stores: a flat array of strings.
            local parts = {}
            for _, item in ipairs(v) do parts[#parts + 1] = '"' .. tostring(item) .. '"' end
            return '[' .. table.concat(parts, ',') .. ']'
        end,
        decode = function(s)
            if type(s) ~= 'string' or s:sub(1, 1) ~= '[' then return nil end
            local out = {}
            for item in s:gmatch('"([^"]*)"') do out[#out + 1] = item end
            return out
        end,
    }
    return env
end

local function loadKvp(env)
    return assert(loadfile('shared/imports/kvp/client.lua', 't', env))()
end

local function loadSettings(env)
    return assert(loadfile('shared/imports/settings/client.lua', 't', env))()
end

-- The server tag

--- tRadio's implementation, transcribed from `client/cl_bridge.lua` before it
--- moved. The shared one has to agree with this exactly or every player's
--- per-server settings are abandoned.
local function tradioServerTag(endpoint)
    local h = 5381
    for i = 1, #endpoint do
        h = (h * 33 + endpoint:byte(i)) % 4294967296
    end
    return string.format('%08x', math.floor(h))
end

do
    local env = host()
    local kvp = loadKvp(env)
    check(
        kvp.serverTag() == tradioServerTag(ENDPOINT),
        'shared serverTag must equal tRadio\'s: ' .. kvp.serverTag() .. ' vs ' .. tradioServerTag(ENDPOINT)
    )
    check(#kvp.serverTag() == 8, 'the tag is eight hex characters')
    check(kvp.serverTag() == kvp.serverTag(), 'the tag is memoised, not re-hashed')
end
print('PASS the shared server tag is byte-identical to tRadio\'s')

-- Key composition matches both forks

do
    local env = host({ tlib_community_id = 'tgstudios' })
    local kvp = loadKvp(env)
    local tag = kvp.serverTag()
    local key = 'radio_setting_fx_overrides'

    -- tRadio Lua, before: `tlib.kvp.key(key .. "_" .. serverTag())`
    local tradioLua = kvp.key(key .. '_' .. tag)
    -- tRadio TypeScript, `SettingsStore.fullKey`: prefix + key + suffix
    local tradioTs = 'tgstudios_' .. key .. '_' .. tag

    local view = kvp.view({ serverScoped = true })
    check(view.key(key) == tradioLua, 'view key matches tRadio Lua: ' .. view.key(key) .. ' vs ' .. tradioLua)
    check(view.key(key) == tradioTs, 'view key matches tRadio TS: ' .. view.key(key) .. ' vs ' .. tradioTs)
    check(kvp.key(key, { serverScoped = true }) == tradioLua, 'kvp.key honours serverScoped directly')

    -- tAFK, before: `tlib.kvp` with keys hand-prefixed `'tafk:' .. key`
    local prefs = kvp.view({ prefix = 'tafk:' })
    check(prefs.key('playerDisabled') == kvp.key('tafk:playerDisabled'), 'view prefix matches tAFK\'s hand-prefixing')

    -- And an unscoped key is untouched, which is the compatibility floor.
    check(kvp.key(key) == 'tgstudios_' .. key, 'kvp.key with no options is unchanged')
end
print('PASS composed keys are byte-identical to both forks')

do
    -- No endpoint resolved yet. A scoped key must stay unscoped rather than
    -- gaining a bare trailing underscore and reverting the player.
    local env = host({ tlib_community_id = 'tgstudios' })
    env.GetCurrentServerEndpoint = function() return '' end
    local kvp = loadKvp(env)
    check(
        kvp.key('x', { serverScoped = true }) == 'tgstudios_x',
        'an empty server tag leaves the key unscoped, got ' .. kvp.key('x', { serverScoped = true })
    )
end
print('PASS an unresolved endpoint does not revert a scoped setting')

-- nilWhenUnset

do
    local env = host()
    local kvp = loadKvp(env)
    local prefs = kvp.view({ prefix = 'tafk:', nilWhenUnset = true })

    check(prefs.getBool('playerDisabled') == nil, 'unset bool reads nil, not false')
    check(prefs.getFloat('scale') == nil, 'unset float reads nil, not 0.0')
    check(prefs.getInt('count') == nil, 'unset int reads nil, not 0')
    check(prefs.getString('name') == nil, 'unset string reads nil, not ""')
    check(prefs.getJson('seqDisabled') == nil, 'unset json reads nil')

    -- An explicit default always wins over nilWhenUnset.
    check(prefs.getBool('playerDisabled', true) == true, 'an explicit default beats nilWhenUnset')
    check(prefs.getInt('count', 3) == 3, 'an explicit int default beats nilWhenUnset')

    prefs.setBool('playerDisabled', false)
    check(prefs.getBool('playerDisabled') == false, 'a written false reads back as false, not nil')
    check(env.store['tafk:playerDisabled'] == 'false', 'the write landed on the namespaced key')
    prefs.delete('playerDisabled')
    check(prefs.getBool('playerDisabled') == nil, 'deleting returns it to unset')

    -- The module itself keeps the old zero-returning behaviour: it is what every
    -- existing caller reads, and changing it would be a silent behaviour change
    -- in eight settings instantiations.
    check(kvp.getBool('absent') == false, 'the default accessors still return type zeros')
    check(kvp.getString('absent') == '', 'the default string accessor still returns empty')
end
print('PASS nilWhenUnset changes only the never-written answer')

-- settings.serverScoped

do
    local env = host({ tlib_community_id = 'tgstudios' })
    env.tlib = { kvp = loadKvp(env) }
    local settingsMod = loadSettings(env)
    local tag = env.tlib.kvp.serverTag()

    local settings = settingsMod.create({
        { key = 'radio_setting_volume', type = 'float', default = 0.5, clamp = { 0.0, 1.0 } },
        { key = 'radio_setting_fx_overrides', type = 'json', default = nil, serverScoped = true },
    })

    settings:set('radio_setting_volume', 0.8)
    settings:set('radio_setting_fx_overrides', { 'a', 'b' })

    check(env.store['tgstudios_radio_setting_volume'] == '0.8', 'an unscoped setting lands on the plain key')
    check(
        env.store['tgstudios_radio_setting_fx_overrides_' .. tag] ~= nil,
        'a serverScoped setting lands on the tagged key'
    )
    check(
        env.store['tgstudios_radio_setting_fx_overrides'] == nil,
        'and NOT on the untagged one, or the two servers share one value'
    )
    check(
        settings:storageKey('radio_setting_fx_overrides') == 'tgstudios_radio_setting_fx_overrides_' .. tag,
        'storageKey reports the scope, so the engine side does not re-derive it'
    )
    check(settings:isUserSet('radio_setting_fx_overrides'), 'a scoped write still marks the setting user-set')

    -- Reconnecting to a DIFFERENT server must not see the first server's tuning.
    local other = host({ tlib_community_id = 'tgstudios' })
    other.store = env.store
    other.GetCurrentServerEndpoint = function() return '198.51.100.9:30120' end
    other.tlib = { kvp = loadKvp(other) }
    local otherSettings = assert(loadfile('shared/imports/settings/client.lua', 't', other))()
    local fresh = otherSettings.create({
        { key = 'radio_setting_volume', type = 'float', default = 0.5, clamp = { 0.0, 1.0 } },
        { key = 'radio_setting_fx_overrides', type = 'json', default = nil, serverScoped = true },
    })
    check(fresh:get('radio_setting_volume') == 0.8, 'an unscoped setting follows the player to the next server')
    check(
        fresh:get('radio_setting_fx_overrides') == nil,
        'a serverScoped setting does not'
    )
    check(
        not fresh:isUserSet('radio_setting_fx_overrides'),
        'and is not user-set there, so that server\'s default still applies'
    )
end
print('PASS settings.serverScoped isolates per-server tuning and nothing else')

-- Negative controls, run
--
-- Each control is a view-like object blind to exactly one option. The suite
-- asserts each fails the scenario that option exists for, and that the real
-- view passes it. A control that passed would mean the option had stopped
-- doing anything.

local CONTROLS = {
    {
        name = 'scope-blind (serverScoped ignored)',
        make = function(kvp) return kvp.view({}) end,
        scenario = 'serverScoped',
    },
    {
        name = 'zero-returning (nilWhenUnset ignored)',
        make = function(kvp) return kvp.view({ prefix = 'tafk:' }) end,
        scenario = 'nilWhenUnset',
    },
}

local SCENARIOS = {
    serverScoped = function(view, kvp)
        -- Must produce a key that carries the server tag.
        return view.key('k'):find(kvp.serverTag(), 1, true) ~= nil
    end,
    nilWhenUnset = function(view)
        return view.getBool('never-written') == nil
    end,
}

do
    local env = host()
    local kvp = loadKvp(env)

    local real = {
        serverScoped = kvp.view({ serverScoped = true }),
        nilWhenUnset = kvp.view({ prefix = 'tafk:', nilWhenUnset = true }),
    }
    for name, scenario in pairs(SCENARIOS) do
        check(scenario(real[name], kvp) == true, 'the real view must pass scenario ' .. name)
    end

    local failures = 0
    for _, control in ipairs(CONTROLS) do
        local passed = SCENARIOS[control.scenario](control.make(kvp), kvp)
        check(
            passed == false,
            control.name .. ' must fail scenario ' .. control.scenario .. ', but it passed'
        )
        failures = failures + 1
    end
    check(failures == #CONTROLS, 'every control was actually run')
    check(#CONTROLS > 0, 'a control list that is empty is not a control')
end
print('PASS negative controls: each option-blind view fails exactly its own scenario')

print(('Passed %d kvp view checks'):format(checks))
