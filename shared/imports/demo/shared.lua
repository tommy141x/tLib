--[[
    tLib/shared/imports/demo — the demo-server switch.

    Usage:
        if tlib.demo.active() then ... end
        if tlib.demo.dropWrite('data.json') then return true end   -- server

     What demo mode is

    One convar, `tlib_demo`, that turns a server into a throwaway showroom:

      * every access gate and every permission check answers YES, so a visitor
        can open the admin surfaces and drive every feature;
      * no resource ever writes its state file, so whatever a visitor changes
        lives in memory for that resource's lifetime and is gone the moment it
        restarts;
      * marketplace installs still really happen -- you can watch one land and
        use it -- and are swept off disk on the next start, leaving the shipped
        tree exactly as it came out of the zip.

    The result is a server that resets itself on `ensure <resource>` and needs no
    cleanup between visitors, and which doubles as the test box: the same build
    that ships is the one running, with nothing patched out of it.

     Why it is a convar and not config

    Because a convar is the one piece of configuration that CANNOT travel inside
    the release. `server.cfg` is the server owner's file; it is not in the zip,
    is not escrow-packed and is not something a build step can leak. So the demo
    box keeps demo mode across updates without a per-release edit, and a customer
    who installs the very same artifact gets the real thing, with no build flag,
    no stripped code path and no "did we remember to turn it off" step. There is
    nothing to forget.

     It is not a security feature, it is the absence of one

    Demo mode is fail-OPEN by design and it is the only thing in tLib that is.
    Everything else here -- `access`, `permission`, the marketplace admin rule --
    fails closed on purpose, and demo mode deliberately overrides all of them.
    Turning it on makes every connected player a superadmin. That is the point,
    and it is why `active()` is checked at the top of those gates rather than
    woven through them: one branch, easy to read, impossible to half-apply.

    Never set it on a server whose data you care about or whose players you do
    not. tLib says so on every start, in red, and keeps saying it -- see
    server/sv_demo.lua.

     Reading it

    The convar is authoritative on the server and is read directly there. A
    client VM can only see a convar set with `setr`, so rather than make `setr`
    load-bearing, tLib pushes the state to clients and this module listens. The
    convar is still used as the client's opening guess so the very first frame is
    usually right; the push corrects it either way.
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
