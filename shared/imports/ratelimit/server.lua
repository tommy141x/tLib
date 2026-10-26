--[[
    tLib — per-player rate limiting for net events (server)

        local gate = tlib.ratelimit.bucket('requestVehicleProps', 1000)

        RegisterNetEvent('tdet:requestVehicleProps', function()
            local src = source
            if not src or src <= 0 then return end
            if gate(src) then return end
            ...
        end)

    Replaces seven byte-identical copies (tLS, tRadio, tDetector, tRadar,
    tUnit). A floor on the interval, not a token bucket: every guarded event
    fires once per boot or command press, so there is no burst to bank and
    spend later. The `playerDropped` sweep is installed once globally, not per
    bucket, so a bucket doesn't keep a timestamp for every player who ever
    connected. Bucket names are per-resource — this module loads into each
    consumer's own VM, so names can't collide, and also can't be shared, across
    resources.
]]

local RateLimit = {}

--- name -> { [src] = last call time in ms }
local buckets = {}

local sweepInstalled = false

--- Drops every remembered timestamp for one player.
---
--- Exposed because a resource that pools or re-keys player ids has to be able
--- to say so; ordinary consumers never call it, because `playerDropped` does.
--- @param src number|string|nil  nil forgets everyone
function RateLimit.forget(src)
    if src == nil then
        for _, b in pairs(buckets) do
            for k in pairs(b) do b[k] = nil end
        end
        return
    end
    for _, b in pairs(buckets) do b[src] = nil end
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

--- A named rate-limit gate.
---
--- Returns a FUNCTION rather than a table so the call site reads as the
--- question it is asking:
---
---     if gate(src) then return end
---
--- Calling `bucket` twice with the same name returns two functions over the
--- SAME timestamps, deliberately: two handlers that are two ways of asking for
--- the same thing should share one limit. The interval is whatever the most
--- recent call said, for the same reason — one name, one rule.
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
        if last and (now - last) < intervalMs then return true end
        b[src] = now
        return false
    end
end

--- Everything forgotten, including the bucket names. Tests only: a suite that
--- drove one bucket and then another would otherwise inherit the first one's
--- timestamps.
function RateLimit.reset()
    buckets = {}
end

return RateLimit
