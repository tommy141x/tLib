--[[
    The authority for demo mode: the console banner, the `tlib_demo` command, and
    the push to clients and other resources' server VMs on a flip. The rule itself
    lives in shared/imports/demo/shared.lua, loaded by every consumer as `tlib.demo`.
    Loaded before sv_permission.lua and sv_marketplace.lua, which both consult `Demo`.
]]

-- Loaded, not reimplemented, so the truthy-convar rule has one definition -- an
-- owner writing `setr tlib_demo true` can't get a live server here and demo there.
-- Same pattern as sv_main.lua's versioncheck load.
Demo = load(
    LoadResourceFile(GetCurrentResourceName(), 'shared/imports/demo/shared.lua'),
    '@@tLib/shared/imports/demo/shared.lua'
)()

local CHANGED = 'tlib:demo:changed'
local REQUEST = 'tlib:demo:request'

-- Saying so

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

-- Said once at boot, and again only on a manual toggle. A 30-minute repeat was
-- tried and dropped: a 15-hour server logged 31 banners / 310 lines, none read.
-- `tlib_demo` with no argument still answers at any time.

-- Broadcasting

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

-- The runtime toggle

-- Restricted to console and `tlib.admin`. In demo mode everyone holds `tlib.admin`,
-- so an in-game player can turn demo mode off but never on -- the safe direction.
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

-- The marketplace sweep

--- Ask a consumer's bundled marketplace agent to uninstall everything it owns.
--- Dispatched because FiveM sandboxes each resource to its own directory; tLib
--- cannot delete files inside tRadio's folder itself. Uses install-time receipts --
--- preinstalled content has none, and installer/core.lua's `owned()` throws on an
--- unclaimed path rather than touching it. Not gated by ProtectedBuiltinInventory
--- (legacy-adoption only; nothing passes one today).
--- @param resource string
function Demo.sweepMarketplace(resource)
    if not Demo.active() then return end
    if type(resource) ~= 'string' or resource == '' then return end
    TriggerEvent(('tlib:marketplace:doDemoReset:%s'):format(resource), { token = 'demo' })
end

Platform.export('tLib', 'IsDemoMode', function() return Demo.active() end)
