-- Threads and timers.

local log = Logger.create('tLib/adapter/core')

-- createThread hands the body to the scheduler; createThreadNow runs it on the
-- caller's frame and parks it only if it yields. Both give the body a coroutine it
-- may wait inside, so a long-lived loop that opens with a wait cannot tell them
-- apart -- but on a path answering the browser the difference is the whole of the
-- felt latency. Measured in-game at ~48fps, median NUI round trip: inline 6.2ms,
-- CreateThread 25.6ms, CreateThreadNow 13.8ms.
--
-- Use createThreadNow when something is waiting on the result, createThread when
-- the work is a loop or genuinely deferred.
if _TLIB_IS_FIVEM then
    function Platform.createThread(fn)
        Citizen.CreateThread(fn)
    end

    function Platform.createThreadNow(fn)
        Citizen.CreateThreadNow(fn)
    end

    function Platform.wait(ms)
        Citizen.Wait(ms)
    end
else
    Platform.createThread    = Platform._stub('createThread')
    Platform.createThreadNow = Platform._stub('createThreadNow')
    Platform.wait            = Platform._stub('wait')
end

-- Built on Platform.createThread and Platform.wait, so no host branching here.

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
