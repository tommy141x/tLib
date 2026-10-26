--[[
    tLib/shared/imports/permission — the CLIENT half.

    Usage in a consumer (client scripts):

        tlib.permission.onChange(function(isAdmin) hudIsAdmin = isAdmin end)

        if tlib.permission.isAdmin() then addAdminTab() end

    Replaces the same six-line `tLib:receiveAdminPermission` handler
    duplicated in tLS, tRadar and tDetector; tAFK had none, so revoking a
    player's `tlib.admin` mid-session left its /tafk panel drawing the admin
    section for the rest of it.

    The wire event name appears exactly once below and must never appear in
    a consumer again — that's what lets it be renamed later as an internal
    edit. Callers see only `onChange`, `isAdmin`, `level`, `refresh`.

    Seeded from tLib's own client cache (`GetPermissionLevel`, pcall'd since
    it crosses a resource boundary at load scope) because tLib's client asks
    the server only once, at its own resource start — a consumer loading
    later would otherwise report 0 until something re-asks. If the seed
    can't be read, this asks the server directly instead of assuming 0.

    Accepts only a number; anything else (including a boolean, which old
    senders used) reads as level 0 — the same answer a spoofed payload gets.

    Answers about THIS player, no argument — the server half
    (`shared/imports/permission/server.lua`) answers about a given player.
    Same asymmetry as `access`, same reason: only one player on this side.

    This is a cached copy of a server decision, living in a process the
    player controls. It answers "should I draw the admin tab?", never "may
    this player do the thing" — every privileged net event still re-resolves
    the ace server-side.
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
