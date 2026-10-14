-- Run: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/community-configs-peek.lua
--
-- The oracle for CommunityConfigsPeek: it hands back the same payload
-- CommunityConfigsImport does, and it does NOT count the read.
--
-- Counting happens in the Worker, so at this layer the whole property reduces to
-- WHICH BRIDGE EXPORT is called. That is what these assert. The two wrappers are
-- deliberately near-identical, which is exactly the shape someone later collapses
-- into one — and collapsing them would make tELS's marketplace tab increment every
-- listing's import counter on hover. `peek must never reach ccImport` below is the
-- line that fails when that happens.
--
-- Also pinned here: the (ok, configJson, err) argument ORDER out of the Lua export,
-- against the (ok, err, value) the bridge uses. tELS calls this export with the
-- former and the asymmetry is intentional, so it needs a test rather than a comment.

local exported, calls = {}, {}

Logger = { create = function() return function() end end }
Platform = { export = function(_, name, cb) exported[name] = cb end }

-- Each bridge stub records that it was reached and answers (ok, err, value).
local nextResult = { ok = true, err = nil, value = '{"leds":[]}' }
local function bridgeStub(name)
    return function(_, id, cb)
        calls[#calls + 1] = { name = name, id = id }
        cb(nextResult.ok, nextResult.err, nextResult.value)
    end
end

exports = {
    tLib = {
        ccPeek = bridgeStub('ccPeek'),
        ccImport = bridgeStub('ccImport'),
        ccPublish = function() end,
        ccList = function() end,
        ccMatch = function() end,
    },
}

json = {
    encode = function() return '{}' end,
    decode = function() return {} end,
}

function GetCurrentResourceName() return 'tLib' end
function GetInvokingResource() return 'tELS' end
function GetConvar(_, default) return default end

dofile('server/sv_community_configs.lua')

local checks = 0
local function eq(a, b, why)
    checks = checks + 1
    assert(a == b, (why or 'equal') .. ': got ' .. tostring(a) .. ', expected ' .. tostring(b))
end

local function reset()
    calls = {}
    nextResult = { ok = true, err = nil, value = '{"leds":[]}' }
end

--- Call an export and capture the (ok, value, err) it answers with.
local function invoke(name, id)
    local got
    exported[name](id, function(ok, configJson, err)
        got = { ok = ok, configJson = configJson, err = err }
    end)
    return got
end

eq(type(exported.CommunityConfigsPeek), 'function', 'CommunityConfigsPeek is exported')
eq(type(exported.CommunityConfigsImport), 'function', 'CommunityConfigsImport still exported')

-- The property this suite exists for
reset()
local peeked = invoke('CommunityConfigsPeek', 'cfg_abc')
eq(#calls, 1, 'peek makes exactly one bridge call')
eq(calls[1].name, 'ccPeek', 'peek must never reach ccImport -- that is the counting route')
eq(calls[1].id, 'cfg_abc', 'the id is forwarded unchanged')

reset()
invoke('CommunityConfigsImport', 'cfg_abc')
eq(calls[1].name, 'ccImport', 'import still counts, so the two are genuinely distinct')

-- The callback contract tELS is already written against
eq(peeked.ok, true, 'peek ok')
eq(peeked.configJson, '{"leds":[]}', 'peek hands back the raw config STRING, arg 2')
eq(peeked.err, nil, 'no error on success')

-- Failure paths, matching Import's
reset()
local badId = invoke('CommunityConfigsPeek', '')
eq(#calls, 0, 'an empty id never reaches the bridge')
eq(badId.ok, false); eq(badId.configJson, nil); eq(badId.err, 'invalid id')

reset()
local badType = invoke('CommunityConfigsPeek', 42)
eq(#calls, 0, 'a non-string id never reaches the bridge')
eq(badType.ok, false); eq(badType.err, 'invalid id')

reset()
nextResult = { ok = false, err = 'http_404', value = nil }
local failed = invoke('CommunityConfigsPeek', 'cfg_missing')
eq(failed.ok, false); eq(failed.configJson, nil); eq(failed.err, 'http_404')

reset()
nextResult = { ok = false, err = nil, value = nil }
local noMsg = invoke('CommunityConfigsPeek', 'cfg_missing')
eq(noMsg.err, 'unexpected response', 'same fallback message as Import')

-- A truthy ok with a non-string payload is still a failure, as in Import.
reset()
nextResult = { ok = true, err = nil, value = 12 }
local badPayload = invoke('CommunityConfigsPeek', 'cfg_abc')
eq(badPayload.ok, false, 'a non-string payload is not a success')

-- An uncallable callback is refused rather than crashing the caller.
reset()
local survived = pcall(function() exported.CommunityConfigsPeek('cfg_abc', 'not a function') end)
eq(survived, true, 'a bad callback does not raise')
eq(#calls, 0, 'and does not reach the bridge')

print(('PASS: community-configs-peek (%d checks)'):format(checks))
