--[[
    tLib/server/sv_demo.lua — the authority for demo mode.

    The rule itself, and the reasoning behind it, live in
    shared/imports/demo/shared.lua, which every consumer loads as `tlib.demo`.
    This file is the half that can only exist in tLib's own VM:

      * the console banner, because somebody has to say it once per boot;
      * the `tlib_demo` command, so a running server can be flipped;
      * the push to clients and to other resources' server VMs, so a flip is
        seen everywhere without each resource polling a convar.

    Loaded before sv_permission.lua and sv_marketplace.lua: both consult `Demo`.
]]

-- The same file consumers get as `tlib.demo`. Loaded rather than reimplemented so
-- the truthy-convar rule has exactly one definition -- an owner who writes
-- `setr tlib_demo true` must not get a live server here and a demo server there.
-- Same pattern as sv_main.lua's versioncheck load.
Demo = load(
    LoadResourceFile(GetCurrentResourceName(), 'shared/imports/demo/shared.lua'),
    '@@tLib/shared/imports/demo/shared.lua'
)()

local CHANGED = 'tlib:demo:changed'
local REQUEST = 'tlib:demo:request'

-- ── Saying so ───────────────────────────────────────────────────────────────

local BANNER = {
    '^1╔═══════════════════════════════════════════════════════════════════╗^7',
    '^1║  tLib DEMO MODE IS ON  (tlib_demo)                                ║^7',
    '^1║                                                                   ║^7',
    '^1║  • EVERY player is a superadmin. Every access gate says yes.      ║^7',
    '^1║  • No resource writes its data file. All changes die on restart.  ║^7',
    '^1║  • Marketplace installs are swept off disk on the next start.     ║^7',
    '^1║                                                                   ║^7',
    '^1║  This is a showroom switch, not a setting. If this is a real      ║^7',
    '^1║  server, remove tlib_demo from server.cfg and restart NOW.        ║^7',
    '^1╚═══════════════════════════════════════════════════════════════════╝^7',
}

local function announce()
    for _, line in ipairs(BANNER) do print(line) end
end

-- Repeated on a timer as well as at boot. A banner that scrolls past once during
-- a noisy start is a banner nobody read, and the failure this guards against --
-- a production server left in demo mode -- is total and silent from the console's
-- point of view, because everything appears to work.
CreateThread(function()
    Wait(5000)
    while true do
        if Demo.active() then announce() end
        Wait(30 * 60 * 1000)
    end
end)

-- ── Broadcasting ────────────────────────────────────────────────────────────

--- Tell every VM that can care. Server-side `TriggerEvent` reaches every other
--- resource's server VM, which is how a consumer's `tlib.demo` copy learns about
--- a runtime flip; clients get the same event over the net.
local function publish()
    local value = Demo.active()
    TriggerEvent(CHANGED, value)
    TriggerClientEvent(CHANGED, -1, value)
    return value
end

-- A client asks on load. Its own convar read only works when the owner used
-- `setr`, and requiring `setr` for correctness would make the most common
-- spelling of the convar quietly wrong on the client only.
RegisterNetEvent(REQUEST, function()
    local src = source
    if not src then return end
    TriggerClientEvent(CHANGED, src, Demo.active())
end)

AddEventHandler('playerJoining', function()
    local src = source
    if src then TriggerClientEvent(CHANGED, src, Demo.active()) end
end)

-- A resource that starts later has a fresh `tlib.demo` holding its own convar
-- read. That is already right unless an operator has overridden it at runtime,
-- so re-publish and let the override win.
AddEventHandler('onResourceStart', function(resource)
    if resource == GetCurrentResourceName() then return end
    if Demo.active() then TriggerEvent(CHANGED, Demo.active()) end
end)

CreateThread(function()
    Wait(0)
    if Demo.active() then announce() end
    publish()
end)

-- ── The runtime toggle ──────────────────────────────────────────────────────

-- Restricted: console and `tlib.admin` only. Note that in demo mode everyone
-- holds `tlib.admin`, so an in-game player on a demo server can turn demo mode
-- OFF but never on -- which is the safe direction for the accident to run in.
RegisterCommand('tlib_demo', function(src, args)
    local reply = function(msg)
        if src == 0 then print(msg) else TriggerClientEvent('chat:addMessage', src, { args = { 'tLib', msg } }) end
    end
    local arg = (args[1] or ''):lower()

    if arg == 'on' then
        Demo.set(true)
    elseif arg == 'off' then
        Demo.set(false)
    elseif arg == 'convar' or arg == 'reset' then
        Demo.set(nil)
    elseif arg ~= '' then
        reply('^1usage: tlib_demo [on|off|convar]^7')
        return
    end

    local value = publish()
    reply(('^3[tLib] demo mode is %s^7'):format(value and '^2ON' or '^1OFF'))
    if arg ~= '' then
        -- Said every time, because the half of demo mode that is a start-time
        -- action cannot be applied by a toggle, and an operator who flips it on
        -- and sees permissions open up will reasonably assume the rest took too.
        reply('^3        access and permission changes are live now; the data reset '
            .. 'and the marketplace sweep happen when a resource next starts^7')
    end
    if arg == 'on' then announce() end
end, true)

-- ── The marketplace sweep ───────────────────────────────────────────────────

--- Ask a consumer's bundled marketplace agent to uninstall everything it owns.
---
--- Dispatched rather than done here for the same reason installs are: FiveM's
--- Node runtime sandboxes each resource to its own directory, so tLib deleting
--- files inside tRadio's folder is refused outright. The sweep runs in the
--- consumer's own bundle, using the receipts written at install time.
---
--- Preinstalled content is safe by construction and needs no special case: items
--- that ship with a resource are covered by its embedded ProtectedBuiltinInventory
--- and are never receipt-owned, and this only ever deletes what a receipt claims.
--- @param resource string
function Demo.sweepMarketplace(resource)
    if not Demo.active() then return end
    if type(resource) ~= 'string' or resource == '' then return end
    TriggerEvent(('tlib:marketplace:doDemoReset:%s'):format(resource), { token = 'demo' })
end

Platform.export('tLib', 'IsDemoMode', function() return Demo.active() end)
