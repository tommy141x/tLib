--[[
    tLib/shared/imports/demo — the demo-server switch.

        if tlib.demo.active() then ... end
        if tlib.demo.dropWrite('data.json') then return true end   -- server

    One convar, `tlib_demo`, turns a server into a throwaway showroom: every
    access/permission check answers YES, no resource writes its state file
    (changes live in memory until `ensure <resource>`), and marketplace
    installs land for real but are swept off disk on next start.

    A convar, not config, because it cannot travel inside the release —
    `server.cfg` is the owner's file, not in the zip or escrow-packed — so
    the same shipped artifact runs for real on a customer server with
    nothing to strip or forget.

    Fail-OPEN by design, the only thing in tLib that is: everything else
    (`access`, `permission`, the marketplace admin rule) fails closed, and
    demo mode overrides all of them, making every connected player a
    superadmin. `active()` is checked at the top of each gate rather than
    woven through, so it can't be half-applied. Never set it on a server
    with data or players you care about — see server/sv_demo.lua.

    The server reads the convar directly. A client only sees a convar set
    with `setr`, so tLib pushes the real state to clients instead; the
    convar is just the client's opening guess before the push corrects it.
]]

local demo = {}

local CONVAR = 'tlib_demo'
local CHANGED = 'tlib:demo:changed'
local REQUEST = 'tlib:demo:request'

local IS_SERVER = IsDuplicityVersion and IsDuplicityVersion() or false

--- Truthy convar spellings. `ConvertToBool` does not exist in every runtime this
--- module is loaded into (the off-FiveM Lua suites have no natives at all), and
--- an owner who writes `setr tlib_demo true` must not silently get a live server.
local function truthy(value)
    if value == nil then return false end
    value = tostring(value):lower()
    return value == '1' or value == 'true' or value == 'yes' or value == 'on'
end

local function fromConvar()
    if type(GetConvar) ~= 'function' then return false end
    local ok, value = pcall(GetConvar, CONVAR, '0')
    return ok and truthy(value)
end

--- The live answer. On the server this is the convar unless a runtime toggle has
--- overridden it; on the client it is whatever tLib last pushed.
local state = fromConvar()

--- nil = follow the convar. Set by the `tlib_demo` console command so an operator
--- can flip a running server without editing server.cfg -- see server/sv_demo.lua.
local override = nil

--- Is demo mode on right now?
---
--- Cheap enough for the hot paths that call it (every permission level check,
--- every gate evaluation): a table read, or one `GetConvar` on the server.
--- @return boolean
function demo.active()
    if IS_SERVER then
        if override ~= nil then return override end
        return fromConvar()
    end
    return state
end

--- Apply a state pushed by tLib (or by the console command, in tLib's own VM).
--- Internal; consumers call `active()`.
--- @param value boolean|nil  nil on the server means "stop overriding, follow the convar"
function demo.set(value)
    if IS_SERVER then
        -- Spelled as a branch, not as `(value == nil) and nil or (value == true)`.
        -- That idiom cannot return nil: `true and nil` is nil, and `nil or X`
        -- then yields X, so clearing the override would set it to `false` --
        -- pinning the server OFF rather than handing control back to the convar.
        if value == nil then
            override = nil
        else
            override = (value == true)
        end
    else
        state = (value == true)
    end
end

--- Should this write be dropped?
---
--- The one line a resource's file writer needs. In demo mode the write never
--- reaches disk, so the in-memory state the resource already keeps serves the
--- session and the next start reads the shipped file back.
---
---     function saveData(json)
---         if tlib.demo.dropWrite('data.json') then return true end
---         return tlib.fs.writeResourceFile('data.json', json)
---     end
---
--- Report success to the caller when this returns true. The write did what the
--- operator asked of a demo server; treating it as a failure would surface an
--- error toast on every save and teach visitors the demo is broken.
---
--- @param what string|nil  path or label, for the one-line-per-target notice
--- @return boolean  true when the caller must skip the write
function demo.dropWrite(what)
    if not demo.active() then return false end
    demo.noteDropped(what)
    return true
end

--- One notice per distinct target, per resource lifetime. A demo server saves
--- constantly and a line per save would bury everything else in the console.
local noted = {}

function demo.noteDropped(what)
    local key = tostring(what or '?')
    if noted[key] then return end
    noted[key] = true
    print(('^3[tLib] demo mode: not writing "%s" — this server resets on restart^7'):format(key))
end

-- Transport
--
-- Server VMs get the convar directly, so they only need the override broadcast.
-- Clients need the whole answer. Both arrive on the same event.

if IS_SERVER then
    if type(AddEventHandler) == 'function' then
        AddEventHandler(CHANGED, function(value) demo.set(value) end)
    end
elseif type(RegisterNetEvent) == 'function' then
    RegisterNetEvent(CHANGED, function(value) demo.set(value) end)
    -- Ask rather than wait: a resource started after the server did would
    -- otherwise hold its convar guess until the next toggle, which on a server
    -- using plain `set` (not `setr`) means holding `false` forever.
    if type(TriggerServerEvent) == 'function' then
        pcall(TriggerServerEvent, REQUEST)
    end
end

return demo
