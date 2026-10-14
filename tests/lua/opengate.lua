-- shared/imports/opengate — the "may I open my panel?" handshake, both halves.
--
-- Driven through the REAL tlib.net and the REAL tlib.ratelimit, because the
-- three things worth pinning here all live in the composition: the decision
-- ORDER (rate limit, then config, then access), that every reply is server-only,
-- and that reopen() does not go near the server.
--
-- The two halves are wired to each other in this suite: the server's
-- TriggerClientEvent dispatches straight into the client's registered handler
-- with source 65535. That is what makes an assertion about the reply an
-- assertion about the pair agreeing on a wire name, rather than about two
-- strings written twice.

local realPrint = print
local lines = {}
local function capture() lines = {}; print = function(s) lines[#lines + 1] = tostring(s) end end
local function release() print = realPrint end
local function said(needle)
    for _, l in ipairs(lines) do if l:find(needle, 1, true) then return true end end
    return false
end

GetCurrentResourceName = function() return 'tRadar' end
AddEventHandler = function() end

local now = 0
GetGameTimer = function() return now end

-- Both sides register into one table; the names are namespaced by resource and
-- key, and the server's reply names and the client's listen names have to match
-- or nothing below fires at all.
local handlers = {}
RegisterNetEvent = function(name, fn) handlers[name] = fn end

local toServer = {}
TriggerServerEvent = function(name) toServer[#toServer + 1] = name end

--- Server -> that player's client. Delivered as a real server-triggered event.
local function TriggerClient(name, _src, ...)
    local fn = handlers[name]
    if not fn then return end
    source = 65535
    fn(...)
    source = nil
end
TriggerClientEvent = TriggerClient

local ratelimit = dofile('shared/imports/ratelimit/server.lua')
tlib = {
    ratelimit = ratelimit,
    net       = nil,  -- filled below; the modules read tlib.net at call time
}

local netServer = dofile('shared/imports/net/server.lua')
local netClient = dofile('shared/imports/net/client.lua')

-- One `tlib.net` for both halves: fromClient comes from the server file,
-- fromServer from the client file. In a real VM the context decides which file
-- loads; here both are needed in one state.
tlib.net = { fromClient = netServer.fromClient, fromServer = netClient.fromServer }

local opengate = dofile('shared/imports/opengate/server.lua')
local opengateClient = dofile('shared/imports/opengate/client.lua')

local BASE = 'tRadar:tlib:opengate:settings'

--- Fire the client's request as if the player had typed the command.
local function ask(panel, src)
    panel:open()
    source = src
    handlers[BASE .. ':request']()
    source = nil
end

--  The happy path, and the payload

local allowed, configFine = { [7] = true }, true
local opened, deniedCount, brokenCount = {}, 0, 0

opengate.serve({
    key      = 'settings',
    rateLimit = 0,
    allow    = function(src) return allowed[src] == true end,
    configOk = function() return configFine end,
    payload  = function(src) return { isAdmin = src == 7 } end,
})

local panel = opengateClient.panel({
    key      = 'settings',
    onOpen   = function(data) opened[#opened + 1] = data end,
    onDenied = function() deniedCount = deniedCount + 1 end,
    onBroken = function() brokenCount = brokenCount + 1 end,
})

ask(panel, 7)
assert(#opened == 1, 'an allowed player with a sound config gets the panel')
assert(opened[1] and opened[1].isAdmin == true, 'and the payload travels with the reply')
assert(deniedCount == 0 and brokenCount == 0, 'and neither of the other two fires')
assert(#toServer == 1 and toServer[1] == BASE .. ':request',
    'the client asked exactly once, on the name the server registered')

--  Denial, and the three-way split

ask(panel, 9)
assert(#opened == 1 and deniedCount == 1 and brokenCount == 0,
    'a player with no access is denied and the panel does not open')

-- ORDER. A broken config is NOT a permissions problem, and telling the
-- player it is sends them to the wrong person. So the config check runs first
-- even for a player who would have been denied anyway — otherwise the server
-- with a broken config answers "you are not allowed" to everybody and nobody
-- ever learns the config is the problem.
configFine = false
ask(panel, 9)
assert(brokenCount == 1 and deniedCount == 1,
    'a denied player on a broken server is told the config is broken, not that they are denied')
ask(panel, 7)
assert(brokenCount == 2 and #opened == 1,
    'and an allowed player does not get in while the config is broken')
configFine = true

-- A configOk that throws is not a working config.
local throwingConfig = false
opengate.serve({
    key      = 'throwcfg',
    rateLimit = 0,
    allow    = function() return true end,
    configOk = function() if throwingConfig then error('spec not loaded') end; return true end,
})
local cfgBroken, cfgOpen = 0, 0
local cfgPanel = opengateClient.panel({
    key      = 'throwcfg',
    onOpen   = function() cfgOpen = cfgOpen + 1 end,
    onDenied = function() end,
    onBroken = function() cfgBroken = cfgBroken + 1 end,
})
throwingConfig = true
cfgPanel:open()
source = 7; handlers['tRadar:tlib:opengate:throwcfg:request'](); source = nil
assert(cfgBroken == 1 and cfgOpen == 0, 'a throwing configOk reports broken')

--  allow is required, and a missing one denies everyone
-- The alternative — a missing option quietly meaning "open" — is how a gate
-- meant to restrict something ends up granting it. Loud at boot, denying at
-- runtime, and NOT fatal: refusing to load would take the whole resource down
-- over one panel.

capture()
opengate.serve({ key = 'noallow', rateLimit = 0 })
release()
assert(said('DENYING EVERYONE'), 'a missing allow says so at boot')
assert(said('noallow'), 'and names the panel')

local noAllowOpen, noAllowDenied = 0, 0
local noAllowPanel = opengateClient.panel({
    key      = 'noallow',
    onOpen   = function() noAllowOpen = noAllowOpen + 1 end,
    onDenied = function() noAllowDenied = noAllowDenied + 1 end,
})
noAllowPanel:open()
source = 7; handlers['tRadar:tlib:opengate:noallow:request'](); source = nil
assert(noAllowOpen == 0 and noAllowDenied == 1, 'and denies every player at runtime')

-- "Open to everyone" has to be written down, which is greppable in a way a
-- missing option is not.
opengate.serve({ key = 'everyone', rateLimit = 0, allow = function() return true end })
local everyoneOpen = 0
local everyonePanel = opengateClient.panel({
    key      = 'everyone',
    onOpen   = function() everyoneOpen = everyoneOpen + 1 end,
    onDenied = function() end,
})
everyonePanel:open()
source = 123; handlers['tRadar:tlib:opengate:everyone:request'](); source = nil
assert(everyoneOpen == 1, 'allow = function() return true end opens for anyone')

-- An allow that throws denies. tAFK own handler documents the reason: an export
-- that throws inside a net handler is a console traceback and a dropped event,
-- and "the panel did not open" is the safe way for that to land.
opengate.serve({ key = 'throwallow', rateLimit = 0, allow = function() error('core missing') end })
local taOpen, taDenied = 0, 0
local taPanel = opengateClient.panel({
    key      = 'throwallow',
    onOpen   = function() taOpen = taOpen + 1 end,
    onDenied = function() taDenied = taDenied + 1 end,
})
capture()
taPanel:open()
source = 7; handlers['tRadar:tlib:opengate:throwallow:request'](); source = nil
release()
assert(taOpen == 0 and taDenied == 1, 'a throwing allow denies')
assert(said('errored'), 'and the error is printed rather than swallowed')

-- A payload builder that throws still OPENS. The payload is draw hints; losing
-- them is a worse panel, not a denial, and every capability it names is
-- re-checked server-side anyway.
opengate.serve({
    key       = 'throwpayload',
    rateLimit = 0,
    allow     = function() return true end,
    payload   = function() error('bad hint') end,
})
local tpOpen = 0
local tpPanel = opengateClient.panel({
    key      = 'throwpayload',
    onOpen   = function(data) tpOpen = tpOpen + 1; assert(data == nil, 'and with no payload') end,
    onDenied = function() end,
})
capture()
tpPanel:open()
source = 7; handlers['tRadar:tlib:opengate:throwpayload:request'](); source = nil
release()
assert(tpOpen == 1, 'a throwing payload builder does not block the panel')

--  Every reply is server-only
-- Closes a real gap: tRadar guards tradar:openSettings and tradar:configBroken
-- and does NOT guard tradar:accessDenied, three lines further down the file.

local beforeOpen, beforeDenied, beforeBroken = #opened, deniedCount, brokenCount
capture()
for _, suffix in ipairs({ ':open', ':denied', ':broken' }) do
    -- `#spoofs` rather than ipairs, which would stop at the nil — and the nil
    -- is the case that matters most: it is what passes a guard written
    -- `if source and source ~= 65535 then return end`.
    local spoofs = { 1, 0, '65535', 65534, nil }
    for i = 1, 5 do
        source = spoofs[i]
        handlers[BASE .. suffix]({ isAdmin = true })
        source = nil
    end
end
release()
assert(#opened == beforeOpen, 'a local trigger cannot open the panel')
assert(deniedCount == beforeDenied, 'nor fake a denial')
assert(brokenCount == beforeBroken, 'nor fake a broken config')

--  reopen() — the rate-limit trap, named
-- tRadar/client/cl_settings.lua:718-728: the request path is rate-limited to one
-- call per second on the server and drops the extra SILENTLY, so an admin who
-- opened the 3D prop editor and cancelled straight away would get nothing back.

ratelimit.reset()
local serverCalls = 0
opengate.serve({
    key     = 'limited',
    allow   = function() return true end,
    payload = function() return { isAdmin = true } end,
})
local limOpened = {}
local limPanel = opengateClient.panel({
    key      = 'limited',
    onOpen   = function(data) limOpened[#limOpened + 1] = data end,
    onDenied = function() end,
})

local LIM = 'tRadar:tlib:opengate:limited'
local function askLimited(src)
    serverCalls = serverCalls + 1
    limPanel:open()
    source = src
    handlers[LIM .. ':request']()
    source = nil
end

now = 50000
askLimited(7)
assert(#limOpened == 1, 'the first open goes through')

-- This is the trap, reproduced: the server default floor is 1000 ms and the
-- second request inside it is dropped with no reply at all.
askLimited(7)
assert(#limOpened == 1, 'a second request inside the floor gets NOTHING back')

-- reopen() is the way out, and it makes no round trip.
local asksBefore = #toServer
assert(limPanel:reopen() == true, 'reopen replays the grant')
assert(#limOpened == 2, 'and the panel is open again')
assert(limOpened[2] and limOpened[2].isAdmin == true,
    'with the payload the server last sent, not a fresh one')
assert(#toServer == asksBefore, 'and without asking the server')

-- It replays a grant; it cannot create one. With no remembered answer it
-- does nothing and says so once — otherwise it would be a way to open a panel
-- the server never agreed to.
opengate.serve({ key = 'never', rateLimit = 0, allow = function() return false end })
local neverOpen = 0
local neverPanel = opengateClient.panel({
    key      = 'never',
    onOpen   = function() neverOpen = neverOpen + 1 end,
    onDenied = function() end,
})
capture()
assert(neverPanel:reopen() == false, 'reopen with no previous open is refused')
assert(neverPanel:reopen() == false, 'and stays refused')
release()
assert(neverOpen == 0, 'and never calls onOpen')
assert(said('reopen() with no previous open'), 'and says why')

-- Denied does not create a grant either.
neverPanel:open()
source = 7; handlers['tRadar:tlib:opengate:never:request'](); source = nil
capture()
assert(neverPanel:reopen() == false, 'a denial is not a grant to replay')
release()
assert(neverOpen == 0, 'and the panel still never opened')

--  onBroken is optional, and a missing one is NEVER routed to onDenied
-- Routing it would be exactly the mistake the two states exist to avoid: it
-- would send the player to the wrong person while looking like it worked.

opengate.serve({
    key       = 'nobroken',
    rateLimit = 0,
    allow     = function() return true end,
    configOk  = function() return false end,
})
local nbDenied, nbOpen = 0, 0
local nbPanel = opengateClient.panel({
    key      = 'nobroken',
    onOpen   = function() nbOpen = nbOpen + 1 end,
    onDenied = function() nbDenied = nbDenied + 1 end,
})
capture()
nbPanel:open()
source = 7; handlers['tRadar:tlib:opengate:nobroken:request'](); source = nil
assert(nbDenied == 0, 'a broken config is NOT reported as a denial')
assert(nbOpen == 0, 'and certainly does not open the panel')
assert(said('no `onBroken` handler'), 'the missing handler is named in the console')
-- Once, not per press.
nbPanel:open()
source = 7; handlers['tRadar:tlib:opengate:nobroken:request'](); source = nil
release()
local n = 0
for _, l in ipairs(lines) do if l:find('no `onBroken` handler', 1, true) then n = n + 1 end end
assert(n == 1, 'and said once, not per press')

--  Validation

-- onDenied is REQUIRED while onBroken is not: every panel can be denied, and a
-- denial the player is never told about is the defect where they press the key,
-- nothing happens, and they report the resource as broken.
assert(not pcall(opengateClient.panel, { key = 'v1', onOpen = function() end }),
    'a panel with no onDenied is refused')
assert(not pcall(opengateClient.panel, { key = 'v2', onDenied = function() end }),
    'a panel with no onOpen is refused')
assert(not pcall(opengateClient.panel,
    { key = 'v3', onOpen = function() end, onDenied = function() end, onBroken = 'x' }),
    'a non-function onBroken is refused')
assert(not pcall(opengateClient.panel,
    { key = '', onOpen = function() end, onDenied = function() end }),
    'an empty key is refused')

assert(not pcall(opengate.serve, { key = '', allow = function() return true end }),
    'an empty key is refused on the server too')
assert(not pcall(opengate.serve, { key = 'v4', allow = function() end, configOk = 'yes' }),
    'a non-function configOk is refused rather than read as truthy')
assert(not pcall(opengate.serve, { key = 'v5', allow = function() end, payload = 'yes' }),
    'a non-function payload is refused')

print('opengate: ok')
