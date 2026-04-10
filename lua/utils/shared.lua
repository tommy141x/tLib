-- tLib/lua/utils/shared.lua
-- General-purpose utilities available on both client and server.
-- Loaded after lua/adapter/core.lua so Platform.export is available.

Utils = {}

local _hexChars = '0123456789abcdef'

-- Seed math.random once at load time so IDs are not identical across VM restarts.
-- Combines os.clock (sub-second precision) with GetGameTimer (if available) for entropy.
math.randomseed(os.clock() * 100000 + (GetGameTimer and GetGameTimer() or os.time()))

--- Generate a random 16-character hex ID suitable for stable entity identifiers.
--- @return string  16-character lowercase hex string
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
