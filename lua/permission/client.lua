-- tLib/lua/permission/client.lua
-- Client-side admin permission cache. Populated from server.

local isAdmin = false

RegisterNetEvent("tLib:receiveAdminPermission", function(result)
    isAdmin = result == true
end)

AddEventHandler("onClientResourceStart", function(resourceName)
    if resourceName == GetCurrentResourceName() then
        TriggerServerEvent("tLib:requestAdminPermission")
    end
end)

TriggerServerEvent("tLib:requestAdminPermission")

function Permission_IsAdmin()
    return isAdmin
end

function Permission_registerClientExports()
    Platform.export('tLib', 'IsAdmin', function()
        return isAdmin
    end)
    Platform.export('tLib', 'RefreshAdminPermission', function()
        TriggerServerEvent("tLib:requestAdminPermission")
    end)
end
