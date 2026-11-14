--[[
    tLib — per-player rate limiting for net events (server)

        local gate = tlib.ratelimit.bucket('requestVehicleProps', 1000)
        local join = tlib.ratelimit.tokens('requestAccess', { burst = 15, refillPerSecond = 2 })

        RegisterNetEvent('tdet:requestVehicleProps', function()
            local src = source
            if not src or src <= 0 then return end
            if gate(src) then return end
            ...
        end)

    `bucket` is a floor on the interval: for an event that fires once per boot or
    command press there is no burst to bank. `tokens` is a token bucket, for an
    event that legitimately arrives in bursts (a join, a scan resume) and whose
    sustained rate is what needs bounding. Both answer `true` when the call is
    REFUSED. The `playerDropped` sweep is installed once globally, not per gate,
    so a gate doesn't keep state for every player who ever connected. Names are
    per-resource — this module loads into each consumer's own VM, so names can't
    collide, and also can't be shared, across resources.
]]

local RateLimit = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

local DEFAULT_LOG_WINDOW_MS = 30000

--- name -> { [src] = last call time in ms }
local buckets = {}

--- name -> { [src] = { tokens, at, refused, reportedAt } }
local tokenStates = {}

local sweepInstalled = false

--- Drops one player's state. `playerDropped` already does this; it is exposed
--- for a resource that pools or re-keys player ids.
--- @param src number|string|nil  nil forgets everyone
function RateLimit.forget(src)
    if src == nil then
        for _, b in pairs(buckets) do
            for k in pairs(b) do b[k] = nil end
        end
        for _, b in pairs(tokenStates) do
            for k in pairs(b) do b[k] = nil end
        end
        return
    end
    for _, b in pairs(buckets) do b[src] = nil end
    local key = tonumber(src)
    if key then
        for _, b in pairs(tokenStates) do b[key] = nil end
    end
end

local function installSweep()
    if sweepInstalled then return end
    sweepInstalled = true
    AddEventHandler('playerDropped', function()
        local src = source
        if not src then return end
        RateLimit.forget(src)
    end)
end

--- A named minimum-interval gate: `if gate(src) then return end`.
---
--- The same name returns closures over the SAME timestamps, so two handlers that
--- ask for one thing share one limit. A clock that runs backwards (the 32-bit
--- game timer wrapping) lets the call through and restarts the interval; without
--- that a player connected across the wrap stays refused until the clock catches up.
---
--- @param name string      the bucket's name, unique within this resource
--- @param intervalMs number  minimum milliseconds between one player's calls
--- @return fun(src: number|string): boolean  true when the call is REFUSED
function RateLimit.bucket(name, intervalMs)
    assert(type(name) == 'string' and name ~= '',
        'tlib.ratelimit.bucket: name must be a non-empty string')
    assert(type(intervalMs) == 'number' and intervalMs >= 0,
        'tlib.ratelimit.bucket: intervalMs must be a non-negative number')

    installSweep()

    local b = buckets[name]
    if not b then
        b = {}
        buckets[name] = b
    end

    return function(src)
        if src == nil then return false end
        local now = (GetGameTimer and GetGameTimer()) or 0
        local last = b[src]
        if last and now >= last and (now - last) < intervalMs then return true end
        b[src] = now
        return false
    end
end

--- A token bucket per player, for an event that arrives in bursts.
---
--- A player starts with `burst` tokens; each call spends `cost` (default 1) and
--- tokens return at `refillPerSecond` up to `burst`. `gate(src [, cost])` answers
--- `refused [, retryAfterMs]`. A source that is not a positive number (a
--- server-side emit, nil, a marker) is never limited; a numeric string is its number.
---
--- A refusal is reported once per `logWindowMs` per player with the count since
--- the last report (`0` reports every one); `onRefuse(src, info)` replaces the
--- printed line, `info` being `{ name, refused, retryAfterMs }`. A backwards clock
--- refills nothing and restarts from now. The same name shares one state table;
--- each closure keeps the limits it was made with.
---
--- @param name string
--- @param opts { burst: number, refillPerSecond: number, logWindowMs?: number, onRefuse?: fun(src: number, info: table) }
--- @return fun(src: number|string|nil, cost?: number): boolean, number|nil
function RateLimit.tokens(name, opts)
    assert(type(name) == 'string' and name ~= '',
        'tlib.ratelimit.tokens: name must be a non-empty string')
    assert(type(opts) == 'table', 'tlib.ratelimit.tokens: opts must be a table')
    local burst, refill = opts.burst, opts.refillPerSecond
    assert(type(burst) == 'number' and burst >= 1,
        'tlib.ratelimit.tokens: burst must be a number of at least 1')
    assert(type(refill) == 'number' and refill > 0,
        'tlib.ratelimit.tokens: refillPerSecond must be a positive number')
    local window = opts.logWindowMs
    if window == nil then window = DEFAULT_LOG_WINDOW_MS end
    assert(type(window) == 'number' and window >= 0,
        'tlib.ratelimit.tokens: logWindowMs must be a non-negative number')
    assert(opts.onRefuse == nil or type(opts.onRefuse) == 'function',
        'tlib.ratelimit.tokens: onRefuse must be a function taking (src, info)')
    local onRefuse = opts.onRefuse

    installSweep()

    local states = tokenStates[name]
    if not states then
        states = {}
        tokenStates[name] = states
    end

    return function(src, cost)
        local key = tonumber(src)
        if not key or key <= 0 then return false end
        cost = cost or 1
        if type(cost) ~= 'number' or cost <= 0 or cost > burst then
            error(('tlib.ratelimit.tokens "%s": cost must be above 0 and at most burst (%s)'):format(name, burst), 2)
        end

        local now = (GetGameTimer and GetGameTimer()) or 0
        local state = states[key]
        if not state then
            state = { tokens = burst, at = now, refused = 0 }
            states[key] = state
        else
            local elapsed = (now - state.at) / 1000
            if elapsed > 0 then
                state.tokens = math.min(burst, state.tokens + elapsed * refill)
            end
            state.at = now
        end

        if state.tokens >= cost then
            state.tokens = state.tokens - cost
            return false
        end

        local retryAfterMs = math.ceil((cost - state.tokens) / refill * 1000)
        state.refused = state.refused + 1
        if not state.reportedAt or window == 0 or now < state.reportedAt
            or (now - state.reportedAt) >= window then
            local info = { name = name, refused = state.refused, retryAfterMs = retryAfterMs }
            state.refused = 0
            state.reportedAt = now
            if onRefuse then
                local ok, err = pcall(onRefuse, key, info)
                if not ok then
                    print(('^1[%s] tlib.ratelimit "%s": onRefuse errored: %s^7'):format(RESOURCE, name, tostring(err)))
                end
            else
                print(('^3[%s] %s: rate limit exceeded for player %d (%d refused since the last report)^7')
                    :format(RESOURCE, name, key, info.refused))
            end
        end
        return true, retryAfterMs
    end
end

--- Everything forgotten, including the names. Tests only.
function RateLimit.reset()
    buckets = {}
    tokenStates = {}
end

return RateLimit
