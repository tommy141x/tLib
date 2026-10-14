-- The Lua half of the diagnostics core, and the three things in it that MUST
-- agree with the TypeScript half byte for byte.
--
-- WHY A PIN AND NOT A DERIVED ASSERTION. The fingerprint is a grouping key
-- computed in two languages, and no single source can span them. A fault
-- reported from Lua and the same fault reported from the NUI have to land in the
-- same group, and the only failure mode is silent: two groups of one, on a
-- dashboard, forever. So the literals below are also pinned in
-- tests/unit/telemetry-payload.test.ts, and `fnv1a('')` / `fnv1a('a')` are the
-- PUBLISHED FNV-1a 32-bit test vectors — which makes this an oracle rather than
-- a snapshot of whatever the code happened to do.
--
-- The module is loaded WITHOUT RegisterNetEvent, CreateThread or
-- RegisterNUICallback defined, deliberately: every one of its wiring blocks is
-- guarded on `type(...) == 'function'`, and this suite is what proves the
-- primitives are reachable in a VM that has none of them. A module that only
-- loaded inside a live FXServer could not be tested at all.
--
-- Run via `bun run test:lua`.

local function fail(message) error(message, 2) end

-- Host stubs

local now = 0
function GetGameTimer() return now end
function IsDuplicityVersion() return false end
function GetCurrentResourceName() return 'tRadio' end

local T = dofile('shared/imports/telemetry/shared.lua')

-- `scrubIdentifiers` on its own, so a failure here is attributable to the
-- identifier rules rather than to the credential or path rules in `scrub`.
local function Telemetry_scrubCheck(text) return T.scrubIdentifiers(text) end

-- fnv1a: the published vectors

if T.fnv1a('') ~= '811c9dc5' then
    fail('fnv1a("") was ' .. T.fnv1a('') .. ', not the FNV-1a 32-bit offset basis 811c9dc5')
end
if T.fnv1a('a') ~= 'e40c292c' then
    fail('fnv1a("a") was ' .. T.fnv1a('a') .. ', not the published vector e40c292c')
end

-- fnv1a: the cross-language pins

local pins = {
    ['tlib'] = 'a3620e9a',
    ['TypeError|at x (nui/assets/index.js:1)'] = '9e6c6ac2',
    ['warning:layout-missing'] = 'd581e878',
    ['crash:heap-near-limit'] = 'f28ad9db',
}
for input, expected in pairs(pins) do
    local got = T.fnv1a(input)
    if got ~= expected then
        fail(('fnv1a(%q) was %s, not %s — the Lua and TypeScript grouping keys have diverged '
            .. 'and a fault reported from each side will be two groups of one')
            :format(input, got, expected))
    end
end

-- Eight hex characters always, so the value is always a legal dimension.
for _, input in ipairs({ '', 'a', string.rep('x', 5000), '\255\254' }) do
    local h = T.fnv1a(input)
    if #h ~= 8 then fail('fnv1a produced ' .. #h .. ' characters, not 8') end
    if not h:match('^[0-9a-f]+$') then fail('fnv1a produced non-hex: ' .. h) end
end

-- fingerprint

if T.fingerprint('LuaError', 'cl_tones') == T.fingerprint('LuaError', 'cl_hud') then
    fail('two different sites produced one fingerprint; every fault in a resource would group as one')
end
if T.fingerprint('a', nil) ~= T.fingerprint('a', '') then
    fail('a nil site and an empty site produced different fingerprints')
end

-- slug: nothing illegal can reach a dimension

if T.slug('tRadio 1.4.2') ~= 'tradio-1.4.2' then
    fail('slug("tRadio 1.4.2") was ' .. T.slug('tRadio 1.4.2'))
end
-- '' and NOT a placeholder. A placeholder is a category every later query
-- counts as if it meant something; an empty value is omitted from the payload.
for _, input in ipairs({ '!!!', '   ', '---', '..:..' }) do
    if T.slug(input) ~= '' then
        fail(('slug(%q) was %q, not the empty string'):format(input, T.slug(input)))
    end
end
if T.slug(nil) ~= '' or T.slug(42) ~= '' then fail('slug of a non-string was not empty') end

