-- Standalone from resource root:
--   bunx --bun --package fengari-node-cli fengari tests/lua/adapter-nui.lua
--
-- Oracle for the FiveM NUI adapter's reply encoding -- shared/lib/adapter/ui.lua, the one
-- piece of the menu's round trip that is host code rather than engine code, and the
-- reason it needs a suite of its own: every other suite here stubs
-- Platform.onUIRequest, so the adapter that implements it was the only link in the
-- chain nothing measured.
--
-- THE REPLY IS A TABLE, NEVER AN ENCODED STRING. CitizenFX's resultCallback
-- serializes its own argument, so `resultCallback(json.encode(result))` serializes
-- twice: the HTTP body becomes a quoted JSON string, the browser's
-- `await response.json()` resolves to a *string* instead of an object, and the
-- bridge's `typeof result !== 'object'` gate rejects it with 'Invalid runtime
-- response.' Measured in-game against this exact raw `__cfx_nui:` handler form:
--   resultCallback({ ok = true })              -> body {"ok":true}      -> object
--   resultCallback(json.encode({ ok = true })) -> body "{\"ok\":true}"  -> string
--
-- What made that survive a full green run is worth stating plainly: the menu still
-- rendered. The tree arrives by SendNUIMessage, which is one-way and was never
-- double-encoded; only the ANSWERS came back through here. So the menu drew itself
-- correctly and then failed on the first action, navigation or close -- visibly
-- broken to a player, invisible to every suite.

local UI = 'shared/lib/adapter/ui.lua'

local checks = 0
local function fail(message) error('FAIL: ' .. message, 0) end
local function check(condition, message)
    checks = checks + 1
    if not condition then fail(message) end
end
local function equal(actual, expected, message)
    checks = checks + 1
    if actual ~= expected then
        fail(('%s: expected %s, got %s'):format(message, tostring(expected), tostring(actual)))
    end
end

-- ── The host, as the client side of a FiveM resource ────────────────────────

_TLIB_IS_FIVEM = true
_TLIB_SIDE = 'client'

Logger = { create = function() return function() end end }

-- The registered raw NUI handlers, by callback name, plus the names declared to
-- the host. A callback the page can post to but that was never declared is as
-- broken as one that answers wrongly, so both are recorded.
local handlers, declared = {}, {}
function RegisterNuiCallbackType(name) declared[name] = (declared[name] or 0) + 1 end
function AddEventHandler(event, fn)
    local name = event:match('^__cfx_nui:(.+)$')
    if name then handlers[name] = fn end
