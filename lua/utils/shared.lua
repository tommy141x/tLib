-- loads after adapter/core.lua (needs Platform.export)

Utils = {}

local _hexChars = '0123456789abcdef'

-- GetGameTimer is ~0 on server boot so mix in resource hash and os timing when available.
-- os.time/os.clock exist server-side but not in the FiveM client sandbox.
local _seed = (GetGameTimer and GetGameTimer() or 0)
    + tonumber(GetHashKey(GetCurrentResourceName())) % 100000
    + (os and os.time and os.time() or 0)
    + math.floor((os and os.clock and os.clock() or 0) * 1000)
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

local _warnedOnce = {}
local _warnLog = Logger.create('tLib/utils')

function Utils.warnOnce(key, msg)
    if not _warnedOnce[key] then
        _warnedOnce[key] = true
        _warnLog(msg, 3)
    end
end
