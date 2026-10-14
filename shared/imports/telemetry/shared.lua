--[[
    tLib/shared/imports/telemetry — opt-in diagnostics (shared half).
    One file with a branch, not shared+client: imports.lua concatenates them.
    Design notes: docs/internal/telemetry-consent.md and
    docs/internal/telemetry-wire-contract.md.

]]

local Telemetry = {}

-- Names

Telemetry.CONVAR = 'tlib_telemetry'

--- Client -> server. One name for every consumer: net events are global by name
--- and tLib's server VM is the only registrant.
Telemetry.INGEST_EVENT = 'tlib:diag:ingest'

--- Server -> client, on join and on every consent change.
Telemetry.CONSENT_EVENT = 'tlib:diag:consent'

--- Client -> server, asked once at boot by a consumer that started late.
Telemetry.CONSENT_REQUEST_EVENT = 'tlib:diag:consentPlease'

--- The NUI callback `installDiagnostics` posts to. Mirrors DIAG_NUI_CALLBACK in
--- shared/ts/telemetry/collect.ts.
Telemetry.NUI_CALLBACK = 'tlib:diagnostics'

-- tWeb's names, not ours. An undeclared event name is refused PER EVENT and
-- counted on its dashboard, which is invisible from here.
Telemetry.EVENT_ERROR = 'tlib.error_reported'
Telemetry.EVENT_WARNING = 'tlib.warning_reported'
Telemetry.EVENT_CRASH = 'tlib.crash_reported'
Telemetry.EVENT_SLOW = 'tlib.slow_operation'
Telemetry.EVENT_ENVIRONMENT = 'tlib.environment_reported'

--- Dimension caps, tWeb's. A longer value is truncated here rather than there.
Telemetry.CAP_RESOURCE = 32
Telemetry.CAP_VERSION = 32
Telemetry.CAP_CODE = 64
Telemetry.CAP_LOCATION = 160

-- The charset

--- Player and machine identifier shapes, blanked before ANY value becomes a
--- dimension. The ingest charset admits a FiveM identifier verbatim, so the
--- tWeb side refuses those shapes and a leak becomes silent data loss here.
--- See docs/internal/telemetry-scrubbing.md.
local IDENTIFIER_PATTERNS = {
    'steam[:%.]%x%x%x%x%x%x+',
    'license%d?[:%.]%x%x%x%x%x%x+',
    'discord[:%.]%d%d%d%d%d%d+',
    'fivem[:%.]%w%w%w%w%w%w+',
    'live[:%.]%x%x%x%x%x%x+',
    'xbl[:%.]%x%x%x%x%x%x+',
    'ip[:%.]%d+%.%d+%.%d+%.%d+',
    -- A bare 64-bit Steam id or a Discord snowflake. 15 digits MINIMUM, which
    -- keeps a 13-digit epoch-millisecond timestamp out: a rule that ate those
    -- would redact every duration in every message.
    '%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d+',
    -- IPv4 in any separator form a naive slugger produces.
    '%d+[%._%-]%d+[%._%-]%d+[%._%-]%d+',
    -- A home path, matched on SHAPE. The separator class includes the real
    -- slashes as well as the mapped forms, which is not redundant with
    -- `scrub`'s path rule: `slug` calls only this, and without them a Windows
    -- home path slugged through with the account name intact. Long brackets
    -- because the bracketed-slash class is an invalid escape in Lua 5.4 and the
    -- file then does not load at all.
    [=[%a:?[\/%._%-]?Users[\/%._%-][^%s\/%.:_%-]+]=],
    [=[home[\/%._%-][^%s\/%.:_%-]+]=],
}

--- Blank every identifier shape. Exported because `slug` and the free-text
--- scrubber both run it. The replacement is the bare word `redacted`: brackets
--- are not in the dimension charset, and a refused marker costs the event.
---@param text any
---@return string
function Telemetry.scrubIdentifiers(text)
    if type(text) ~= 'string' then return '' end
    local out = text
    for _, pattern in ipairs(IDENTIFIER_PATTERNS) do
        out = out:gsub(pattern, 'redacted')
    end
    return out
end

