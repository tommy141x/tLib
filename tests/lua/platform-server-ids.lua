-- shared/imports/platform/server.lua: a server id that arrives as a string.
-- GetPlayers answers in strings, and `source <= 0` on a raw one raises in Lua 5.3/5.4.

local peds = { [1] = 101, [2] = 102, [3] = 103 }
local coords = {
    [101] = { x = 0, y = 0, z = 0 },
    [102] = { x = 5, y = 0, z = 0 },
    [103] = { x = 400, y = 0, z = 0 },
}
local names = { [1] = 'Tommy', [2] = 'Astra' }

local env = setmetatable({}, { __index = _G })
env.GetCurrentResourceName = function() return 'tProbe' end
env.IsDuplicityVersion = function() return true end
env.GetGameTimer = function() return 1000 end
env.GetPlayers = function() return { '1', '2', '3' } end
-- A string reaching the native is the failure this file exists for, so the stubs
-- refuse one rather than quietly coercing it and hiding the leak.
env.GetPlayerPed = function(id)
    assert(type(id) == 'number', 'GetPlayerPed was handed a ' .. type(id) .. ', not a number')
    return peds[id]
end
env.GetPlayerName = function(id)
    assert(type(id) == 'number', 'GetPlayerName was handed a ' .. type(id) .. ', not a number')
    return names[id]
end
env.GetEntityCoords = function(ped) return coords[ped] end
env.DoesEntityExist = function() return 1 end
env.AddEventHandler = function() end
-- Only reached from wrapExport, which nothing here calls; callable is enough.
env.exports = function() end

local platform = assert(loadfile('shared/imports/platform/server.lua', 't', env))()

local ok, nearby = pcall(platform.getNearbyPlayers, { x = 0, y = 0, z = 0 }, 10)
assert(ok, 'getNearbyPlayers answers instead of raising on the string ids GetPlayers returns: '
    .. tostring(nearby))
table.sort(nearby)
assert(#nearby == 2 and nearby[1] == 1 and nearby[2] == 2,
    'the players inside the radius are returned and the far one is not, got ' .. #nearby)
assert(type(nearby[1]) == 'number', 'and they are returned as numbers, not the strings they arrived as')

assert(platform.getPlayerPed('2') == peds[2], 'a string server id resolves to that player\'s ped')
assert(platform.getPlayerPed(2) == peds[2], 'and a numeric server id resolves to the same ped')

for _, bad in ipairs({ '0', 0, 'abc', -1 }) do
    local okBad, ped = pcall(platform.getPlayerPed, bad)
    assert(okBad, 'a source that is not a player answers rather than raising: ' .. tostring(bad))
    assert(ped == nil, 'a source that is not a player has no ped: ' .. tostring(bad))
end
local okNil, nilPed = pcall(platform.getPlayerPed, nil)
assert(okNil and nilPed == nil, 'a nil source has no ped and does not raise')

assert(platform.getPlayerName('1') == names[1], 'a string server id resolves to that player\'s name')
assert(platform.getPlayerName('abc') == nil, 'a source that is not a number has no name')

print('PASS platform-server-ids')
