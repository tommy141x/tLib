-- client-side permission cache, populated from server
-- 0 = none, 1 = admin, 2 = superadmin

local permLevel = 0
local isAdmin   = false  -- kept for backward compat: true when permLevel >= 1

-- Only the server may set this. A client-side TriggerEvent of the same name
-- arrives with a different source; a server-triggered net event is always 65535.
Platform.AddNetEventHandler("tLib:receiveAdminPermission", function(result)
    if source ~= 65535 then return end
    -- A number, and only a number: this file ships in the same resource as the
    -- server half that sends it, so the two cannot disagree about the shape.
    -- Anything else — including a spoofed payload — is level 0.
    permLevel = type(result) == "number" and result or 0
    isAdmin = permLevel >= 1
end)

-- A restart re-runs this file but not the server handshake, so ask again.
AddEventHandler("onClientResourceStart", function(resourceName)
    if resourceName == Platform.getPackageName() then
        Platform.TriggerServerEvent("tLib:requestAdminPermission")
    end
end)

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