-- Every output legal, including from the strings that MUST NOT be dimensions.
local nasty = {
    "Cannot read properties of null (reading 'replaceChild')",
    'POST /admin/api?x="y"',
    'C:\\Users\\Tommy\\FiveM',
    'a@b.invalid',
    'tab\there',
    'line\nbreak',
}
for _, input in ipairs(nasty) do
    local out = T.slug(input)
    if out ~= '' and not out:match('^[A-Za-z0-9._:%-]+$') then
        fail(('slug(%q) produced %q, which the ingest charset refuses'):format(input, out))
    end
end

-- Bounded, and a truncation may not land on a separator.
local long = T.slug(string.rep('a', 40) .. string.rep('-', 40), 45)
if #long > 45 then fail('slug exceeded its maxLength') end
if long:sub(-1) == '-' then fail('a truncated slug ended on a separator') end

-- Player identifiers: the measured hole in the ingest charset
--
-- `[A-Za-z0-9._:-]` ADMITS EVERY FIVEM IDENTIFIER VERBATIM, because `:` is in
-- it for namespaced ids and a FiveM identifier is exactly that shape. The tWeb
-- side measured it and now REFUSES these shapes -- which turns a leak into a
-- SILENT DATA LOSS on this side, since a refused event is a lost event. Either
-- way the fix is here, and `errorCode` on a game client is the likeliest field
-- in the whole taxonomy to receive one.
local identifiers = {
    'steam:110000100000000',
    'license:4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180',
    'license2:4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180',
    'discord:1345874347281088565',
    '192.168.8.141',
    'C:Users.Tommy.Documents',
}
for _, raw in ipairs(identifiers) do
    local scrubbed = Telemetry_scrubCheck(raw)
    if scrubbed:find(raw, 1, true) then
        fail(('the identifier %q survived scrubIdentifiers'):format(raw))
    end
    -- And it must not survive into a dimension either, which is the path that
    -- actually reaches the store.
    local dim = T.slug('no permission for ' .. raw, 64)
    for _, fragment in ipairs({ '110000100000000', '1345874347281088565', '4d1f8a9c', '192.168.8.141', 'tommy' }) do
        if dim:find(fragment, 1, true) then
            fail(('slug(%q) produced %q, which still carries %q'):format(raw, dim, fragment))
        end
    end
end

-- The other direction: a 13-digit epoch-millisecond timestamp is NOT an id, and
-- a rule that ate it would redact every duration and counter in a message.
if Telemetry_scrubCheck('at 1760000000000 ms'):find('1760000000000', 1, true) == nil then
    fail('a 13-digit timestamp was blanked as a player identifier')
end

-- versionSlug: the `+` that is refused at 21 characters
--
-- `+` is not in the charset, so `1.14.2-rc.3+ab12cd34` is REFUSED -- nothing
-- to do with any length cap, which is exactly how it would be misdiagnosed.
if T.versionSlug('1.14.2-rc.3+ab12cd34') ~= '1.14.2-rc.3.ab12cd34' then
    fail('versionSlug mapped `+` wrongly: ' .. T.versionSlug('1.14.2-rc.3+ab12cd34'))
end
if not T.versionSlug('1.14.2-rc.3+ab12cd34'):match('^[A-Za-z0-9._:%-]+$') then
    fail('versionSlug produced a value the charset refuses')
end

-- pathSlug: the `/` that is refused
if T.pathSlug('client/cl_radio.lua:218') ~= 'client.cl_radio.lua:218' then
    fail('pathSlug did not map separators to dots: ' .. T.pathSlug('client/cl_radio.lua:218'))
end
-- The backslash form is written as a long-bracket literal: `'server\sv'` is an
-- invalid escape sequence in Lua 5.4 and the whole suite fails to load.
local backslashed = [=[server\sv_main.lua:9]=]
if T.pathSlug(backslashed) ~= 'server.sv_main.lua:9' then
    fail('pathSlug did not map a backslash: ' .. T.pathSlug(backslashed))
end

