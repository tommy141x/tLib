-- tLib/lua/permission/client.lua
-- Client-side admin permission cache. Populated from server.
--
-- Permission levels (mirrors server):
--   0 = no access
--   1 = admin  (ace: tlib.admin)
--   2 = superadmin (ace: tlib.superadmin)

local permLevel = 0
local isAdmin   = false  -- kept for backward compat: true when permLevel >= 1

Platform.AddEventHandler("tLib:receiveAdminPermission", function(result)
    if type(result) == "number" then
        permLevel = result
    else
        -- Backward compat: old servers sent a boolean
        permLevel = (result == true) and 1 or 0
    end
    isAdmin = permLevel >= 1
end)

-- On FiveM, re-request permission when the resource (re)starts.
-- On Helix, the package init runs at startup so the TriggerServerEvent below suffices.
if _TLIB_IS_FIVEM then
    AddEventHandler("onClientResourceStart", function(resourceName)
        if resourceName == Platform.getPackageName() then
            Platform.TriggerServerEvent("tLib:requestAdminPermission")
        end
    end)
end

Platform.TriggerServerEvent("tLib:requestAdminPermission")

function Permission_IsAdmin()
    return isAdmin
end

function Permission_registerClientExports()
    Platform.export('tLib', 'IsAdmin', function()
        return isAdmin
    end)
    Platform.export('tLib', 'GetPermissionLevel', function()
        return permLevel
    end)
    Platform.export('tLib', 'RefreshAdminPermission', function()
        Platform.TriggerServerEvent("tLib:requestAdminPermission")
    end)
end
