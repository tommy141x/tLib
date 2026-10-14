-- tLib's side of the diagnostics transport: the net events, and the consent
-- broadcast. Lua rather than the Node bundle because every net event in tLib is
-- registered from Lua; the event names are duplicated from
-- shared/imports/telemetry/shared.lua because no VM loads both files, and
-- tests/unit/telemetry-wiring.test.ts pins them equal.
-- Design notes: docs/internal/telemetry-consent.md.
--

local log = Logger.create('tLib/telemetry')

local INGEST_EVENT = 'tlib:diag:ingest'
local CONSENT_EVENT = 'tlib:diag:consent'
local CONSENT_REQUEST_EVENT = 'tlib:diag:consentPlease'

--- Minimum milliseconds between one player's batches. The NUI and the consumer
--- client thread each flush every 15 s, so a 5 s floor accommodates both. A
--- floor, not a bucket: there is no legitimate burst to bank allowance for.
local INGEST_INTERVAL_MS = 5000

local lastIngest = {}

AddEventHandler('playerDropped', function()
    local src = source
    if src then lastIngest[src] = nil end
end)

--- The answer a client is told: only the three fields a client needs. The
--- convar's value, the queue depth and the breaker state are operator-facing
--- and stay server-side.
local function clientConsent()
    local ok, raw = pcall(function() return exports['tLib']:DiagConsent() end)
    if not ok or type(raw) ~= 'string' or raw == '' then
        return { enabled = false, source = 'default', locked = false }
    end
    local decoded
    ok, decoded = pcall(json.decode, raw)
    if not ok or type(decoded) ~= 'table' then
        return { enabled = false, source = 'default', locked = false }
    end
    return {
        enabled = decoded.enabled == true,
        source = decoded.source or 'default',
        locked = decoded.locked == true,
    }
end

--- Tell one player, or everyone.
---@param target number|nil  nil broadcasts
function TelemetryBroadcastConsent(target)
    local payload = clientConsent()
    TriggerClientEvent(CONSENT_EVENT, target or -1, payload)
end

RegisterNetEvent(INGEST_EVENT, function(payload)
    local src = source
    if not src or src <= 0 then return end

    -- The floor is applied BEFORE the json.decode, the only expensive thing
    -- here: a limiter behind the parse still pays the parse per refused batch.
    local now = GetGameTimer()
    local last = lastIngest[src]
    if last and (now - last) < INGEST_INTERVAL_MS then return end
    lastIngest[src] = now

    if type(payload) ~= 'string' or payload == '' then return end
    -- A client-supplied string with a hard ceiling. An oversized body is
    -- dropped unparsed: a client that sends one is not running our collector.
    if #payload > 262144 then return end

    -- The bundle re-checks consent, re-limits per client and validates every
    -- dimension. Nothing here trusts the client beyond "a bounded string".
    pcall(function() exports['tLib']:DiagIngest(src, payload) end)
end)

RegisterNetEvent(CONSENT_REQUEST_EVENT, function()
    local src = source
    if not src or src <= 0 then return end
    -- Same floor, same bucket: asking is cheaper than ingesting but it is
    -- still a round trip a client controls.
    local now = GetGameTimer()
    local last = lastIngest[src]
    if last and (now - last) < INGEST_INTERVAL_MS then return end
    lastIngest[src] = now
    TelemetryBroadcastConsent(src)
end)

-- A player who connects after the resource started gets the answer unasked, so
-- the common case needs no round trip.
AddEventHandler('playerJoining', function()
    local src = source
    if src and src > 0 then TelemetryBroadcastConsent(src) end
end)

CreateThread(function()
    -- `StudioApi.baseUrl()` is the single definition of the studio host and its
    -- normalisation, and it is Lua in tLib's shared VM. Pushing the resolved
    -- value in keeps the bundle from carrying a second copy. Re-pushed on a slow
    -- loop because the convar is a dev switch meant to change mid-session.
    while true do
        pcall(function() exports['tLib']:DiagSetBaseUrl(StudioApi.baseUrl()) end)
        Wait(60000)
    end
end)

-- The consent API. `SetTelemetryConsent` is the one a consumer must call, not
-- the bundle's `DiagSetConsent`: this wrapper is what tells already-connected
-- clients. Nothing in tLib calls either, and no tLib surface may -- the hub's
-- index is public and unauthenticated. Not permission-gated here either; a
-- consumer must gate it at its own call site.
-- See docs/internal/telemetry-consent.md.
--   local c = json.decode(exports['tLib']:GetTelemetryConsent())
--   -- { enabled, source, locked, convar, convarValue, queued, transport }
--   local r = json.decode(exports['tLib']:SetTelemetryConsent(true))
--   -- { ok = true, consent = {...} }  or
--   -- { ok = false, reason = 'locked'|'write-failed', detail = '...' }
--

Platform.export('tLib', 'GetTelemetryConsent', function()
    local ok, raw = pcall(function() return exports['tLib']:DiagConsent() end)
    if ok and type(raw) == 'string' and raw ~= '' then return raw end
    return json.encode({
        enabled = false, source = 'default', locked = false,
        convar = 'tlib_telemetry', convarValue = '',
    })
end)

Platform.export('tLib', 'SetTelemetryConsent', function(enabled)
    local ok, raw = pcall(function() return exports['tLib']:DiagSetConsent(enabled == true) end)
    if not ok or type(raw) ~= 'string' then
        return json.encode({ ok = false, reason = 'threw', detail = tostring(raw) })
    end
    local decoded
    local parsed
    parsed, decoded = pcall(json.decode, raw)
    if parsed and type(decoded) == 'table' and decoded.ok then
        TelemetryBroadcastConsent(nil)
        log(('telemetry %s through SetTelemetryConsent'):format(enabled and 'ENABLED' or 'disabled'), 2)
    end
    return raw
end)

-- The operator-facing view. Deliberately a console command, not a chat one:
-- every question it answers is an operator's, and the server console is the
-- copy that survives the caller disconnecting.
RegisterCommand('tlib_telemetry_status', function(src)
    local ok, raw = pcall(function() return exports['tLib']:DiagConsent() end)
    if not ok or type(raw) ~= 'string' then
        log('telemetry status unavailable: the bundle did not answer', 4)
        return
    end
    local decoded
    ok, decoded = pcall(json.decode, raw)
    if not ok or type(decoded) ~= 'table' then
        log('telemetry status unavailable: unparseable answer', 4)
        return
    end
    local lines = {
        ('enabled: %s'):format(tostring(decoded.enabled)),
        ('decided by: %s%s'):format(
            tostring(decoded.source),
            decoded.locked and (' (convar "' .. tostring(decoded.convarValue) .. '" — the stored switch is ignored)') or ''
        ),
    }
    if type(decoded.queued) == 'table' then
        lines[#lines + 1] = ('queued: %s events'):format(tostring(decoded.queued.events))
    end
    if type(decoded.transport) == 'table' then
        if decoded.transport.eventsStopped then
            lines[#lines + 1] = ('analytics sink stopped: %s'):format(decoded.transport.eventsStopped)
        end
    end
    for _, line in ipairs(lines) do
        print('[tLib/telemetry] ' .. line)
        if src and src > 0 then TriggerClientEvent('chat:addMessage', src, { args = { 'tLib', line } }) end
    end
end, true)
