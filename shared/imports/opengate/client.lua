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

     What this replaces

    tRadar/client/cl_settings.lua:733-783 and
    tDetector/client/cl_settings.lua:371-415 — the same three reply handlers
    either side of one `TriggerServerEvent`. tAFK has the server half and
    nothing on the client, so `tafk:openSettings` is a dead event and /tafk
    still reads a cached admin flag.

     `reopen()` exists because of a rate-limit trap, and it is the whole
     reason this is a handle and not a free function

    tRadar/client/cl_settings.lua:718-728 documents it: the request path is
    rate-limited to one call per second on the server and drops the extra
    SILENTLY, so an admin who opened the 3D prop editor and cancelled straight
    away would get nothing back. Both tRadar and tDetector therefore expose a
    global that reopens the dialog LOCALLY, bypassing the handshake.

    `reopen()` is that, named, with the knowledge attached instead of left in a
    comment two files away from the call. It re-runs `onOpen` with the payload
    the server last sent and makes no round trip.

    It is safe for the reason tRadar gives and for no other: access was granted
    to open this panel a moment ago, and everything the editor can actually DO
    is re-checked on the server when it is done. It is NOT a way to open the
    panel — there was never a grant to re-use. With no remembered answer it does
    nothing and says so once.

    And the remembered payload is deliberately a remembered one. `isAdmin` in
    it is a draw hint seconds old; it is not, and must never become, the
    authority for anything.

     Every reply is server-only

    All three handlers go through `tlib.net.fromServer`, so a local
    `TriggerEvent` cannot open the panel or fake a denial. That closes a real
    gap: tRadar guards `tradar:openSettings` and `tradar:configBroken` and does
    NOT guard `tradar:accessDenied`, three lines further down the same file.

     `onBroken` is optional, and a missing one is never routed to onDenied

    A resource whose server half passes no `configOk` can never receive the
    broken reply, so requiring a handler for it would be requiring dead code.
    But if the reply does arrive with no handler, this prints a console line
    naming the resource and the missing option rather than falling back to
    `onDenied` — because that fallback is precisely the mistake the two states
    exist to avoid, and it would send the player to the wrong person while
    looking like it worked. §3.9 of the audit wants `configBroken` in four more
    resources; a loud line is what makes its absence findable.
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
    -- Required, unlike onBroken. Every panel can be denied, and a denial the
    -- player is never told about is §2.13's defect: they press the key, nothing
    -- happens, and they report it as broken.
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
