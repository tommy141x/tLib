-- server/sv_http_ingress.lua: the headers this door hands upstream.
--
-- This file had no suite at all until 2026-10-28, which is how it shipped in
-- v1.1 relaying the client's own `X-Forwarded-For` to the app behind it.
--
-- Why that is the one thing worth pinning here. An app reached through this
-- door sees every request arrive from 127.0.0.1, and loopback is trusted
-- unconditionally on the other side -- tRadio's getClientIP trusts it because
-- "a connection from loopback is by definition something running on this same
-- machine", which is precisely the premise this door invalidates. So a
-- forwarding header that survives the relay is not a cosmetic leak: it is the
-- caller choosing what address the rate limiters bucket them under, and the
-- admin password losing the only thing that makes a password survive contact
-- with the internet, on a port the operator cannot close.
--
-- The assertions are therefore about the OUTCOME -- what lands in
-- PerformHttpRequest's header table -- and never about whether the drop list
-- contains a string. A drop list naming the right keys while the copy loop
-- preserves the client's key case is exactly how the original hole worked.

local realPrint = print
local rawassert = assert
local printed = {}
local verbose = os.getenv('TLIB_TEST_VERBOSE') == '1'

print = function(s)
    printed[#printed + 1] = tostring(s)
    if verbose then realPrint(s) end
end

local function assert(condition, message)
    if not condition then
        print = realPrint
        for _, line in ipairs(printed) do realPrint('  captured: ' .. line) end
    end
    return rawassert(condition, message)
end

-- Host stubs

local handler = nil
local sent = nil

SetHttpHandler = function(fn) handler = fn end
GetCurrentResourceName = function() return 'tRadio' end
GetConvar = function(_, default) return default end
-- Deliberately never runs the body: the only CreateThread in the file is the
-- upstream timeout, and running it synchronously would answer 504 before the
-- request under test was ever built.
CreateThread = function() end
Wait = function() end

PerformHttpRequest = function(target, _cb, method, body, headers)
    sent = { target = target, method = method, body = body, headers = headers }
end

exports = {
    tLib = {
        ResolveHttpIngress = function(_self, _method, path, _name, _basePath, _owner)
            return { kind = 'upstream', host = '127.0.0.1', port = 30120, path = path, prefix = '/tRadio' }
        end,
    },
}

dofile('server/sv_http_ingress.lua')
assert(type(handler) == 'function', 'the file registers an HTTP handler on load')

--- One GET through the door. `address` is the real peer as FXServer reports it.
local function relay(headers, address)
    sent = nil
    handler({
        method = 'GET',
        path = '/admin',
        headers = headers,
        address = address,
        setDataHandler = function() end,
    }, {
        writeHead = function() end,
        send = function() end,
    })
    assert(sent ~= nil, 'the request reached PerformHttpRequest')
    return sent.headers
end

--- Every spelling of a header name that is present, with its value. The point of
--- returning a list rather than a lookup: two Lua keys differing only in case are
--- two distinct entries naming ONE HTTP header, and that collision is the bug.
local function spellings(headers, name)
    local found = {}
    for k, v in pairs(headers or {}) do
        if tostring(k):lower() == name then found[#found + 1] = tostring(v) end
    end
    return found
end

-- The forwarding headers are the relay's to author, and only the relay's.

local out = relay({
    ['X-Forwarded-For'] = '10.9.9.9',
    ['Host'] = 'hub.example.com',
}, '203.0.113.7')

local xff = spellings(out, 'x-forwarded-for')
assert(#xff == 1, 'exactly one X-Forwarded-For reaches the app, not one per spelling')
assert(xff[1] == '203.0.113.7',
    'X-Forwarded-For is the real peer, not the value the client asked to be seen as')

-- The lowercase spelling is the case that mattered: the copy loop preserves the
-- client's key case, so a drop list that only overwrote the canonical name left
-- this one beside it and the app read whichever survived.
out = relay({
    ['x-forwarded-for'] = '10.9.9.9',
    ['Host'] = 'hub.example.com',
}, '203.0.113.7')
xff = spellings(out, 'x-forwarded-for')
assert(#xff == 1 and xff[1] == '203.0.113.7',
    'a lowercase x-forwarded-for does not survive alongside the canonical one')

-- An empty peer address was the other half. The canonical write is conditional,
-- so with nothing to write the client's value used to be the only one present --
-- and absent is the safe answer, never the caller's claim.
out = relay({ ['X-Forwarded-For'] = '10.9.9.9' }, '')
assert(#spellings(out, 'x-forwarded-for') == 0,
    'with no peer address the header is absent, not the value the client supplied')

out = relay({ ['X-Forwarded-For'] = '10.9.9.9' }, nil)
assert(#spellings(out, 'x-forwarded-for') == 0,
    'and a nil peer address does not fall through to the client value either')

-- X-Forwarded-Prefix decides where the app thinks it lives: tRadio builds the
-- panel's base path from it, so a client that sets it chooses the panel's links.
out = relay({ ['x-forwarded-prefix'] = '/evil' }, '203.0.113.7')
local prefix = spellings(out, 'x-forwarded-prefix')
assert(#prefix == 1 and prefix[1] == '/tRadio',
    'X-Forwarded-Prefix is this door, not a path the client nominated')

-- X-Forwarded-Host comes from the real Host header, which the router drops for
-- its own reasons; a client-supplied X-Forwarded-Host must not outlive it.
out = relay({
    ['x-forwarded-host'] = 'evil.example.com',
    ['Host'] = 'hub.example.com',
}, '203.0.113.7')
local fwdHost = spellings(out, 'x-forwarded-host')
assert(#fwdHost == 1 and fwdHost[1] == 'hub.example.com',
    'X-Forwarded-Host is derived from Host, not taken from the client')

-- x-real-ip and forwarded are never written by this file at all, so passing them
-- through would hand the app a second, unguarded way to be told a client address.
out = relay({
    ['X-Real-IP'] = '10.9.9.9',
    ['Forwarded'] = 'for=10.9.9.9',
    ['x-forwarded-proto'] = 'https',
}, '203.0.113.7')
assert(#spellings(out, 'x-real-ip') == 0, 'X-Real-IP does not reach the app')
assert(#spellings(out, 'forwarded') == 0, 'Forwarded does not reach the app')
local proto = spellings(out, 'x-forwarded-proto')
assert(#proto == 1 and proto[1] == 'http',
    'X-Forwarded-Proto describes this hop, not the scheme the client claimed')

-- Everything else still has to get through, or the drop list is a different bug.
out = relay({
    ['Authorization'] = 'Bearer abc',
    ['Cookie'] = 'admin_auth=xyz',
    ['Content-Type'] = 'application/json',
    ['X-Forwarded-For'] = '10.9.9.9',
}, '203.0.113.7')
assert(spellings(out, 'authorization')[1] == 'Bearer abc', 'Authorization is forwarded')
assert(spellings(out, 'cookie')[1] == 'admin_auth=xyz',
    'Cookie is forwarded -- the admin session is carried by it, so dropping it logs everyone out')
assert(spellings(out, 'content-type')[1] == 'application/json', 'Content-Type is forwarded')

-- Host itself is dropped: the router picks a mount from the path alone, which is
-- what keeps it from being an open relay.
assert(#spellings(out, 'host') == 0, 'Host is not forwarded')

print = realPrint
print('PASS http-ingress-forwarded')