end
local sent = {}
function SendNUIMessage(msg) sent[#sent + 1] = msg end
function SetNuiFocus() end
function SetNuiFocusKeepInput() end

-- fengari has no cjson; the adapter only needs decode for inbound bodies and must
-- not need encode at all for replies. This encode records every call so the suite
-- can assert the adapter did NOT reach for it on the reply path.
local encodeCalls = 0
json = {
    decode = function(text)
        -- Enough for the one shape the adapter decodes: a flat object of strings.
        -- Returns two values exactly as FiveM's does, which is itself the trap
        -- tMenu's scripts/test-lua.ts pins on the consumer side.
        local decoded = {}
        for key, value in text:gmatch('"([^"]+)"%s*:%s*"([^"]*)"') do decoded[key] = value end
        return decoded, #text
    end,
    encode = function(value) encodeCalls = encodeCalls + 1; return tostring(value) end,
}

Platform = { _stub = function(name) return function() error('stub ' .. name, 0) end end }

assert(loadfile(UI, 't', _G),
    'shared/lib/adapter/ui.lua not found -- run this suite from the tLib resource root')()

-- ── The ready handshake ─────────────────────────────────────────────────────

check(declared['__tlib_nui_ready'] == 1, 'the ready callback is declared to the host exactly once')
check(handlers['__tlib_nui_ready'] ~= nil, 'the ready callback is registered')

local readyReply
handlers['__tlib_nui_ready'](nil, function(result) readyReply = result end)
equal(type(readyReply), 'table', 'the ready handshake answers with a table, not an encoded string')
check(Platform.isNUIReady(), 'the handshake marks the page ready')

-- ── onUIEvent: the one-way form still has to answer correctly ───────────────

local heard
Platform.onUIEvent({}, 'probe_event', function(data) heard = data end)
check(declared['probe_event'] == 1, 'onUIEvent declares its callback type')
local eventReply
handlers['probe_event']('{"field":"value"}', function(result) eventReply = result end)
equal(type(eventReply), 'table', 'onUIEvent answers with a table, not an encoded string')
equal(type(heard), 'table', 'onUIEvent decodes a string body into a table for its handler')
equal(heard.field, 'value', 'the decoded body reaches the handler')

-- ── onUIRequest: the answering form, which is what the menu runs on ─────────

local received, answer
Platform.onUIRequest({}, 'probe_request', function(data, finish)
    received = data
    answer = finish
end)
check(declared['probe_request'] == 1, 'onUIRequest declares its callback type')

local replies = {}
handlers['probe_request']('{"menuId":"alpha:main"}', function(result) replies[#replies + 1] = result end)
equal(type(received), 'table', 'a string body is decoded before the handler sees it')
equal(received.menuId, 'alpha:main', 'the decoded field reaches the handler')

answer({ ok = true, nextMenu = 'alpha:child' })
equal(#replies, 1, 'answering once produces exactly one reply')
equal(type(replies[1]), 'table', 'THE REPLY IS A TABLE -- an encoded string reaches the browser double-encoded')
equal(replies[1].ok, true, 'the reply carries ok through unchanged')
equal(replies[1].nextMenu, 'alpha:child', 'the reply carries its other fields through unchanged')

-- The fields must arrive as themselves, not stringified: `ok` is the field the
-- bridge type-checks, and a `"true"` would fail `typeof result.ok !== 'boolean'`
-- just as surely as a double-encoded body does.
check(replies[1].ok ~= 'true', 'ok stays a boolean rather than becoming a string')

-- Fire-once, because CitizenFX treats a second resultCallback as an error.
answer({ ok = false, error = 'second' })
equal(#replies, 1, 'a second answer is dropped rather than passed to the host')
equal(replies[1].error, nil, 'the first answer is the one that stands')

-- A table body (the host sometimes hands one over already parsed) must pass
-- through rather than being decoded again.
local secondReceived
Platform.onUIRequest({}, 'probe_table_body', function(data) secondReceived = data end)
handlers['probe_table_body']({ already = 'parsed' }, function() end)
equal(type(secondReceived), 'table', 'a table body is handed over as a table')
equal(secondReceived.already, 'parsed', 'a table body is not re-decoded')

-- ── And the encoder was never touched on the reply path ─────────────────────
--
-- The assertion that makes this suite exclusive rather than inclusion-only: every
-- reply above could carry the right fields and still be wrong if the adapter
-- serialized it on the way out. Nothing in these paths may call json.encode.
equal(encodeCalls, 0, 'the adapter never encodes a reply itself -- resultCallback does that')

-- ── Outbound messages are unaffected ───────────────────────────────────────
--
-- sendUIEvent is one-way and was never double-encoded; pinned here so a fix to the
-- reply path cannot be "tidied" into changing the message envelope the renderer
-- listens for.
sent = {}
Platform.sendUIEvent({}, 'tlib:menu:snapshot', { version = 1 })
equal(#sent, 1, 'a send after the page is ready goes straight out')
equal(sent[1].name, 'tlib:menu:snapshot', 'the envelope names the event')
equal(type(sent[1].args), 'table', 'the payload travels in args')
equal(sent[1].args[1].version, 1, 'the payload is args[1], not flattened into the envelope')

print(('PASS: %d NUI adapter assertions -- replies are tables, bodies decode, answers fire once'):format(checks))
