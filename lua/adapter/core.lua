-- tLib/lua/adapter/core.lua
-- core platform abstractions: threads, timers


local log = Logger.create('tLib/adapter/core')

if _TLIB_IS_HELIX then
    function Platform.createThread(fn)
        Timer.CreateThread(fn)
    end

    function Platform.wait(ms)
        Timer.Wait(ms)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.createThread(fn)
        Citizen.CreateThread(fn)
    end

    function Platform.wait(ms)
        Citizen.Wait(ms)
    end
else
    Platform.createThread = Platform._stub('createThread')
    Platform.wait         = Platform._stub('wait')
end

-- Built on top of Platform.createThread / Platform.wait so no further
-- branching is needed here.

local _timerHandles = {}
local _timerNext    = 0

local function _nextHandle()
    _timerNext = _timerNext + 1
    return _timerNext
end

function Platform.setInterval(fn, ms)
    local handle = _nextHandle()
    _timerHandles[handle] = true
    Platform.createThread(function()
        while _timerHandles[handle] do
            Platform.wait(ms)
            if _timerHandles[handle] then
                fn()
            end
        end
    end)
    return handle
end

function Platform.clearInterval(handle)
    _timerHandles[handle] = nil
end

function Platform.setTimeout(fn, ms)
    local handle = _nextHandle()
    _timerHandles[handle] = true
    Platform.createThread(function()
        Platform.wait(ms)
        if _timerHandles[handle] then
            _timerHandles[handle] = nil
            fn()
        end
    end)
    return handle
end

function Platform.clearTimeout(handle)
    _timerHandles[handle] = nil
end

-- On Helix, use native Timer.SetTimeout / Timer.SetInterval instead of the
-- custom createThread+wait approach. Timer.Wait can only be called from inside
-- Timer.CreateThread; using the native timer API avoids that constraint and is
-- the idiomatic Helix pattern shown in the docs.
-- _unwrapValue is available here so shim keys are resolved before scheduling.

-- Map from tLib handle → native Helix timer handle, so Clear* can pass the
-- correct native handle back to the Helix Timer API.
local _nativeTimerHandles = {}

if _TLIB_IS_HELIX then
    function Platform.setInterval(fn, ms)
        local realFn = _unwrapValue(fn)
        local handle = _nextHandle()
        _timerHandles[handle] = true
        local nativeHandle = Timer.SetInterval(function()
            if _timerHandles[handle] then
                realFn()
            else
                Timer.ClearInterval(_nativeTimerHandles[handle] or handle)
                _nativeTimerHandles[handle] = nil
            end
        end, ms)
        _nativeTimerHandles[handle] = nativeHandle
        return handle
    end

    function Platform.clearInterval(handle)
        _timerHandles[handle] = nil
        local native = _nativeTimerHandles[handle]
        _nativeTimerHandles[handle] = nil
        Timer.ClearInterval(native or handle)
    end

    function Platform.setTimeout(fn, ms)
        local realFn = _unwrapValue(fn)
        local handle = _nextHandle()
        _timerHandles[handle] = true
        local nativeHandle = Timer.SetTimeout(function()
            if _timerHandles[handle] then
                _timerHandles[handle] = nil
                _nativeTimerHandles[handle] = nil
                realFn()
            end
        end, ms)
        _nativeTimerHandles[handle] = nativeHandle
        return handle
    end

    function Platform.clearTimeout(handle)
        _timerHandles[handle] = nil
        local native = _nativeTimerHandles[handle]
        _nativeTimerHandles[handle] = nil
        Timer.ClearTimeout(native or handle)
    end
end
