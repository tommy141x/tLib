-- shared/imports/permission: the consumer-side admin and permission checks.
--
-- Pinned because four resources hand-rolled these and two of the copies had
-- drifted from tLib's rule: they missed tlib.superadmin, and read a numeric 1
-- from IsPlayerAceAllowed as a denial. Both are asserted below.

local aces = {}      -- [ace] = value IsPlayerAceAllowed returns for player '7'
local hasPermission  -- what exports.tLib:HasPermission does; nil = export missing
local hasPermissionBatch -- ditto HasPermissionBatch; nil models a tLib too old to have it
local singleCalls = 0    -- how many times the single-key export was reached
local batchCalls = 0

IsPlayerAceAllowed = function(id, ace)
    if id ~= '7' then return false end
    return aces[ace] or false
end

exports = setmetatable({}, {
    __index = function(_, name)
        assert(name == 'tLib', 'looked up the wrong resource: ' .. tostring(name))
        if not hasPermission then error('No such export HasPermission in resource tLib') end
        return {
            HasPermission = function(_, src, key)
                singleCalls = singleCalls + 1
                return hasPermission(src, key)
            end,
            -- Absent on a tLib whose VM predates the batch export. Indexing a
            -- missing export RAISES in FiveM, which is the shape hasBatch's
            -- fallback is written against, so model the raise, not a nil return.
            HasPermissionBatch = hasPermissionBatch and function(_, src, keys)
                batchCalls = batchCalls + 1
                return hasPermissionBatch(src, keys)
            end or function() error('No such export HasPermissionBatch in resource tLib') end,
        }
    end,
})

-- level() is computed locally from ACE and never asks tLib, so tLib's own demo
-- override cannot reach it and this module carries its own. Stubbed off for
-- every case below except the demo section at the end.
local demoOn = false
tlib = { demo = { active = function() return demoOn end } }

local permission = dofile('shared/imports/permission/server.lua')

-- level / isAdmin ---------------------------------------------------------------

assert(permission.level(7) == 0 and permission.isAdmin(7) == false, 'no aces => not an admin')

aces = { ['tlib.admin'] = true }
assert(permission.level(7) == 1 and permission.isAdmin(7), 'tlib.admin => level 1')

aces = { ['tlib.superadmin'] = true }
assert(permission.level(7) == 2, 'tlib.superadmin alone => level 2')
assert(permission.isAdmin(7), 'a superadmin is an admin; the old fallbacks said no')

aces = { ['tlib.admin'] = 1 }
assert(permission.isAdmin(7), 'a numeric 1 from the native is a grant, not a denial')

aces = { ['tlib.admin'] = 0 }
assert(not permission.isAdmin(7), 'a numeric 0 is a denial, even though Lua treats 0 as truthy')

aces = { ['tlib.admin'] = true }
assert(permission.isAdmin('7'), 'string server ids work too')
assert(not permission.isAdmin(nil), 'nil source is never an admin')

-- The native throwing must not throw out of the check.
local realAce = IsPlayerAceAllowed
IsPlayerAceAllowed = function() error('native unavailable') end
assert(permission.level(7) == 0, 'a throwing native reads as no permission')
IsPlayerAceAllowed = realAce

-- has ---------------------------------------------------------------------------

hasPermission = function(src, key) return src == 7 and key == 'tRadar.use' end
assert(permission.has(7, 'tRadar.use'), 'has() answers through tLib:HasPermission')
assert(not permission.has(7, 'other.key'), 'and reports its denials')

-- The fail-closed property: tLib unavailable must NOT fall back to ACE, because a
-- resolver registered with tLib outranks ACE and could be denying this key.
aces = { ['tRadar.use'] = true }
hasPermission = nil
assert(not permission.has(7, 'tRadar.use'), 'tLib unreachable => false, even with the ACE granted')

hasPermission = function() return 1 end
assert(not permission.has(7, 'tRadar.use'), 'only a boolean true from tLib is a grant')

assert(not permission.has(7, nil) and not permission.has(7, ''), 'a missing key is never granted')

-- hasBatch ----------------------------------------------------------------------
-- The batch sibling of has(). Its reason to exist is the number of export round
-- trips, so the two properties worth pinning are (a) it really does collapse to
-- one, and (b) when it cannot, it still answers correctly by looping has().

local function count(t) local n = 0; for _ in pairs(t) do n = n + 1 end; return n end

