--[[
    tLib/shared/imports/net — the CLIENT half: a net event only the SERVER can
    fire.
    Design notes: docs/internal/net-guarded-events.md
]]

local Net = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

-- A server-triggered net event always arrives with this source.
local SERVER_SOURCE = 65535

--- event name -> true once its first rejection has been reported.
local reported = {}

local function reportRejection(name, src)
    if reported[name] then return end
    reported[name] = true
    print(('^3[%s] tlib.net.fromServer: dropped a locally-triggered "%s" (source %s, ' ..
           'not the server). Only the server may fire it. Reported once per event name.^7')
        :format(RESOURCE, name, tostring(src)))
end

--- Register a net event handler that runs ONLY for a server-triggered event.
---
--- @param name string    the net event name
--- @param fn function    handler, called with the event's own arguments
--- @return function      the guarded closure, registered under `name`
function Net.fromServer(name, fn)
    assert(type(name) == 'string' and name ~= '',
        'tlib.net.fromServer: name must be a non-empty string')
    assert(type(fn) == 'function',
        'tlib.net.fromServer: fn must be a function')

    local function guarded(...)
        -- `source` is a per-dispatch global: read it before calling anything.
        local src = source
        if src ~= SERVER_SOURCE then
            reportRejection(name, src)
            return
        end
        fn(...)
    end

    RegisterNetEvent(name, guarded)
    return guarded
end

-- Raises rather than being absent: the two names look symmetrical, so calling
-- the wrong one is easy and a nil-field error would not say so.
function Net.fromClient()
    error('tlib.net.fromClient is server-side only; this is a client script. ' ..
          'The client-side guard is tlib.net.fromServer.', 2)
end
return Net
