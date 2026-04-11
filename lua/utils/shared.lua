-- loads after adapter/core.lua (needs Platform.export)

Utils = {}

local _hexChars = '0123456789abcdef'

-- no `os` in FiveM sandbox; GetGameTimer is 0 on server boot so mix in resource hash
local _seed = (GetGameTimer and GetGameTimer() or 0) + tonumber(GetHashKey(GetCurrentResourceName())) % 100000
math.randomseed(_seed)

function Utils.generateId()
    local t = {}
    for i = 1, 16 do
        local r = math.random(1, 16)
        t[i] = _hexChars:sub(r, r)
    end
    return table.concat(t)
end

Platform.export('tLib', 'GenerateId', function()
    return Utils.generateId()
end)