aces = {}
hasPermission = function(src, key) return src == 7 and key == 'a' end
hasPermissionBatch = function(src, keys)
    local out = {}
    for _, key in ipairs(keys) do out[key] = (src == 7 and key == 'a') end
    return out
end

singleCalls, batchCalls = 0, 0
local batch = permission.hasBatch(7, {'a', 'b', 'c'})
assert(batch.a == true and batch.b == false and batch.c == false, 'hasBatch mixes grants and denials')
assert(batchCalls == 1 and singleCalls == 0, 'three keys cost ONE export round trip, not three')

-- Still goes THROUGH tLib. Asserting this is what stops the "optimisation" the
-- header warns about: a local IsPlayerAceAllowed loop would be faster and would
-- grant every key a registered resolver denies.
aces = { a = true, b = true, c = true }
hasPermissionBatch = function() return {} end
assert(count(permission.hasBatch(7, {'a', 'b'})) == 2, 'every requested key gets an entry')
assert(permission.hasBatch(7, {'a'}).a == false, 'tLib answers, not local ACE, even with the ACE granted')
hasPermissionBatch = function() return { a = 1 } end
assert(permission.hasBatch(7, {'a'}).a == false, 'only a boolean true from tLib is a grant')
aces = {}

-- Degradation: a consumer can be NEWER than the tLib beside it. A missing batch
-- export must cost speed, never correctness -- so the answers below are the ones
-- looping has() gives, and they arrive one export call per key.
hasPermission = function(src, key) return src == 7 and key == 'a' end
hasPermissionBatch = nil
singleCalls, batchCalls = 0, 0
local fallback = permission.hasBatch(7, {'a', 'b', 'c'})
assert(fallback.a == true and fallback.b == false and fallback.c == false,
    'a tLib with no batch export still answers correctly, one key at a time')
assert(batchCalls == 0 and singleCalls == 3, 'the fallback is the single-key export, three times')

-- A batch export that exists but answers with something that is not a table is
-- the same situation: unusable, so fall back rather than hand back nils.
hasPermissionBatch = function() return 'nope' end
singleCalls = 0
assert(permission.hasBatch(7, {'a', 'b'}).a == true and singleCalls == 2,
    'a non-table answer falls back to looping has()')

-- Fails closed on the awkward inputs, exactly as has() does.
hasPermissionBatch = function(_, keys)
    local out = {}
    for _, key in ipairs(keys) do out[key] = true end
    return out
end
assert(count(permission.hasBatch(7, nil)) == 0, 'a nil key list is an empty map')
assert(count(permission.hasBatch(7, 'a')) == 0, 'a non-table key list is an empty map')
assert(count(permission.hasBatch(nil, {'a'})) == 0, 'a nil source is an empty map')
local mixed = permission.hasBatch(7, {'a', 7, ''})
assert(count(mixed) == 1 and mixed.a == true, 'non-string and empty keys get no entry, so read back denied')
-- And a duplicate is asked once, which is the whole point of the map shape.
singleCalls, batchCalls = 0, 0
assert(permission.hasBatch(7, {'a', 'a', 'a'}).a == true and batchCalls == 1, 'duplicates do not multiply calls')
hasPermissionBatch = nil
singleCalls = 0
assert(permission.hasBatch(7, {'a', 'a', 'a'}).a == true and singleCalls == 1,
    'nor in the fallback, where each call is a round trip')

-- demo mode ---------------------------------------------------------------------

aces = {}
assert(permission.level(7) == 0, 'no aces, demo off => level 0')
demoOn = true
assert(permission.level(7) == 2, 'demo mode makes every player a superadmin')
assert(permission.isAdmin(7), 'and therefore an admin')
-- Not exempted: a caller with no source still has no source. Every gate in tLib
-- treats nil as "nobody asked", and demo mode is about who may act, not about
-- inventing an actor.
assert(permission.level(nil) == 0, 'demo mode still answers 0 for a nil source')
demoOn = false
assert(permission.level(7) == 0, 'and level drops back the moment demo mode is off')

-- has() deliberately carries NO demo branch: it round-trips to tLib, whose own
-- Platform.hasPermission grants in demo mode. Asserting the absence here is what
-- stops someone "fixing" the asymmetry by adding a second override that would
-- then be impossible to turn off from tLib's side.
demoOn = true
hasPermission = function() return false end
assert(not permission.has(7, 'tRadar.use'),
    'has() does not override locally -- tLib answers, and tLib is where demo mode applies')
demoOn = false

print('permission-consumer: ok')
