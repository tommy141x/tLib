-- Runs in the consumer VM: subscriptions survive a dependency restart, unlike
-- a callback stored only inside that dependency. No permissions or UI ownership.
local Lifecycle = { version = 1 }
function Lifecycle.watch(spec)
    assert(type(spec) == 'table' and type(spec.resource) == 'string' and spec.resource ~= '', 'Lifecycle resource required')
    assert(type(spec.install) == 'function', 'Lifecycle install callback required')
    assert(spec.cleanup == nil or type(spec.cleanup) == 'function', 'Invalid cleanup callback')
    assert(spec.readyEvent == nil or (type(spec.readyEvent) == 'string' and spec.readyEvent ~= ''), 'Invalid readiness event')
    local owner = GetCurrentResourceName()
    assert(spec.resource ~= owner, 'Watch a dependency, not the owning resource')
    local client = not IsDuplicityVersion()
    local startEvent = client and 'onClientResourceStart' or 'onResourceStart'
    local stopEvent = client and 'onClientResourceStop' or 'onResourceStop'
    local generation, installed, busy, disposed = 0, false, false, false
    local steps, subscriptions = {}, {}
    local handle = {}
    local function reset()
        generation, installed, busy, steps = generation + 1, false, false, {}
        if spec.cleanup then
            local ok, err = pcall(spec.cleanup)
            if not ok then print(('[%s] %s cleanup failed: %s'):format(owner, spec.resource, tostring(err))) end
        end
    end
    function handle.dispose()
        if disposed then return end
        disposed = true
        reset()
        for _, subscription in ipairs(subscriptions) do RemoveEventHandler(subscription) end
        subscriptions = {}
    end
    function handle.ready() return installed and not disposed end
    function handle.invalidate()
        if not disposed then reset() end
    end
    function handle.retry()
        if disposed or installed or busy or GetResourceState(spec.resource) ~= 'started' then return end
        busy = true
        local epoch = generation
        CreateThread(function()
            -- Resource-start events can precede callable exports by a scheduler tick.
            Wait(0)
            local failure
            local function active()
                return not disposed and generation == epoch and GetResourceState(spec.resource) == 'started'
            end
            local context = { isActive = active }
            function context.once(name, fn)
                assert(active(), 'Registration lifetime ended')
                assert(type(name) == 'string' and type(fn) == 'function', 'Invalid registration step')
                if steps[name] then return true end
                local ok, err = fn()
                assert(ok == true, err or ('Registration step failed: ' .. name))
                assert(active(), 'Registration lifetime ended')
                steps[name] = true
                return true
            end
            -- Bounded retries, not an idle loop. Completed steps are retained so
            -- a later unavailable export does not duplicate namespace/handler registration.
            for _ = 1, 300 do
                if not active() then return end
                local ok, err = pcall(spec.install, context)
                if not active() then return end
                if ok then installed, busy = true, false; return end
                failure = err
                Wait(100)
            end
            if not active() then return end
            busy = false
            print(('[%s] %s registration failed after 30 seconds: %s'):format(owner, spec.resource, tostring(failure)))
        end)
    end
    subscriptions[#subscriptions + 1] = AddEventHandler(startEvent, function(name)
        if name == spec.resource then handle.retry() end
    end)
    subscriptions[#subscriptions + 1] = AddEventHandler(stopEvent, function(name)
        if name == owner then handle.dispose()
        elseif name == spec.resource then reset() end
    end)
    if spec.readyEvent then
        subscriptions[#subscriptions + 1] = AddEventHandler(spec.readyEvent, function(name)
            if name == spec.resource then handle.retry() end
        end)
    end
    handle.retry()
    return handle
end
return Lifecycle
