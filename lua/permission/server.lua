-- tLib/lua/permission/server.lua
-- Server-side admin permission checking.
-- FiveM: uses ACE system. Helix: stubbed until equivalent is known.
--
-- Permission levels:
--   0 = no access
--   1 = admin          (ace: tlib.admin)
--   2 = superadmin     (ace: tlib.superadmin — implies tlib.admin)

Permission = {}

local ACE       = "tlib.admin"
local SUPER_ACE = "tlib.superadmin"

--- Return the numeric permission level for a player (0, 1, or 2).
function Permission.getPlayerLevel(playerId)
    if not _TLIB_IS_FIVEM then return 0 end
    local id = tostring(playerId)
    if IsPlayerAceAllowed(id, SUPER_ACE) then return 2 end
    if IsPlayerAceAllowed(id, ACE)       then return 1 end
    return 0
end

--- Convenience: true if player has at least admin level.
function Permission.isPlayerAdmin(playerId)
    return Permission.getPlayerLevel(playerId) >= 1
end

Platform.AddEventHandler("tLib:requestAdminPermission", function()
    local src = source
    -- Send the numeric level; client handles both number (new) and bool (legacy).
    Platform.TriggerClientEvent("tLib:receiveAdminPermission", src, Permission.getPlayerLevel(src))
end)

--- Register a net event that only fires the handler if the source player
--- has tlib.admin permission. Denied attempts are logged automatically.
--- @param eventName string   The net event name to register
--- @param handler function   function(src, ...) called only for admins
function Permission.registerAdminEvent(eventName, handler)
    RegisterNetEvent(eventName, function(...)
        local src = source
        local ok, isAdm = pcall(Permission.isPlayerAdmin, src)
        if not ok or not isAdm then
            print(("[tLib] %s: player %s denied (no tlib.admin)"):format(eventName, tostring(src)))
            return
        end
        handler(src, ...)
    end)
end

function Permission.registerExports()
    Platform.export('tLib', 'IsPlayerAdmin', function(src)
        return Permission.isPlayerAdmin(src)
    end)
    Platform.export('tLib', 'GetPlayerLevel', function(src)
        return Permission.getPlayerLevel(src)
    end)
    Platform.export('tLib', 'RegisterAdminEvent', function(eventName, handler)
        Permission.registerAdminEvent(eventName, handler)
    end)
end
