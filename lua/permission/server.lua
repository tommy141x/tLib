-- tLib/lua/permission/server.lua
-- Server-side admin permission checking via FiveM ACE system.

Permission = {}

local ACE = "tlib.admin"

function Permission.isPlayerAdmin(playerId)
    local v = IsPlayerAceAllowed(tostring(playerId), ACE)
    return v == true or v == 1
end

-- Client requests their permission status
RegisterNetEvent("tLib:requestAdminPermission", function()
    local src = source
    TriggerClientEvent("tLib:receiveAdminPermission", src, Permission.isPlayerAdmin(src))
end)

function Permission.registerExports()
    Platform.export('tLib', 'IsPlayerAdmin', function(src)
        return Permission.isPlayerAdmin(src)
    end)
end
