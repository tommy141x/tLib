--[[
    tLib/shared/imports/opengate — the CLIENT half of "may I open my panel?".

    Usage in a consumer (client scripts):

        local panel = tlib.opengate.panel({
            key      = 'settings',
            onOpen   = function(data) openSettingsDialog(data) end,
            onDenied = function() chatLine("You don't have permission to use this.") end,
            onBroken = function() chatLine("This server's tRadar config has errors…") end,
        })

        RegisterCommand('tradar', function() panel:open() end, false)

        -- and, for a feature that had to close the dialog to use the game view:
        panel:reopen()

    Replaces three near-identical reply handlers in tRadar and tDetector;
    tAFK had only the server half, so its client event is dead and /tafk
    still reads a cached admin flag.

    `reopen()` exists because the server rate-limits `:request` to one call
    per second and drops the extra SILENTLY — an admin who opens then cancels
    a panel fast would otherwise get nothing back. It replays the last
    `onOpen` payload locally with no round trip. Safe only because access was
    granted moments ago and everything the panel can DO is re-checked
    server-side; it is NOT a way to open the panel from nothing, and the
    `isAdmin`-style fields in the remembered payload are draw hints, never an
    authority.

    All three replies go through `tlib.net.fromServer`, so a local
    `TriggerEvent` cannot open the panel or fake a denial.

    `onBroken` is optional — a resource whose server never passes `configOk`
    can never receive it. If a `:broken` reply arrives with no handler, this
    prints a console line instead of silently falling back to `onDenied`:
    "not allowed" and "the config is broken" send the player to different
    people, which is the whole reason the two states exist.
]]

local OpenGate = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

local Panel = {}
Panel.__index = Panel

--- Ask the server whether this panel may open. The answer arrives as one of the
--- three callbacks; nothing happens synchronously.
function Panel:open()
    TriggerServerEvent(self.base .. ':request')
end

--- Re-run `onOpen` locally with the answer the server last sent. No round trip,
--- so it is not subject to the server's rate limit. Read the header before using
--- it for anything other than returning a player to a panel they just left.
--- @return boolean  false when there is no remembered answer to reopen with
function Panel:reopen()
    if not self.granted then
        if not self.warnedReopen then
            self.warnedReopen = true
            print(('^3[%s] tlib.opengate(%q): reopen() with no previous open — ignored. ' ..
                   'It replays a grant; it cannot create one. Call open().^7')
                :format(RESOURCE, self.key))
        end
        return false
    end
    self.onOpen(self.payload)
    return true
end

--- Register the client half of one panel's open handshake.
---
--- @param opts table {
---   key      = 'settings',                  -- must match the server half's key
---   onOpen   = function(payload),           -- REQUIRED
---   onDenied = function(),                  -- REQUIRED; a silent denial is a defect
---   onBroken = function(),                  -- optional; see the header
--- }
--- @return table panel
function OpenGate.panel(opts)
    opts = opts or {}

    local key = opts.key or 'settings'
    assert(type(key) == 'string' and key ~= '',
        'tlib.opengate.panel: key must be a non-empty string')
    assert(type(opts.onOpen) == 'function',
        'tlib.opengate.panel: onOpen must be a function taking (payload)')
    -- Required, unlike onBroken: a silent denial reads as a bug, not nothing
    -- happening.
    assert(type(opts.onDenied) == 'function',
        'tlib.opengate.panel: onDenied must be a function — a silent denial reads as a bug')
    assert(opts.onBroken == nil or type(opts.onBroken) == 'function',
        'tlib.opengate.panel: onBroken must be a function')

    local self = setmetatable({
        key     = key,
        base    = ('%s:tlib:opengate:%s'):format(RESOURCE, key),
        onOpen  = opts.onOpen,
        granted = false,
        payload = nil,
    }, Panel)

    local onBroken = opts.onBroken
    local warnedBroken = false

    tlib.net.fromServer(self.base .. ':open', function(data)
        self.granted, self.payload = true, data
        self.onOpen(data)
    end)

    tlib.net.fromServer(self.base .. ':denied', function()
        opts.onDenied()
    end)

    tlib.net.fromServer(self.base .. ':broken', function()
        if onBroken then return onBroken() end
        if warnedBroken then return end
        warnedBroken = true
        print(('^1[%s] tlib.opengate(%q): the server reported a BROKEN CONFIG and this ' ..
               'panel has no `onBroken` handler, so the player was told nothing. ' ..
               'Deliberately not routed to onDenied: "not allowed" and "the config is ' ..
               'broken" send them to two different people.^7'):format(RESOURCE, key))
    end)

    return self
end

return OpenGate
