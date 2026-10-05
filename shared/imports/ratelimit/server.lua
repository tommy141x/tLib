--[[
    tLib — per-player rate limiting for net events (server)

        local gate = tlib.ratelimit.bucket('requestVehicleProps', 1000)

        RegisterNetEvent('tdet:requestVehicleProps', function()
            local src = source
            if not src or src <= 0 then return end
            if gate(src) then return end
            ...
        end)

    ── Why this exists ─────────────────────────────────────────────────────────

    Seven byte-identical copies of the same twelve-line function were in the
    tree: tELS/server/sv_configs.lua, tRadio/server/sv_props.lua,
    tDetector/server/sv_admin.lua and sv_props.lua, tRadar/server/sv_admin.lua
    and sv_props.lua, and tUnit/server/sv_elements.lua. Nothing differed but
    the local's name (`_rateBuckets` in six, `_buckets` in one) and whether the
    `if not b then` was folded onto one line. The interval was 1000 at every
    call site but tELS's two community-config queries.

    ── A floor on the interval, not a token bucket ─────────────────────────────

    Every event this guards is asked once per boot or once per command press, so
    there is no legitimate burst to accommodate and the simplest thing that
    rejects a flood is the right one. A token bucket would let a client bank
    allowance while idle and then spend it all at once, which is precisely the
    shape of the request these events must not serve.

    ── The sweep is the half that gets forgotten ───────────────────────────────

    Without it, every bucket keeps one timestamp per player who has EVER
    connected, for the life of the server. Six of the seven copies remembered
    it; the point of putting it here is that copy number eight cannot forget.

    It is installed ONCE, on first use, rather than per bucket — `playerDropped`
    is a normal event and registering N handlers for it would mean N table
    walks per disconnect for no benefit.

    ── Scope ───────────────────────────────────────────────────────────────────

    Bucket names are per-RESOURCE, not global: this module is loaded into each
    consumer's own server VM, so two resources both naming a bucket
    'requestOpenSettings' cannot collide. That is worth knowing in the other
    direction too — a bucket cannot be shared between resources, and a rate
    limit that needs to be is a different problem than this one.
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
