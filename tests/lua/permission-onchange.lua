-- shared/imports/permission/client.lua — the admin-level mirror and onChange.
--
-- Three resources carried this as six byte-identical lines and a fourth forgot
-- it, so the properties worth pinning are the ones a copy gets wrong: the
-- source guard, the seed that covers a late load, and firing the first answer
-- even when that answer is 0.
--
-- The suite re-`dofile`s the module per scenario. The seed is read at LOAD, so
-- a seed case cannot be set up any other way, and each dofile gets its own
-- closure state — which is also what keeps the cases from leaking into each
-- other.

local registered, serverAsks

local seedLevel   -- what GetPermissionLevel returns; non-number models "no answer"
local seedThrows  -- a tLib that is not reachable from load scope at all

GetCurrentResourceName = function() return 'tRadar' end
RegisterNetEvent   = function(name, fn) registered[name] = fn end
TriggerServerEvent = function(name) serverAsks[#serverAsks + 1] = name end

exports = setmetatable({}, {
    __index = function(_, name)
        assert(name == 'tLib', 'looked up the wrong resource: ' .. tostring(name))
        -- Indexing a missing export RAISES in FiveM, so model the raise and not
        -- a nil return: that is the shape the module's pcall is written against.
        if seedThrows then error('No such export GetPermissionLevel in resource tLib') end
        return { GetPermissionLevel = function() return seedLevel end }
    end,
})

tlib = { name = 'tLib' }

local function load()
    registered, serverAsks = {}, {}
    source = nil
    return dofile('shared/imports/permission/client.lua')
end

local RECEIVE = 'tLib:receiveAdminPermission'
local REQUEST = 'tLib:requestAdminPermission'

--- Deliver a server-triggered answer.
local function fromServer(result)
    source = 65535
    registered[RECEIVE](result)
    source = nil
end

-- The seed ------------------------------------------------------------------
-- tLib's server only answers a request, and tLib's own client asks once at ITS
-- resource start. A module that loads lazily on a consumer's first onChange has
-- already missed that reply, so a handler with no seed would report 0 until
-- something happened to re-ask.

seedThrows, seedLevel = false, 2
local p = load()
assert(p.level() == 2 and p.isAdmin(), 'the level is seeded from tLib own client cache')
assert(#serverAsks == 0, 'and a readable seed costs no extra round trip')

seedLevel = 0
p = load()
assert(p.level() == 0 and not p.isAdmin(), 'a seeded 0 is not an admin')
assert(#serverAsks == 0, 'a seeded 0 is still an answer, so it is not re-asked either')

-- A tLib that cannot be reached at load scope must not produce a confident 0.
seedThrows = true
p = load()
assert(p.level() == 0, 'an unreadable seed reads as level 0')
assert(#serverAsks == 1 and serverAsks[1] == REQUEST,
    'and the module asks the server itself rather than waiting to be told')

-- Same for an export that answers with something that is not a level.
seedThrows, seedLevel = false, nil
p = load()
assert(p.level() == 0 and #serverAsks == 1, 'a non-number seed is no seed; ask')

seedLevel = 'admin'
p = load()
assert(p.level() == 0 and #serverAsks == 1, 'a string seed is no seed either')

-- The source guard ----------------------------------------------------------
-- THE SECURITY PROPERTY. A server-triggered net event reaches the client
-- with source == 65535; a local TriggerEvent does not. Without this, any
-- resource or cheat menu in the process could promote the player to admin in
-- every consumer's cache at once.

seedLevel = 0
p = load()
assert(not p.isAdmin(), 'baseline: not an admin')

-- Each of these is a plausible WEAKENING of the guard, not just a stray value,
-- which is what makes them worth asserting rather than one representative case:
--   * a nil source passes `if source and source ~= 65535 then return end`
--   * the string '65535' passes a tostring comparison
--   * 0 passes a truthiness test
for _, spoof in ipairs({ 1, 0, 12, -1, '65535', 65534 }) do
    source = spoof
    registered[RECEIVE](2)
    assert(not p.isAdmin(),
        'a local trigger with source ' .. tostring(spoof) .. ' must not grant admin')
end
source = nil
registered[RECEIVE](2)
assert(not p.isAdmin(), 'a nil source must not grant admin')

fromServer(2)
assert(p.isAdmin() and p.level() == 2, 'and the server, with 65535, is believed')

-- A number, and only a number -----------------------------------------------
-- The three copies all accepted a boolean too, labelled "old servers sent a
-- boolean", and so did tLib's own cl_permission.lua until 2026-10-12. All of
-- them are gone: tLib's client and server ship in one resource and cannot
-- disagree about the shape, and every tagged release v0.1..v0.6 sends a number.
-- Anything that is not a number is 0, which is also the right answer for a
-- spoofed payload.

p = load()
fromServer(true)
assert(p.level() == 0 and not p.isAdmin(), 'a boolean payload is not a level; it is 0')
fromServer({ level = 2 })
assert(p.level() == 0, 'nor is a table')
fromServer(1)
assert(p.level() == 1 and p.isAdmin(), 'a number is')

-- onChange ------------------------------------------------------------------

seedThrows, seedLevel = true, nil
p = load()
local seen = {}
p.onChange(function(isAdmin, level) seen[#seen + 1] = { isAdmin, level } end)
assert(#seen == 0, 'nothing to report before the first answer arrives')

-- The first answer fires even when it is 0. `changed` is `or not answered`
-- for exactly this: a listener registered before any answer has not run yet and
-- still needs to, or a panel built for a non-admin never gets drawn at all.
fromServer(0)
assert(#seen == 1 and seen[1][1] == false and seen[1][2] == 0,
    'the first answer fires even though the level did not move off 0')

fromServer(0)
assert(#seen == 1, 'an unchanged answer does not fire again')

fromServer(1)
assert(#seen == 2 and seen[2][1] == true and seen[2][2] == 1, 'a grant fires')

fromServer(2)
assert(#seen == 3 and seen[3][1] == true and seen[3][2] == 2,
    'admin -> superadmin is a change in `level` even though isAdmin did not move')

fromServer(0)
assert(#seen == 4 and seen[4][1] == false, 'and a revoke fires — this is the tAFK bug')

-- A listener added after an answer is known hears it at once, so a feature
-- built late does not have to ask separately.
local late = {}
p.onChange(function(isAdmin) late[#late + 1] = isAdmin end)
assert(#late == 1 and late[1] == false, 'a late listener is told immediately')
fromServer(1)
assert(#late == 2 and late[2] == true, 'and keeps hearing changes')

-- One consumer feature throwing must not stop the others being told. Registered
-- before any answer on purpose: the immediate call `onChange` makes to a
-- listener added AFTER an answer is deliberately NOT pcall'd, because it runs
-- synchronously inside the consumer's own call and belongs in their stack.
seedThrows, seedLevel = true, nil
p = load()
local after = 0
p.onChange(function() error('a consumer bug') end)
p.onChange(function() after = after + 1 end)
fromServer(1)
assert(after == 1, 'a throwing listener does not stop the ones registered after it')

assert(p.onChange(nil) == nil and p.onChange('x') == nil, 'a non-function listener is a no-op')
fromServer(0)
assert(after == 2, 'and does not corrupt the list')

-- refresh -------------------------------------------------------------------
p = load()
local before = #serverAsks
p.refresh()
assert(#serverAsks == before + 1 and serverAsks[#serverAsks] == REQUEST,
    'refresh asks the server')

-- The wire names are an implementation detail -------------------------------
-- This is what unblocks renaming tLib:receiveAdminPermission. The module's
-- surface must name neither wire event, or a consumer can reach for one.
for _, name in ipairs({ 'level', 'isAdmin', 'onChange', 'refresh' }) do
    assert(type(p[name]) == 'function', name .. ' is part of the interface')
end
local surface = 0
for _ in pairs(p) do surface = surface + 1 end
assert(surface == 4, 'and nothing else is — the wire event is not reachable from here')

print('permission-onchange: ok')
