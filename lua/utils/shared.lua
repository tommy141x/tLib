-- tLib/lua/utils/shared.lua
-- General-purpose utilities available on both client and server.
-- Loaded after lua/adapter/core.lua so Platform.export is available.

Utils = {}

local _hexChars = '0123456789abcdef'

--- Generate a random 16-character hex ID suitable for stable entity identifiers.
--- Uses math.random — seed with math.randomseed(GetGameTimer()) if needed.
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
