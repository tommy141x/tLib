--[[
    tLib/shared/imports/permission — the CLIENT half.

    Usage in a consumer (client scripts):

        tlib.permission.onChange(function(isAdmin) hudIsAdmin = isAdmin end)

        if tlib.permission.isAdmin() then addAdminTab() end

     What this replaces

    Three resources carried the SAME six lines, byte for byte, and a fourth
    forgot them:

        RegisterNetEvent("tLib:receiveAdminPermission")
        AddEventHandler("tLib:receiveAdminPermission", function(result)
            if source ~= 65535 then return end
            local level = type(result) == "number" and result or (result == true and 1 or 0)
            isAdmin = level >= 1
        end)

    tELS/client/cl_lights.lua, tRadar/client/cl_hud.lua and
    tDetector/client/cl_hud.lua each had it. tAFK had none, so revoking a
    player's `tlib.admin` on a running server left their /tafk panel drawing the
    admin section for the rest of the session — the panel lying about what the
    player could do. A copy nobody can forget is the whole point.

     The wire event is NOT part of this interface

     `tLib:receiveAdminPermission` appears exactly once below and must never
    appear in a consumer again. Those three copies are the only thing blocking
    the rename to `tlib:permission:receive`: once the only files naming it are
    tLib's own (client/cl_permission.lua, server/sv_permission.lua) and this
    module, the rename is an internal edit. Callers see `onChange`, `isAdmin`,
    `level` and `refresh`, and nothing about how the answer arrives.

     Why there is a seed and not just a handler

    tLib's server sends this only in answer to `requestAdminPermission`, and
    tLib's own client asks once, at ITS resource start. A consumer that starts
    later — or this module loading lazily on a consumer's first `onChange` —
    has already missed that reply, and a handler alone would then report 0 until
    something happened to re-ask. So the level is seeded from tLib's own client
    cache via `GetPermissionLevel`, which is the same number the reply carries.

    The export call is pcall'd because it crosses a resource boundary at load
    scope. `dependency 'tLib'` makes that ordering normal rather than
    guaranteed, and an uncaught error here would abort the consumer's whole file
    — the failure tRadar and tDetector both document at the top of their
    cl_hud.lua, where neither surface then initialises and nothing in the log
    connects the two. If the seed cannot be read, this asks the server itself
    rather than reporting a confident 0.

     A number, and only a number

    The three copies all accepted a boolean as well, labelled "old servers sent
    a boolean", and so did tLib's own cl_permission.lua until 2026-10-12. All of
    them are gone: tLib's client and server ship in one resource and cannot
    disagree about the shape, and every tagged release v0.1..v0.6 sends
    Permission.getPlayerLevel, which has always returned a number. Anything that
    is not a number is level 0 — which is also the right answer for a spoofed
    payload.

     Not the same interface as the server half

    `shared/imports/permission/server.lua` answers ABOUT a player —
    `tlib.permission.isAdmin(src)`. This one answers about THIS player and takes
    no argument. Same asymmetry `access` has between its two halves, and for the
    same reason: there is only one player on this side.

     And the same warning applies. This is a cached copy of a decision the
    server made, living in a process the player controls. It answers "should I
    draw the admin tab?" and never "may this player do the thing". Every
    privileged net event still re-resolves the ace server-side.
]]

local Permission = {}

local tLibName = (type(tlib) == 'table' and tlib.name) or 'tLib'

local WIRE_RECEIVE = 'tLib:receiveAdminPermission'
local WIRE_REQUEST = 'tLib:requestAdminPermission'

-- A server-triggered net event always reaches the client with source == 65535.
-- A local TriggerEvent — another resource, a cheat menu — does not, and without
-- this check could promote the player to admin in every consumer's cache at
-- once.
local SERVER_SOURCE = 65535

local level     = 0
local answered  = false
local listeners = {}

local function deliver(result)
    local next = (type(result) == 'number') and result or 0
    -- `or not answered` so the first answer always fires, including the first
    -- answer that happens to be 0: a listener registered before any answer
    -- arrived has not run yet and still needs to.
    local changed = (next ~= level) or not answered
    level, answered = next, true
    if not changed then return end
    -- pcall'd per listener: these belong to different features of the consumer
    -- and one of them throwing must not stop the rest from being told.
    for _, fn in ipairs(listeners) do pcall(fn, next >= 1, next) end
end

RegisterNetEvent(WIRE_RECEIVE, function(result)
    if source ~= SERVER_SOURCE then return end
    deliver(result)
end)

local seedOk, seeded = pcall(function() return exports[tLibName]:GetPermissionLevel() end)
if seedOk and type(seeded) == 'number' then
    level, answered = seeded, true
else
    TriggerServerEvent(WIRE_REQUEST)
end

--- 0 = none, 1 = admin, 2 = superadmin — this player's level, as last answered.
--- @return integer
function Permission.level()
    return level
end

--- @return boolean  true for admins and superadmins
function Permission.isAdmin()
    return level >= 1
end

--- Ask the server for a fresh answer. Every `onChange` listener hears the result
--- if it differs. Call it after anything that could plausibly change the
--- outcome; nothing needs to be called on a normal grant or revoke, because
--- tLib's server pushes those.
function Permission.refresh()
    TriggerServerEvent(WIRE_REQUEST)
end

--- Run `fn(isAdmin, level)` whenever the answer changes, and once immediately.
---
--- The immediate call is NOT pcall'd, unlike the ones from `deliver`: it runs
--- synchronously inside the consumer's own call to `onChange`, so an error in it
--- belongs in the consumer's stack where the line that caused it is visible.
---
--- @param fn fun(isAdmin: boolean, level: integer)
function Permission.onChange(fn)
    if type(fn) ~= 'function' then return end
    listeners[#listeners + 1] = fn
    if answered then fn(level >= 1, level) end
end

return Permission
