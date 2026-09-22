-- tLib/shared/lib/adapter/events.lua
-- platform event system abstractions


local log = Logger.create('tLib/adapter/events')

if _TLIB_IS_FIVEM then
    function Platform.TriggerEvent(name, ...)
        TriggerEvent(name, ...)
    end

    -- Both return the handler cookie. They used to discard it, which made every
    -- registration permanent for the lifetime of THIS resource -- and tLib
    -- registers handlers on behalf of its consumers, so a consumer restarting
    -- left its old handlers live in here answering with its old state. Anything
    -- registered for someone else has to be removable.
    function Platform.AddEventHandler(name, cb)
        return AddEventHandler(name, cb)
    end

    function Platform.AddNetEventHandler(name, cb)
        RegisterNetEvent(name)
        return AddEventHandler(name, cb)
    end

    function Platform.RemoveEventHandler(handle)
        if handle == nil then return false end
        -- pcall because the native is absent on some builds and a failed
        -- teardown must not take the caller down with it; the disposed flag on
        -- the Discovery side is the belt to this one's braces.
        return (pcall(RemoveEventHandler, handle))
    end

    function Platform.TriggerServerEvent(name, ...)
        TriggerServerEvent(name, ...)
    end

    function Platform.TriggerClientEvent(name, target, ...)
        TriggerClientEvent(name, target, ...)
    end
else
    Platform.TriggerEvent       = Platform._stub('TriggerEvent')
    Platform.AddEventHandler    = Platform._stub('AddEventHandler')
    Platform.AddNetEventHandler = Platform._stub('AddNetEventHandler')
    Platform.RemoveEventHandler = Platform._stub('RemoveEventHandler')
    Platform.TriggerServerEvent = Platform._stub('TriggerServerEvent')
    Platform.TriggerClientEvent = Platform._stub('TriggerClientEvent')
end