--- tWeb's `DIMENSION_ID_PATTERN`: `^[A-Za-z0-9._:-]+$`. No space, slash, quote
--- or `+`. Identifiers are scrubbed FIRST -- a naive slugger launders a player
--- identifier into a store that cannot delete a row. A message or stack cannot
--- be a dimension at all; a stack travels as a top-level `stack` field.
---@param value any
---@param maxLength number|nil
---@return string  '' when nothing survives
function Telemetry.slug(value, maxLength)
    if type(value) ~= 'string' then return '' end
    local out = Telemetry.scrubIdentifiers(value):lower():gsub('^%s+', ''):gsub('%s+$', '')
    out = out:gsub('[^a-z0-9%._:%-]+', '-')
    out = out:gsub('%-%-+', '-')
    out = out:gsub('^[%-%.:]+', ''):gsub('[%-%.:]+$', '')
    out = out:sub(1, maxLength or 64)
    -- Re-trim: the sub() can land on a separator.
    out = out:gsub('[%-%.:]+$', '')
    if out == '' then return '' end
    if out:match('^[A-Za-z0-9._:%-]+$') then return out end
    return ''
end

--- A version, with semver build metadata MAPPED rather than dropped: `+` is not
--- in the charset, so `1.14.2-rc.3+ab12cd34` is refused at 21 characters, which
--- is nothing to do with any length cap. tWeb's instruction is `+` -> `.`.
---@param value any
---@return string
function Telemetry.versionSlug(value)
    if type(value) ~= 'string' then return '' end
    return Telemetry.slug((value:gsub('%+', '.')), Telemetry.CAP_VERSION)
end

--- A file-and-line or a config key. Path separators are not in the charset, so
--- `client/cl_radio.lua:218` becomes `client.cl_radio.lua:218`. Separate from
--- `slug` because mapping to `.` is right for a path and wrong for prose.
---@param value any
---@param maxLength number|nil
---@return string
function Telemetry.pathSlug(value, maxLength)
    if type(value) ~= 'string' then return '' end
    return Telemetry.slug((value:gsub([=[[\/]+]=], '.')), maxLength or Telemetry.CAP_LOCATION)
end

-- The fingerprint

--- FNV-1a, 32-bit, as 8 LOWERCASE hex characters. The alphabet is contract:
--- tWeb's scrubber refuses a mixed-case 32-character token as a credential
--- shape. The shift-and-add arithmetic is contract too -- it stays exact in both
--- Lua 5.4 and JavaScript, where a multiply by the FNV prime would not, and the
--- two sides would silently stop grouping together. Not a cryptographic hash.
---@param text string
---@return string
function Telemetry.fnv1a(text)
    local h = 0x811c9dc5
    for i = 1, #text do
        h = h ~ (text:byte(i) & 0xff)
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) & 0xFFFFFFFF
    end
    return string.format('%08x', h)
end

--- The `stackHash` dimension for one Lua-side fault: the SITE plus the error
--- NAME, deliberately not the message. A message interpolates a count or a name
--- more often than not, and fingerprinting that makes every occurrence its own
--- group.
---@param name string
---@param site string|nil
---@return string
function Telemetry.fingerprint(name, site)
    return Telemetry.fnv1a(('%s|%s'):format(tostring(name), tostring(site or '')))
end

-- Scrubbing

local SECRET_WORDS = {
    'token', 'access_token', 'refresh_token', 'api_key', 'apikey', 'key',
    'secret', 'password', 'passwd', 'pass', 'auth', 'authorization',
    'session', 'sessionid', 'sid', 'cookie', 'credential', 'credentials',
    'signature', 'sig', 'license', 'licence',
}

Telemetry.REDACTED = '[redacted]'

