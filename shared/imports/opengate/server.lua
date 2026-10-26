--[[
    tLib/shared/imports/opengate — the SERVER half of "may I open my panel?".

    Usage in a consumer (server scripts):

        local gate = tlib.access.gate(Config.access, { key = 'radar' })

        tlib.opengate.serve({
            key      = 'settings',
            allow    = function(src) return gate:allowed(src) end,
            configOk = function() return tradarConfigOk() end,
            payload  = function(src) return { isAdmin = tlib.permission.isAdmin(src) } end,
        })

    Replaces three near-identical handshakes in tRadar, tDetector and tAFK
    (tAFK's client side was never written, so both its events are dead and
    /tafk still reads a client cache). The decision has to be the SERVER's,
    re-resolved every open — a client-cached `exports['tLib']:IsAdmin()` keeps
    drawing the admin section after an ace is revoked, until reconnect.

    Three outcomes, not two: `configOk` is first-class alongside `allow`
    because "not allowed" and "the config is broken" send the player to two
    different people, and collapsing them costs a support round trip. tRadar
    already split them; tDetector and tAFK had no broken state at all.

    Order matters: `configOk` runs before `allow` (a broken config is not a
    permissions problem), and the rate limit runs before both since `allow`
    is the expensive check — on a job-gated server it reaches into the
    framework's core object every call.

    `allow` is REQUIRED, with no default. A missing one denies everyone and
    logs it at boot, because a missing option quietly meaning "open" is how a
    gate meant to restrict something ends up granting it. A panel genuinely
    open to all writes `allow = function() return true end`, mirroring
    `tlib.access`'s own `mode = 'everyone'`.

    `allow` is a hole you put a `tlib.access` gate into; opengate decides
    nothing about permissions itself, only the handshake, the wire names and
    the decision order.

    Wire names are `<resource>:tlib:opengate:<key>:request` / `:open` /
    `:denied` / `:broken`, resource-namespaced because FiveM net event names
    are global — two resources both using key 'settings' would otherwise
    answer each other's clients. Consumers never spell them, which is what
    keeps them renameable.

    The source guard and rate limit come from `tlib.net.fromClient`,
    deliberately without its own `allow` option: folding `configOk` into one
    would collapse the three-way order this exists to keep.
]]

local OpenGate = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

--- Register the server half of one panel's open handshake.
---
--- @param opts table {
---   key        = 'settings',                     -- namespaces the wire events
---   allow      = function(src) -> boolean,       -- REQUIRED
---   configOk   = function() -> boolean | nil,    -- optional; nil means "no spec to check"
---   payload    = function(src) -> table | nil,   -- optional; travels with :open
---   rateLimit  = 1000,                           -- optional ms floor; 0 disables
--- }
function OpenGate.serve(opts)
    opts = opts or {}

    local key = opts.key or 'settings'
    assert(type(key) == 'string' and key ~= '',
        'tlib.opengate.serve: key must be a non-empty string')
    assert(opts.configOk == nil or type(opts.configOk) == 'function',
        'tlib.opengate.serve: configOk must be a function returning a boolean')
    assert(opts.payload == nil or type(opts.payload) == 'function',
        'tlib.opengate.serve: payload must be a function taking (src)')

    local base    = ('%s:tlib:opengate:%s'):format(RESOURCE, key)
    local allow   = opts.allow
    local configOk = opts.configOk
    local payload = opts.payload

    -- Loud rather than fatal: taking the whole resource down over one panel
    -- would be worse than a panel nobody can open, which at least names its
    -- own cause.
    if type(allow) ~= 'function' then
        print(('^1[%s] tlib.opengate.serve(%q): no `allow` function — DENYING EVERYONE. ' ..
               'Pass a tlib.access gate, or `allow = function() return true end` if this ' ..
               'panel is open to all players.^7'):format(RESOURCE, key))
    end

    tlib.net.fromClient(base .. ':request', { rateLimit = opts.rateLimit }, function(src)
        -- Before the access check: a broken config is not a permissions
        -- problem, just the right person to route to.
        if configOk then
            local ok, fine = pcall(configOk)
            -- A configOk that throws is not a working config.
            if not ok or fine ~= true then
                TriggerClientEvent(base .. ':broken', src)
                return
            end
        end

        if type(allow) ~= 'function' then
            TriggerClientEvent(base .. ':denied', src)
            return
        end

        -- pcall'd and failing closed: an uncaught throw here is a console
        -- traceback and a dropped event; denial is the safe outcome.
        local ok, allowed = pcall(allow, src)
        if not ok then
            print(('^1[%s] tlib.opengate(%q): allow errored: %s. Denying.^7')
                :format(RESOURCE, key, tostring(allowed)))
            allowed = false
        end
        if allowed ~= true then
            TriggerClientEvent(base .. ':denied', src)
            return
        end

        local data
        if payload then
            local pok, built = pcall(payload, src)
            -- A throwing payload builder must still open the panel — it's
            -- draw hints, not a grant, and every capability it names is
            -- re-checked server-side.
            if pok then
                data = built
            else
                print(('^1[%s] tlib.opengate(%q): payload errored: %s. Opening without it.^7')
                    :format(RESOURCE, key, tostring(built)))
            end
        end

        TriggerClientEvent(base .. ':open', src, data)
    end)
end

return OpenGate
