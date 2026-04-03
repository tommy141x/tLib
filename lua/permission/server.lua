-- tLib/lua/permission/server.lua
-- Server-side admin permission checking.
-- FiveM: uses ACE system. Helix: stubbed until equivalent is known.

Permission = {}

local ACE = "tlib.admin"

function Permission.isPlayerAdmin(playerId)
    if _TLIB_IS_FIVEM then
        local v = IsPlayerAceAllowed(tostring(playerId), ACE)
        return v == true or v == 1
    else
        -- Helix: no direct ACE equivalent known — stub returns false
        return false
    end
end

Platform.AddEventHandler("tLib:requestAdminPermission", function()
    local src = source
    Platform.TriggerClientEvent("tLib:receiveAdminPermission", src, Permission.isPlayerAdmin(src))
end)

function Permission.registerExports()
    Platform.export('tLib', 'IsPlayerAdmin', function(src)
        return Permission.isPlayerAdmin(src)
    end)
end