--- Values this install knows to be identifying. Registered at boot by
--- client.lua (the player's own name) and by a consumer that knows more. Sorted
--- longest-first, and the shortest-length floor is load-bearing: a player called
--- `Al` would otherwise turn every `Already` into `[redacted]ready`.
local identifying = {}
local MIN_IDENTIFYING = 3

---@param value any
---@return boolean taken
function Telemetry.registerScrubValue(value)
    if type(value) ~= 'string' then return false end
    local v = value:gsub('^%s+', ''):gsub('%s+$', '')
    if #v < MIN_IDENTIFYING then return false end
    for _, existing in ipairs(identifying) do
        if existing == v then return true end
    end
    identifying[#identifying + 1] = v
    table.sort(identifying, function(a, b) return #a > #b end)
    return true
end

--- Tests only.
function Telemetry.resetScrubValues()
    identifying = {}
end

--- Blank credential-shaped values, home-directory paths, and anything
--- registered as the player's. The path rule replaces only the HOME segment:
--- the file and line after it are the diagnostically useful half.
---@param text any
---@return string
function Telemetry.scrub(text)
    if type(text) ~= 'string' then return '' end
    local out = text

    for _, value in ipairs(identifying) do
        out = out:gsub(value:gsub('(%W)', '%%%1'), Telemetry.REDACTED)
    end

    out = out:gsub('(%a):[\\/]Users[\\/][^\\/%s"\']+', '<home>')
    out = out:gsub('/home/[^/%s"\']+', '<home>')
    out = out:gsub('/Users/[^/%s"\']+', '<home>')

    for _, word in ipairs(SECRET_WORDS) do
        -- The value is blanked and the key kept, because the key is the half
        -- that says what was redacted.
        out = out:gsub(('(%s%%s*[:=]%%s*)[^%%s,;}"\']+'):format(word), '%1' .. Telemetry.REDACTED)
        out = out:gsub(('([%%?&#;]%s=)[^&#%%s"\']+'):format(word), '%1' .. Telemetry.REDACTED)
    end
    out = out:gsub('[Bb]earer%s+[%w%-%._~%+/=]+', 'bearer ' .. Telemetry.REDACTED)
    out = out:gsub('eyJ[%w%-_]*%.[%w%-_]+%.[%w%-_]+', Telemetry.REDACTED)

    return out
end

-- timed()

Telemetry.SAMPLE_WINDOW = 64
Telemetry.THRESHOLD_COOLDOWN_MS = 60000
Telemetry.P95_INTERVAL_MS = 300000

--- How close to its budget an operation must habitually run before the p95
--- channel reports it. Without a fraction the channel is dead code: comparing
--- the p95 against the threshold itself can only fire once 5% of the window has
--- already breached, which the threshold channel reports sooner. Mirrors
--- P95_BUDGET_FRACTION in shared/ts/telemetry/timed.ts.
Telemetry.P95_BUDGET_FRACTION = 0.8

--- p95 by nearest rank on a sorted copy, not linear interpolation: these are
--- latencies compared against a budget, and an interpolated p95 is a value that
--- was never observed. Mirrors `p95` in shared/ts/telemetry/timed.ts.
---@param samples number[]
---@return number
function Telemetry.p95(samples)
    local n = #samples
    if n == 0 then return 0 end
    local sorted = {}
    for i = 1, n do sorted[i] = samples[i] end
    table.sort(sorted)
    local index = math.max(1, math.ceil(0.95 * n))
    return sorted[index]
end

--- A timer set over one clock. `GetGameTimer()` is integer milliseconds, so an
--- operation faster than 1 ms measures as 0 and a p95 of 0 is correct. Do not
--- instrument anything whose budget is a few milliseconds on this side.
---@param opts table  { now = function, report = function(outlier) }
function Telemetry.createTimers(opts)
    assert(type(opts) == 'table', 'tlib.telemetry.createTimers: opts must be a table')
    local now = opts.now or function() return (GetGameTimer and GetGameTimer()) or 0 end
    local report = opts.report
    assert(type(report) == 'function', 'tlib.telemetry.createTimers: report must be a function')
    local cooldown = opts.thresholdCooldownMs or Telemetry.THRESHOLD_COOLDOWN_MS
    local p95Interval = opts.p95IntervalMs or Telemetry.P95_INTERVAL_MS

    local ops = {}
    local timers = {}

    local function stateFor(operation, thresholdMs)
        local s = ops[operation]
        if not s then
            s = {
                samples = {}, cursor = 1, filled = false, maxMs = 0, suppressed = 0,
                -- `-math.huge`, not 0 and not now(). `now()` arms the cooldown
                -- and swallows the session's first breach; `0` only looks like a
                -- fix, since `now - 0 >= 60000` is false for the first minute of
                -- a boot -- exactly where a slow boot path lives.
                lastThresholdAt = -math.huge, lastP95At = -math.huge,
            }
            ops[operation] = s
        end
        s.thresholdMs = thresholdMs
        return s
    end

    --- Record a duration measured elsewhere.
    function timers.record(operation, thresholdMs, durationMs)
        if type(durationMs) ~= 'number' or durationMs < 0 then return end
        local s = stateFor(operation, thresholdMs)
        local t = now()

        if #s.samples < Telemetry.SAMPLE_WINDOW then
            s.samples[#s.samples + 1] = durationMs
            if #s.samples == Telemetry.SAMPLE_WINDOW then s.filled = true end
        else
            s.samples[s.cursor] = durationMs
            s.cursor = (s.cursor % Telemetry.SAMPLE_WINDOW) + 1
        end
        if durationMs > s.maxMs then s.maxMs = durationMs end

        if durationMs >= thresholdMs then
            if (t - s.lastThresholdAt) >= cooldown then
                s.lastThresholdAt = t
                local suppressed = s.suppressed
                s.suppressed = 0
                report({
                    operation = operation, kind = 'threshold',
                    durationMs = math.floor(durationMs + 0.5), sampleCount = 1,
                    maxMs = math.floor(s.maxMs + 0.5), suppressed = suppressed,
                    thresholdMs = thresholdMs,
                })
            else
                s.suppressed = s.suppressed + 1
            end
            return
        end

        if not s.filled then return end
        if (t - s.lastP95At) < p95Interval then return end
        local value = Telemetry.p95(s.samples)
        if value < (thresholdMs * Telemetry.P95_BUDGET_FRACTION) then return end
        s.lastP95At = t
        report({
            operation = operation, kind = 'p95',
            durationMs = math.floor(value + 0.5), sampleCount = #s.samples,
            maxMs = math.floor(s.maxMs + 0.5), suppressed = 0,
            thresholdMs = thresholdMs,
        })
    end

    --- Time a call. Returns whatever it returned. pcall'd, so a THROWING call is
    --- still timed and the error still propagates: the slowest call on a machine
    --- in trouble is frequently the one that then throws.
    function timers.timed(operation, thresholdMs, fn)
        local start = now()
        local ok, a, b, c = pcall(fn)
        timers.record(operation, thresholdMs, now() - start)
        if not ok then error(a, 2) end
        return a, b, c
    end

    function timers.reset() ops = {} end

    return timers
end

-- The side-specific half.

local isServer = type(IsDuplicityVersion) == 'function' and IsDuplicityVersion()

--- The consent answer, cached. A cache, not an authority -- the server decides
--- and re-checks before every POST. See docs/internal/telemetry-consent.md.
local consentCache = { enabled = false, source = 'default', locked = false }

--- Ask tLib for the real answer. Server VMs only. pcall'd at two levels: an
--- export that throws returns nil and the real error vanishes.
local function refreshConsentFromTLib()
    if not isServer then return end
    local ok, raw = pcall(function() return exports['tLib']:DiagConsent() end)
    if not ok or type(raw) ~= 'string' or raw == '' then return end
    local decoded
    ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == 'table' and type(decoded.enabled) == 'boolean' then
        consentCache = decoded
    end
end

--- The cached answer, plus `locked`, for a consumer that wants to render it.
--- Cached on both sides rather than asked per event: that is a cross-VM round
--- trip on a path a fault storm walks sixty times a second.
---@return table  { enabled, source, locked }
function Telemetry.consent()
    return consentCache
end

--- The consuming resource's name, or `''` outside a FiveM runtime. Guarded like
--- every file-scope native call here: a Lua test harness has no
--- GetCurrentResourceName, and an unguarded call made `warn` fatal under
--- fengari, which exits zero on an unhandled error.
local function resourceName()
    if type(GetCurrentResourceName) ~= 'function' then return '' end
    return GetCurrentResourceName() or ''
end

local function context(surface)
    local res = resourceName()
    return {
        resource = Telemetry.slug(res, Telemetry.CAP_RESOURCE),
        resourceVersion = Telemetry.versionSlug(
            res ~= '' and type(GetResourceMetadata) == 'function'
                and (GetResourceMetadata(res, 'version', 0) or '')
                or ''
        ),
        installId = '',
        surface = surface,
    }
end

-- Dedupe, same window and reason as the NUI collector's: a fault inside a
-- per-frame thread repeats sixty times a second, and without dedupe the first
-- broken install saturates tLib's server ring, evicting every other player's.
local DEDUPE_WINDOW_MS = 120000
local lastSeen = {}

local function admit(fp)
    local now = (GetGameTimer and GetGameTimer()) or 0
    for key, seen in pairs(lastSeen) do
        if (now - seen) > DEDUPE_WINDOW_MS then lastSeen[key] = nil end
    end
    if lastSeen[fp] and (now - lastSeen[fp]) < DEDUPE_WINDOW_MS then return false end
    lastSeen[fp] = now
    return true
end

-- Sending

local pendingEvents = {}
local MAX_PENDING = 32

--- The one path out of this VM. Asks the cache and then DROPS on the floor:
--- nothing is buffered while consent is off, not even locally.
local function send()
    if #pendingEvents == 0 then return end
    local batch = json.encode({
        context = context(isServer and 'server' or 'client'),
        events = pendingEvents,
    })
    pendingEvents = {}
    if isServer then
        pcall(function() exports['tLib']:DiagIngest(0, batch) end)
    else
        pcall(TriggerServerEvent, Telemetry.INGEST_EVENT, batch)
    end
end

local function queue(event)
    if not consentCache.enabled then return end
    pendingEvents[#pendingEvents + 1] = event
    while #pendingEvents > MAX_PENDING do table.remove(pendingEvents, 1) end
end

function Telemetry.flush() send() end

-- The reporting API

--- A fault in OUR code that we caught. `site` becomes the `location` dimension
--- through `pathSlug`.
---@param err any
---@param site string|nil
---@param kind string|nil  one of tWeb's five error kinds; defaults to lua_error
---@return string stackHash
function Telemetry.error(err, site, kind)
    local message = Telemetry.scrub(tostring(err))
    local name = 'LuaError'
    local file, line = message:match('^@?([%w%._/%-]+%.lua):(%d+):')
    if file then name = ('%s:%s'):format(file, line) end
    local hash = Telemetry.fingerprint(name, site)
    if not admit(hash) then return hash end
    queue({
        event = Telemetry.EVENT_ERROR,
        at = math.floor(os.time() * 1000),
        dimensions = {
            errorKind = kind or 'lua_error',
            surface = isServer and 'server' or 'client',
            errorCode = Telemetry.pathSlug(name, Telemetry.CAP_CODE),
            location = Telemetry.pathSlug(site or '', Telemetry.CAP_LOCATION),
            stackHash = hash,
        },
        measures = {},
        stack = message:sub(1, 4000),
    })
    return hash
end

--- A fault we noticed and handled. `code` is required and is the grouping key;
--- there is no message field in the contract for a warning at all, so a message
--- is printed locally and not sent.
---@param code string
---@param kind string|nil  one of tWeb's five warning kinds; defaults to unknown
---@param message string|nil
function Telemetry.warn(code, kind, message)
    local id = Telemetry.slug(code, Telemetry.CAP_CODE)
    if id == '' then return end
    local hash = Telemetry.fingerprint('warning:' .. id)
    if not admit(hash) then return end
    if message then
        print(('^3[%s] %s: %s^0'):format(resourceName(), id, Telemetry.scrub(message)))
    end
    queue({
        event = Telemetry.EVENT_WARNING,
        at = math.floor(os.time() * 1000),
        dimensions = {
            warningKind = kind or 'unknown',
            surface = isServer and 'server' or 'client',
            warningCode = id,
        },
        measures = {},
    })
end

--- The shared outlier timer, wired to this VM's clock and this VM's queue.
local _timers = Telemetry.createTimers({
    report = function(outlier)
        queue({
            event = Telemetry.EVENT_SLOW,
            at = math.floor(os.time() * 1000),
            dimensions = {
                operation = Telemetry.slug(outlier.operation, Telemetry.CAP_CODE),
                surface = isServer and 'server' or 'client',
            },
            measures = {
                durationMs = outlier.durationMs,
                thresholdMs = outlier.thresholdMs,
            },
        })
    end,
})

--- Time a call, reporting only outliers.
function Telemetry.timed(operation, thresholdMs, fn)
    return _timers.timed(operation, thresholdMs, fn)
end

function Telemetry.record(operation, thresholdMs, durationMs)
    _timers.record(operation, thresholdMs, durationMs)
end

-- Wiring

if not isServer and type(RegisterNetEvent) == 'function' then
    RegisterNetEvent(Telemetry.CONSENT_EVENT, function(payload)
        if type(payload) ~= 'table' then return end
        consentCache = {
            enabled = payload.enabled == true,
            source = payload.source or 'default',
            locked = payload.locked == true,
        }
        if type(SendNUIMessage) == 'function' then
            pcall(SendNUIMessage, { action = 'tlib:diag:consent', data = consentCache })
        end
    end)

    if type(CreateThread) == 'function' then
        CreateThread(function()
            Wait(2000)
            pcall(TriggerServerEvent, Telemetry.CONSENT_REQUEST_EVENT)
            if type(GetPlayerName) == 'function' and type(PlayerId) == 'function' then
                local ok, name = pcall(GetPlayerName, PlayerId())
                if ok then Telemetry.registerScrubValue(name) end
            end
            while true do
                Wait(15000)
                send()
            end
        end)
    end

    if type(RegisterNUICallback) == 'function' then
        RegisterNUICallback(Telemetry.NUI_CALLBACK, function(data, cb)
            local ok = pcall(function()
                if type(data) ~= 'table' then return end
                if not consentCache.enabled then return end
                pcall(TriggerServerEvent, Telemetry.INGEST_EVENT, json.encode({
                    context = data.context,
                    events = data.events,
                    dropped = data.dropped,
                }))
            end)
            cb({ ok = ok })
        end)
    end
elseif isServer and type(CreateThread) == 'function' then
    CreateThread(function()
        Wait(2000)
        while true do
            refreshConsentFromTLib()
            send()
            Wait(15000)
        end
    end)
end

return Telemetry
