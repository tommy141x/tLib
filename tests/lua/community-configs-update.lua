-- Run: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/community-configs-update.lua
--
-- The BODY CommunityConfigsUpdate puts on the wire, field by field.
--
-- Why a suite about a table literal: this export shipped sending
-- `{ configJson = ... }` plus whatever optional keys the caller happened to
-- pass, and the Worker's update route reads the body with `readConfigBody` --
-- the SAME reader publish uses, so that the two cannot drift. Its required set
-- is therefore publish's: configType, name, configJson, and key for everything
-- but a pattern. Update had never sent the first two, so it answered
--
--     configType must be led_layout, pattern or vehicle_setup (HTTP 400)
--
-- for every customer, on every press, since it was written. Share worked, which
-- is what made it read as an edit-token problem.
--
-- An update is a REPLACEMENT. `description` and `keyLabel` are columns the
-- Worker writes on every update, so omitting them asks it to blank them -- a
-- failure with no error attached to it. Both are asserted present below.
--
-- These assertions are the contract with internal/tWeb/src/lib/tls-configs/
-- api.ts `readConfigBody`. If a field is added there, it fails here.

local exported, bridgeCalls = {}, {}
local captured = nil

Logger = { create = function() return function() end end }
Platform = { export = function(_, name, cb) exported[name] = cb end }

local nextResult = { ok = true, err = nil }

exports = {
    tLib = {
        ccUpdate = function(_, id, editToken, body, cb)
            bridgeCalls[#bridgeCalls + 1] = { id = id, editToken = editToken, body = body }
            cb(nextResult.ok, nextResult.err)
        end,
        ccPublish = function() end,
        ccWithdraw = function() end,
        ccImport = function() end,
        ccPeek = function() end,
        ccList = function() end,
        ccMatch = function() end,
    },
}

-- The payload is inspected BEFORE encoding. Asserting against a JSON string
-- would be asserting against key order, which Lua does not define.
json = {
    encode = function(t) captured = t; return 'encoded' end,
    decode = function() return {} end,
}

function GetCurrentResourceName() return 'tLib' end
function GetInvokingResource() return 'tLS' end
function GetConvar(_, default) return default end

dofile('server/sv_community_configs.lua')

local checks = 0
local function eq(a, b, why)
    checks = checks + 1
    assert(a == b, (why or 'equal') .. ': got ' .. tostring(a) .. ', expected ' .. tostring(b))
end

local function reset()
    bridgeCalls, captured = {}, nil
    nextResult = { ok = true, err = nil }
end

--- Call the export and hand back what it answered plus what it would have sent.
local function update(opts)
    local got
    exported.CommunityConfigsUpdate(opts, function(ok, err, id)
        got = { ok = ok, err = err, id = id }
    end)
    return got
end

local function valid(overrides)
    local opts = {
        id          = 'cfg_abc',
        editToken   = 'tok_xyz',
        configType  = 'led_layout',
        name        = 'Matrix Charger',
        key         = '18charger21tr',
        configJson  = '{"leds":[]}',
    }
    for k, v in pairs(overrides or {}) do
        if v == '<nil>' then opts[k] = nil else opts[k] = v end
    end
    return opts
end

eq(type(exported.CommunityConfigsUpdate), 'function', 'CommunityConfigsUpdate is exported')

-- -- The whole required set reaches the wire ---------------------------------

reset()
local ok = update(valid())
eq(ok.ok, true, 'a complete update was refused')
eq(#bridgeCalls, 1, 'exactly one bridge call')
eq(bridgeCalls[1].id, 'cfg_abc', 'the id is forwarded unchanged')
eq(bridgeCalls[1].editToken, 'tok_xyz', 'the edit token is forwarded unchanged')
eq(bridgeCalls[1].body, 'encoded', 'the encoded payload is what is sent')

-- THE BUG, asserted directly. `readConfigBody` checks configType FIRST, which
-- is why it is the only one of the three that ever appeared in an error.
eq(captured.configType, 'led_layout', 'configType was not sent -- this is the 400 every customer hit')
eq(captured.name, 'Matrix Charger', 'name was not sent, and the Worker requires it')
eq(captured.configJson, '{"leds":[]}', 'configJson was not sent')
eq(captured.key, '18charger21tr', 'key was not sent, and the Worker requires it for a vehicle-bound type')

-- Replacement, not patch: both columns the Worker writes unconditionally must
-- be present, or the update silently blanks them.
eq(captured.description, '', 'description was omitted, which asks the Worker to blank it')
eq(captured.keyLabel, '18charger21tr', 'keyLabel was omitted, which asks the Worker to blank it')

reset()
update(valid({ description = 'Full lightbar + grille', keyLabel = '2018 Charger' }))
eq(captured.description, 'Full lightbar + grille', 'an explicit description was dropped')
eq(captured.keyLabel, '2018 Charger', 'an explicit keyLabel was dropped')

-- -- A pattern is the one type with no key -----------------------------------
--
-- Same rule as upload. Requiring a key here would make a published pattern
-- uneditable, and sending one would make the row look vehicle-specific to
-- every later query -- the Worker drops it, but the two paths should agree.

reset()
local pat = update(valid({ configType = 'pattern', key = '<nil>' }))
eq(pat.ok, true, 'a pattern update was refused for having no key')
eq(captured.configType, 'pattern', 'the pattern type was not sent')
eq(captured.key, nil, 'a pattern sent a key')
eq(captured.keyLabel, nil, 'a pattern sent a keyLabel')

-- -- Refused here, not by the Worker -----------------------------------------
--
-- Each of these used to reach the API and come back as an opaque 400. The
-- point of the local refusal is that nothing is sent at all.

local function refuses(field, why)
    reset()
    local got = update(valid({ [field] = '<nil>' }))
    eq(got.ok, false, why)
    eq(#bridgeCalls, 0, ('a missing %s still reached the API'):format(field))
end

refuses('id', 'an update with no id was attempted')
refuses('editToken', 'an update with no token was attempted')
refuses('configType', 'an update with no configType was attempted -- the shipped bug')
refuses('name', 'an update with no name was attempted')
refuses('configJson', 'an update with no payload was attempted')
refuses('key', 'a vehicle-bound update with no key was attempted')

reset()
local bad = update('not a table')
eq(bad.ok, false, 'a non-table opts was accepted')
eq(#bridgeCalls, 0, 'a non-table opts reached the API')

-- -- A refusal from the Worker is passed through, not swallowed --------------

reset()
nextResult = { ok = false, err = 'edit token refused' }
local refused = update(valid())
eq(refused.ok, false, 'a refused update reported success')
eq(refused.err, 'edit token refused',
    'the error text was rewritten -- tLS matches on it to forget a dead listing')

reset()
nextResult = { ok = false, err = nil }
local silent = update(valid())
eq(silent.ok, false, 'a bare failure reported success')
eq(silent.err, 'unexpected response', 'a failure with no error text produced a nil error')

print(('community-configs-update: ok (%d checks)'):format(checks))
