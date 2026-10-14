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

     What this replaces

    The `requestOpenSettings` -> `openSettings` / `accessDenied` handshake, in
    three near-identical implementations: tRadar/server/sv_admin.lua:141-161,
    tDetector/server/sv_admin.lua:285-296, and a half-built one in
    tAFK/server/sv_admin.lua:70-82 whose client side was never written at all,
    so both of its events are dead and /tafk still reads a client cache.

    It exists because the decision has to be the SERVER's, re-resolved on every
    open. Asking the client whether it may open its own settings is asking the
    wrong machine, and a client-side `exports['tLib']:IsAdmin()` is a value
    cached once at resource start — revoke an ace on a running server and the
    panel keeps drawing the admin section until the player reconnects.

     Three outcomes, not two. tRadar is the one that had this right

    "You are not allowed" and "this server's config has errors" send the player
    to two different people: one to the server's admin to be granted something,
    one to the server's admin to go and read their console. Collapsing them
    costs a support round trip every time. tRadar split them; tDetector and tAFK
    have no broken state at all, and §3.9 of the audit wants it in four more
    resources. So `configOk` is a first-class option here rather than something
    each adopter re-derives.

     ORDER MATTERS, and it is the order tRadar documents: the config check
    runs BEFORE the access check. A broken config is not a permissions problem,
    and telling the player it is sends them to the wrong person. The rate limit
    runs before both, because the access check is the expensive one — on a
    job-gated server it reaches into the framework's core object for every call.

     `allow` is required, and "everyone" has to be written down

    There is no default. A missing `allow` denies everyone and says so at boot,
    because the alternative — a missing option quietly meaning "open" — is how a
    gate meant to restrict something ends up granting it. A panel that genuinely
    opens for everybody writes `allow = function() return true end`, which is
    greppable and mirrors `tlib.access`'s own `mode = 'everyone'`.

    tAFK's case is exactly that one: its panel always opens and the only thing
    the reply carries is whether the admin fields belong on it. That belongs in
    `payload`, not in `allow`.

     This is not a second access mechanism

    `allow` is a hole you put a `tlib.access` gate into, as above. opengate
    decides nothing about permissions itself; it owns the handshake, the wire
    names and the decision ORDER, and nothing else.

     The wire names belong to tLib

    `<resource>:tlib:opengate:<key>:request` / `:open` / `:denied` / `:broken`,
    namespaced by resource for the reason `tlib.access` gives: FiveM net event
    names are global, so two resources both using key 'settings' would otherwise
    answer each other's clients. Consumers never spell them — which is what
    makes them renameable later, the same lesson `tLib:receiveAdminPermission`
    is currently teaching the hard way.

    The source guard and the rate limit come from `tlib.net.fromClient`.
    Deliberately WITHOUT its `allow` option: the decision here is three-way and
    ordered, and folding `configOk` into an `allow` would be exactly the
    conflation the order exists to prevent.
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

    -- Printed once, at boot, and the gate then denies everyone. Loud rather
    -- than fatal: refusing to load the file would take the whole resource down
    -- over a panel, and a panel nobody can open is a visible, reportable
    -- symptom that names its own cause.
    if type(allow) ~= 'function' then
        print(('^1[%s] tlib.opengate.serve(%q): no `allow` function — DENYING EVERYONE. ' ..
               'Pass a tlib.access gate, or `allow = function() return true end` if this ' ..
               'panel is open to all players.^7'):format(RESOURCE, key))
    end

    tlib.net.fromClient(base .. ':request', { rateLimit = opts.rateLimit }, function(src)
        -- Before the access check: a broken config is not a permissions
        -- problem. The detail was printed at boot by the resource's config
        -- spec; this only routes the player to the right person.
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

        -- pcall'd and failing closed, for the reason tAFK's own handler gives:
        -- an export that throws inside a net handler is a console traceback and
        -- a dropped event, and a denial is the safe way for that to land.
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
            -- A payload builder that throws must still open the panel: the
            -- payload is draw hints, and losing them is a worse panel, not a
            -- denial. Every capability it names is re-checked server-side.
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
