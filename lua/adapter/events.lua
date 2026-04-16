-- tLib/lua/adapter/events.lua
-- platform event system abstractions


local log = Logger.create('tLib/adapter/events')

if _TLIB_IS_HELIX then
    -- Helix exposes these as globals; names may vary slightly between versions
    -- so we probe once at load time.
    --
    -- TriggerEvent / AddEventHandler deliberately use the CROSS-PACKAGE API
    -- (TriggerClientEvent / RegisterClientEvent) rather than the local-only
    -- variants (TriggerLocalClientEvent / RegisterLocalClientEvent).
    -- Local events are scoped to a single VM — consumer packages that call
    -- Platform.addEventHandler in their own VM would never receive events fired
    -- via TriggerLocalClientEvent inside tLib's VM.  Cross-package events are
    -- delivered to all VMs that have registered a handler with the same name.
    local _triggerCross = TriggerClientEvent or TriggerEvent or function() end
    local _onCross      = RegisterClientEvent or function() end
    local _triggerSrv   = TriggerServerEvent or function() end
    local _triggerCl    = TriggerClientEvent or function() end

    function Platform.TriggerEvent(name, ...) _triggerCross(name, ...) end

    function Platform.AddEventHandler(name, cb) _onCross(name, cb) end

    -- Helix has no net/local event distinction; AddNetEventHandler is identical.
    function Platform.AddNetEventHandler(name, cb) _onCross(name, cb) end

    function Platform.TriggerServerEvent(name, ...) _triggerSrv(name, ...) end

    function Platform.TriggerClientEvent(name, target, ...) _triggerCl(name, target, ...) end
elseif _TLIB_IS_FIVEM then
    function Platform.TriggerEvent(name, ...)
        TriggerEvent(name, ...)
    end

    function Platform.AddEventHandler(name, cb)
        AddEventHandler(name, cb)
    end

    function Platform.AddNetEventHandler(name, cb)
        RegisterNetEvent(name)
        AddEventHandler(name, cb)
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
    Platform.TriggerServerEvent = Platform._stub('TriggerServerEvent')
    Platform.TriggerClientEvent = Platform._stub('TriggerClientEvent')
end