-- The event names are tWeb's
local names = {
    [T.EVENT_ERROR] = 'tlib.error_reported',
    [T.EVENT_WARNING] = 'tlib.warning_reported',
    [T.EVENT_CRASH] = 'tlib.crash_reported',
    [T.EVENT_SLOW] = 'tlib.slow_operation',
    [T.EVENT_ENVIRONMENT] = 'tlib.environment_reported',
}
for got, expected in pairs(names) do
    if got ~= expected then
        fail(('an event name is %q, not the %q tWeb declares -- an undeclared name is '
            .. 'refused per event and counted on THEIR dashboard, invisibly from here')
            :format(got, expected))
    end
end

-- scrub

T.resetScrubValues()

-- The real case this feature was briefed on: a credential in a config dump.
local out = T.scrub('config load failed: password = hunter2hunter2')
if out:find('hunter2hunter2', 1, true) then fail('a password survived scrub: ' .. out) end
if not out:find(T.REDACTED, 1, true) then fail('scrub removed the value without marking it') end

-- A home directory loses the account name and KEEPS the path — the
-- diagnostically useful half.
out = T.scrub('at load (C:\\Users\\SomePlayer\\FiveM\\resources\\tRadio\\sv_main.lua:12)')
if out:find('SomePlayer', 1, true) then fail('a Windows account name survived: ' .. out) end
if not out:find('sv_main.lua:12', 1, true) then
    fail('scrub ate the file and line, which is the whole diagnostic: ' .. out)
end
-- Linux too: t* resources run in containers, and that is a first-class target.
out = T.scrub('ENOENT /home/fivem/txData/resources/tRadio/data.json')
if out:find('/home/fivem', 1, true) then fail('a Linux home directory survived: ' .. out) end
if not out:find('data.json', 1, true) then fail('scrub ate the path: ' .. out) end

-- A registered identifying value never survives.
T.registerScrubValue('Tommy_Johnston')
out = T.scrub('channel join refused for Tommy_Johnston')
if out:find('Tommy_Johnston', 1, true) then fail('a registered name survived: ' .. out) end

-- The length floor is load-bearing. A player called `Al` would otherwise turn
-- every `Already` into `[redacted]ready`, and an unreadable report is worth the
-- same as no report.
if T.registerScrubValue('Al') ~= false then fail('a two-character name was accepted for scrubbing') end
if T.scrub('Already connected') ~= 'Already connected' then
    fail('a short name mangled unrelated text: ' .. T.scrub('Already connected'))
end

-- A Lua pattern character in a name is matched LITERALLY, not as a pattern.
T.resetScrubValues()
T.registerScrubValue('a.b(c)')
if not T.scrub('user a.b(c) left'):find(T.REDACTED, 1, true) then
    fail('a name containing pattern characters was not blanked')
end
if T.scrub('axbc') ~= 'axbc' then
    fail('a name was applied as a Lua PATTERN rather than literally: ' .. T.scrub('axbc'))
end

-- A non-string is '' rather than the text "nil".
if T.scrub(nil) ~= '' or T.scrub(42) ~= '' then fail('scrub of a non-string was not empty') end
T.resetScrubValues()

-- p95: nearest rank, the same rank as the TypeScript twin

if T.p95({}) ~= 0 then fail('p95 of nothing was not 0') end
local window = {}
for i = 1, T.SAMPLE_WINDOW do window[i] = i - 1 end
-- ceil(0.95 * 64) = 61, one-based -> the 61st value, which is 60.
if T.p95(window) ~= 60 then fail('p95 rank disagrees with the TypeScript twin: ' .. T.p95(window)) end
-- It answers a value that was actually OBSERVED. Interpolation would say 15,
-- and a latency a human compares against a budget must be a real reading.
if T.p95({ 10, 20 }) ~= 20 then fail('p95 interpolated instead of taking a rank') end
-- The input is not mutated.
local src = { 5, 1, 3 }
T.p95(src)
if src[1] ~= 5 or src[2] ~= 1 or src[3] ~= 3 then fail('p95 sorted the caller table in place') end

-- timed: outliers only

