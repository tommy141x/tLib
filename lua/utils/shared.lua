-- tLib/lua/utils/shared.lua
-- loads after adapter/core.lua so Platform.export is available

Utils = {}

local _hexChars = '0123456789abcdef'

-- seed once so generateId doesn't spit out identical IDs across restarts
math.randomseed(os.clock() * 100000 + (GetGameTimer and GetGameTimer() or os.time()))

--- @return string 16-char hex id
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
