-- tLib/lua/adapter/shutdown.lua
-- resource shutdown / cleanup hooks


local log = Logger.create('tLib/adapter/shutdown')

local _shutdownCallbacks = {}

function Platform.onShutdown(cb)
    table.insert(_shutdownCallbacks, cb)
end

local function _runShutdown()
    for _, cb in ipairs(_shutdownCallbacks) do
        local ok, err = pcall(cb)
        if not ok then
            log('onShutdown callback error: ' .. tostring(err), 4)
        end
    end
end

if _TLIB_IS_HELIX then
    -- Chain into any onShutdown that may already be defined by another module.
    local _prev = type(onShutdown) == 'function' and onShutdown or nil
    function onShutdown()
        _runShutdown()
        if _prev then _prev() end
    end
elseif _TLIB_IS_FIVEM then
    if not _TLIB_SHUTDOWN_REGISTERED then
        _TLIB_SHUTDOWN_REGISTERED = true
        local resourceName = GetCurrentResourceName and GetCurrentResourceName() or 'tLib'
        AddEventHandler('onResourceStop', function(res)
            if res == resourceName then
                _runShutdown()
            end
        end)
    end
end