local reported = {}
local timers = T.createTimers({
    now = function() return now end,
    report = function(o) reported[#reported + 1] = o end,
})

-- A thousand calls inside budget report NOTHING. This is the assertion the
-- whole module exists for: per-call reporting would be 3,600 events a minute
-- from one instrumented 60 Hz path.
now = 0
for _ = 1, 1000 do timers.record('load', 50, 10) end
if #reported ~= 0 then fail('a call inside its budget was reported ' .. #reported .. ' times') end

-- THE FIRST BREACH OF A SESSION IS REPORTED, at GetGameTimer() == 0.
-- `lastThresholdAt` is -math.huge for exactly this: a zero would have made
-- `now - 0 >= 60000` false for the whole first minute of a boot, which is where
-- a slow boot path lives.
timers.record('load', 50, 4000)
if #reported ~= 1 then fail('the first threshold breach of a session was suppressed') end
if reported[1].kind ~= 'threshold' then fail('the first breach was not a threshold report') end
if reported[1].durationMs ~= 4000 then fail('the reported duration was ' .. reported[1].durationMs) end
if reported[1].suppressed ~= 0 then fail('the first report claimed suppressed calls') end

-- A storm inside the cooldown is ONE report, and the VOLUME survives.
for _ = 1, 4000 do timers.record('load', 50, 4000) end
if #reported ~= 1 then fail('a 4000-call storm produced ' .. #reported .. ' reports') end
now = now + T.THRESHOLD_COOLDOWN_MS
timers.record('load', 50, 4000)
if #reported ~= 2 then fail('the cooldown never expired') end
if reported[2].suppressed ~= 4000 then
    fail('the suppressed count was ' .. reported[2].suppressed .. ', not 4000 — the rows were '
        .. 'dropped AND the volume was lost')
end

-- The habitual-slowness channel: 40ms every time against a 50ms budget. Nothing
-- breaches, and the machine is still too slow. The bar is a FRACTION of the
-- budget; comparing the p95 against the budget itself can only fire when the
-- threshold channel has already spoken, which made this branch dead code.
timers.reset()
reported = {}
timers = T.createTimers({
    now = function() return now end,
    report = function(o) reported[#reported + 1] = o end,
})
for _ = 1, T.SAMPLE_WINDOW - 1 do timers.record('tick', 50, 40) end
if #reported ~= 0 then fail('a p95 was reported before the window was full') end
timers.record('tick', 50, 40)
if #reported ~= 1 then fail('a habitually slow operation was never reported') end
if reported[1].kind ~= 'p95' then fail('the report was not a p95') end
if reported[1].sampleCount ~= T.SAMPLE_WINDOW then fail('the p95 reported the wrong sample count') end

-- And it is bounded: one p95 per interval, not per call.
for _ = 1, 5000 do timers.record('tick', 50, 40) end
if #reported ~= 1 then fail('the p95 interval was not respected: ' .. #reported .. ' reports') end

-- A throwing call is STILL TIMED and STILL THROWS. The slowest call on a machine
-- in trouble is frequently the one that then throws.
timers.reset()
reported = {}
local ok = pcall(function()
    timers.timed('boom', 0, function() error('x') end)
end)
if ok then fail('timed() swallowed an error from the call it wrapped') end
if #reported ~= 1 then fail('a throwing call was not timed') end

-- The value is returned unchanged.
if timers.timed('x', 100000, function() return 42 end) ~= 42 then
    fail('timed() did not return the value of the call it wrapped')
end

-- A negative duration is ignored rather than recorded: GetGameTimer() across a
-- resource restart can go backwards, and one -2^31 sample poisons a whole window.
timers.reset()
reported = {}
timers.record('x', 0, -5)
if #reported ~= 0 then fail('a negative duration was recorded') end
-- But ZERO is legal: GetGameTimer() has millisecond resolution, so an operation
-- faster than 1ms genuinely measures 0.
timers.record('x', 0, 0)
if #reported ~= 1 then fail('a zero duration was discarded; sub-millisecond work is unmeasurable') end

-- consent defaults OFF

local consent = T.consent()
if consent.enabled ~= false then
    fail('consent defaulted to ENABLED; a diagnostics feature whose default is on is not opt-in')
end
if consent.source ~= 'default' then fail('the default consent source was ' .. tostring(consent.source)) end
if consent.locked ~= false then fail('the default consent was reported as locked, hiding the switch') end

print('PASS tests/lua/telemetry-core.lua')
