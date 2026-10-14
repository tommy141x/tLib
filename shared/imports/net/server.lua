--[[
    tLib/shared/imports/net — the SERVER half: a net event a client may fire,
    with the preamble that every one of them needs already applied.
    Design notes: docs/internal/net-guarded-events.md
]]

local Net = {}

local RESOURCE = (GetCurrentResourceName and GetCurrentResourceName()) or 'resource'

local DEFAULT_INTERVAL_MS = 1000

--- event name -> true once its first denial has been reported.
local reported = {}

local function reportDenial(name, src)
    if reported[name] then return end
    reported[name] = true
    print(('^3[%s] tlib.net.fromClient: denied "%s" for player %s. Reported once per ' ..
           'event name.^7'):format(RESOURCE, name, tostring(src)))
end

--- Register a net event handler with the source guard, a rate limit and an
--- optional permission gate already applied.
---
--- @param name string
--- @param opts table|function  { rateLimit?, allow?, onDenied? }, or the handler
--- @param fn function|nil      handler, called as fn(src, ...)
--- @return function            the guarded closure, registered under `name`
function Net.fromClient(name, opts, fn)
    -- `opts` is never a function, so this arity flex cannot be ambiguous.
    if type(opts) == 'function' and fn == nil then
        opts, fn = {}, opts
    end
    opts = opts or {}

    assert(type(name) == 'string' and name ~= '',
        'tlib.net.fromClient: name must be a non-empty string')
    assert(type(fn) == 'function',
        'tlib.net.fromClient: fn must be a function')
    assert(opts.allow == nil or type(opts.allow) == 'function',
        'tlib.net.fromClient: allow must be a function taking (src)')
    assert(opts.onDenied == nil or type(opts.onDenied) == 'function',
        'tlib.net.fromClient: onDenied must be a function taking (src)')

    local interval = opts.rateLimit
    if interval == nil then interval = DEFAULT_INTERVAL_MS end

    local limited = tlib.ratelimit.bucket(('net:%s'):format(name), interval)

    local allow, onDenied = opts.allow, opts.onDenied

    local function guarded(...)
        local src = source
        if not src or src <= 0 then return end
        if limited(src) then return end

        if allow then
            local ok, allowed = pcall(allow, src)
            if not ok then
                print(('^1[%s] tlib.net.fromClient: allow for "%s" errored: %s. Denying.^7')
                    :format(RESOURCE, name, tostring(allowed)))
                allowed = false
            end
            if allowed ~= true then
                reportDenial(name, src)
                if onDenied then pcall(onDenied, src) end
                return
            end
        end

        fn(src, ...)
    end

    RegisterNetEvent(name, guarded)
    return guarded
end

function Net.fromServer()
    error('tlib.net.fromServer is client-side only; this is a server script. ' ..
          'The server-side guard is tlib.net.fromClient.', 2)
end

return Net
