-- tLib/lua/permission/client.lua
-- Client-side admin permission cache. Populated from server.

local isAdmin = false

Platform.AddEventHandler("tLib:receiveAdminPermission", function(result)
    isAdmin = result == true
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
    Platform.export('tLib', 'RefreshAdminPermission', function()
        Platform.TriggerServerEvent("tLib:requestAdminPermission")
    end)
end
