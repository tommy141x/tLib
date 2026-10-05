-- shared/imports/diag: `tlib.diag.command`, and the redactor that is now a
-- default rather than something four resources forgot.
--
-- Eight resources had hand-written `<resource>_diag`. Four of them had NO
-- redactor at all, each justified in a comment by "this config holds no
-- secrets" -- which is the assumption tDetector's own comment says is unsafe
-- over time. One had the pcall guard. One derived its key list from the config
-- spec. This suite is what makes those four properties true for all of them.
--
-- NEGATIVE CONTROL: run with DIAG_CONTROL=1 and the `redact` default is
-- inverted to `false`. Every redaction assertion below then has to fail, and
-- the suite exits non-zero naming which. A redactor that has stopped running
-- reports a clean report, and a clean report is exactly what a working redactor
-- also produces -- so the only way to know this suite can fail is to disable
-- the thing it tests and watch it.
--
--   bun run test:lua                                    # gate
--   DIAG_CONTROL=1 bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/diag-command.lua   # must exit 1
--
-- Run from the tLib resource root.

local CONTROL = os.getenv('DIAG_CONTROL') == '1'

-- ── Stub host ───────────────────────────────────────────────────────────────

local commands = {}          -- name -> { fn, restricted }
local clientEvents = {}      -- { event, target, payload }
local printed = {}

function GetCurrentResourceName() return 'tProbe' end

function RegisterCommand(name, fn, restricted)
    commands[name] = { fn = fn, restricted = restricted }
end

function TriggerClientEvent(event, target, payload)
    clientEvents[#clientEvents + 1] = { event = event, target = target, payload = payload }
end

local resourceMeta = {
    tProbe = { version = '2.1.0', tlib_min_version = '0.14' },
    tLib   = { version = '0.14.0' },
}
function GetResourceMetadata(resource, key)
    local entry = resourceMeta[resource]
    if not entry then error('no such resource: ' .. tostring(resource), 0) end
    return entry[key]
end

local resourceStates = { tProbe = 'started', tLib = 'started', tDB = 'stopped' }
function GetResourceState(name)
    -- The real native raises on a name it has never heard of, which is what
    -- Diag.resourceState's pcall is for. Reproduced, or that pcall is untested.
    local state = resourceStates[name]
    if state == nil then error('unknown resource ' .. tostring(name), 0) end
    return state
end

local convars = { tlib_http_port = '30120' }
function GetConvar(name, default)
    local v = convars[name]
    if v == nil then return default end
    return v
end

-- The module PRINTS the report, so capturing print is the behaviour under test.
--
-- ⚠️ scripts/run-lua-suite.lua reports a failed suite with a bare `print(err)`,
-- which resolves to whatever `print` is at that moment -- so a naive hijack eats
-- the failure message and a broken suite exits 1 with no output at all. `fail`
-- below restores the real print first. This is the trap tCAD's runner fixed and
-- tLib's has not.
local realPrint = print
local verbose = os.getenv('TLIB_TEST_VERBOSE') == '1'
print = function(s)
    printed[#printed + 1] = tostring(s)
    if verbose then realPrint(s) end
end

local failures = {}

local function fail(message)
    print = realPrint
    failures[#failures + 1] = message
    realPrint('FAIL  ' .. message)
    print = function(s)
        printed[#printed + 1] = tostring(s)
        if verbose then realPrint(s) end
    end
end

--- Asserts a property that MUST hold whether or not redaction is on.
local function must(condition, message)
    if not condition then fail(message) end
end

--- Asserts a VALUE-redaction property -- the layer `redact` governs: required
--- with the default, and required to be ABSENT under the control. That
--- inversion is the whole point. It is how this suite proves it can fail at all,
--- and it is why the control's verdict is "the secret leaked, as it had to".
---
--- ⚠️ Only the value filter and `ctx.message`'s name-withholding are governed by
--- `redact`. The name-keyed layer in `describe`/`ctx.kv` is unconditional and is
--- asserted with `must`, because there is no switch to turn it off -- a config
--- key called `authToken` renders as `<redacted>` or this module is broken.
local flipped = 0

local function redactsValue(condition, message)
    if CONTROL then
        -- With `redact = false` the assertion must STOP holding: the secret has
        -- to leak. One that still holds is measuring something the flag does not
        -- govern, and the verdict at the bottom refuses the run.
        if condition then
            fail('CONTROL: still withheld with redact=false, so this check is not '
                .. 'measuring the value filter -- ' .. message)
        else
            flipped = flipped + 1
        end
    elseif not condition then
        fail(message)
    end
end

local Diag = dofile('shared/imports/diag/shared.lua')

-- ── isSecretName: the whole point is that it is keyed on the NAME ───────────

for _, name in ipairs({ 'authToken', 'adminPassword', 'discordBotToken', 'webhookUrl',
                        'apiKey', 'api_key', 'clientSecret', 'licenseKey', 'privateKey' }) do
    must(Diag.isSecretName(name), ('%q was not recognised as a credential name'):format(name))
end
for _, name in ipairs({ 'band', 'maxRange', 'speedUnit', 'acePermission', 'frequency' }) do
    must(not Diag.isSecretName(name), ('%q was treated as a credential'):format(name))
end
-- Case-insensitive, and matched as a SUBSTRING: a key added later will be named
-- `Config.myWebhookURL`, not `Config.webhook`.
must(Diag.isSecretName('MyWebhookURL'), 'the name test is case-sensitive or anchored')

-- ── describe: redaction by key name, tables summarised ─────────────────────

must(Diag.describe('authToken', 'hunter2-hunter2') == '<redacted>',
    'describe printed a credential value')
must(Diag.describe('band', 'ka') == '"ka"', 'describe mangled a plain string')
must(Diag.describe('maxRange', nil) == 'not set', 'describe did not report an absent key')
must(Diag.describe('sites', { 1, 2, 3 }) == 'list of 3', 'describe expanded a list')
must(Diag.describe('sensitivity', { low = 1, high = 2 }) == '{ high = 2, low = 1 }',
    'describe did not sort or inline a key/value table')
-- Nested through a table, so a credential one level down is still caught.
must(Diag.describe('discord', { botToken = 'abcdef123456', authEnabled = true })
        == '{ authEnabled = true, botToken = <redacted> }',
    'describe printed a credential nested one level down')

-- ── presence: the useful half of a credential, and never the value ─────────

must(Diag.presence('abc') == 'set', 'a set credential did not report as set')
must(Diag.presence(nil) == 'not set', 'an absent credential did not report as not set')
must(Diag.presence('') == 'not set', 'an empty string reported as set')
must(Diag.presence(0) == 'not set (wrong type: number)',
    'a wrong-typed credential did not name its type')

-- ── harvest: derived, not hand-listed ──────────────────────────────────────

local config = {
    band = 'ka',
    authToken = 'super-secret-token-value',
    adminPassword = 'correct-horse',
    discord = { botToken = 'bot-token-abcdef', authEnabled = true },
    -- Not a credential by NAME, so not harvested -- and that is correct: the
    -- rule is the key's name, because a value cannot be inspected for secrecy.
    hostServerUrl = 'https://cad.example.com',
    -- Too short to be a usable credential, and long enough to appear inside
    -- unrelated lines. Harvesting it would withhold half the report.
    sessionToken = 'abc',
    -- The key the pattern list does NOT match; declared via `secrets`.
    sharedKey = 'shared-key-value-here',
}

local harvested = Diag.harvest(config, { 'sharedKey' })
local byKey = {}
for _, entry in ipairs(harvested) do byKey[entry.key] = entry.value end

must(byKey.authToken == 'super-secret-token-value', 'harvest missed a top-level credential')
must(byKey.adminPassword == 'correct-horse', 'harvest missed adminPassword')
must(byKey.botToken == 'bot-token-abcdef', 'harvest did not descend into a nested table')
must(byKey.sharedKey == 'shared-key-value-here',
    'harvest ignored an explicitly declared credential name')
must(byKey.hostServerUrl == nil, 'harvest took a non-credential key name')
must(byKey.sessionToken == nil, 'harvest took a value too short to be a credential')

-- A dotted path is accepted and matched by its leaf, because that is the key
-- name the walk sees. tRadio declares its secrets as `discord.clientSecret`.
local dotted = Diag.harvest({ discord = { clientSecret = 'client-secret-xyz' } },
    { 'discord.clientSecret' })
must(#dotted == 1 and dotted[1].value == 'client-secret-xyz',
    'a dotted secret path was not matched by its leaf')

-- Cycle-safe: a config may legitimately contain one, and a diagnostic that
-- hangs looks exactly like a crashed server.
local cyclic = { authToken = 'cyclic-token-value' }
cyclic.self = cyclic
must(#Diag.harvest(cyclic) == 1, 'harvest did not survive a cycle')

-- ── redactor: a line carrying a value does not survive ─────────────────────

local filter = Diag.redactor(harvested)
local leak = filter('  Config.authToken expected a string, got "super-secret-token-value"')
must(not leak:find('super%-secret%-token%-value'), 'the redactor let a credential value through')
must(leak:find('authToken', 1, true), 'the withheld line did not name the key it withheld')
must(filter('  Config.band "ka"') == '  Config.band "ka"',
    'the redactor rewrote a line that held no credential')
must(Diag.redactor({})('anything') == 'anything',
    'the empty redactor was not the identity')

-- ── configKeys: spec-derived, with nothing dropped ─────────────────────────

local spec = { keys = { band = true, maxRange = true, speedUnit = true, coneAngle = true } }
local keys = Diag.configKeys(spec, { 'band', 'maxRange' },
    { band = 'ka', maxRange = 300, speedUnit = 'mph', coneAngle = 12, undeclaredKey = true })

must(keys[1] == 'band' and keys[2] == 'maxRange',
    'the presentation order was not honoured')
-- Spec keys the order did not name come next, sorted.
must(keys[3] == 'coneAngle' and keys[4] == 'speedUnit',
    'spec keys outside the order were dropped or unsorted')
-- And last, the key the SPEC does not declare. This is the line that answers
-- "I set that and it had no effect", and a hand-written list never has it.
must(keys[5] == 'undeclaredKey',
    'a key present in the config but absent from the spec was omitted from the dump')
-- An order entry naming a key the spec does not declare is presentation only
-- and must not smuggle it to the front.
local misordered = Diag.configKeys(spec, { 'notInSpec', 'band' }, {})
must(misordered[1] == 'band', 'an order entry outside the spec was printed as a spec key')

-- ── command: the defaults nobody has to remember ───────────────────────────

local tradarSpec = { keys = { band = true, maxRange = true } }

Diag.command({
    name = 'tprobe_diag',
    title = 'tProbe diagnostics',
    config = config,
    spec = tradarSpec,
    order = { 'band' },
    secrets = { 'sharedKey' },
    redact = not CONTROL,
    report = function(ctx)
        ctx.line('tProbe %s  tLib %s', ctx.meta('tProbe'), ctx.meta('tLib'))
        ctx.line('tDB %s', ctx.resourceState('tDB'))
        -- A dependency that is not installed at all. The native raises; the
        -- report must not.
        ctx.line('oxmysql %s', ctx.resourceState('oxmysql'))
        ctx.line('port %s', ctx.convarSet('tlib_http_port'))
        ctx.line('public url %s', ctx.convarSet('tlib_http_public_url'))
        ctx.section('config')
        for _, key in ipairs(ctx.configKeys()) do ctx.kv(key, config[key]) end
        ctx.section('credentials')
        ctx.kv('authToken presence', ctx.presence(config.authToken))
        -- ⚠️ Deliberate leaks, through the ONE route that is not name-keyed: a
        -- raw `ctx.line` carrying a credential value. This is the realistic
        -- drift -- nobody writes `ctx.kv('authToken', …)` by accident, they
        -- print a payload or an error that happens to contain one. Every one of
        -- these must be withheld by the value filter, and every one of them
        -- must leak when `redact = false`.
        ctx.line('echo token: %s', tostring(config.authToken))
        ctx.line('echo password: %s', tostring(config.adminPassword))
        ctx.line('echo bot: %s', tostring(config.discord.botToken))
        ctx.line('echo shared: %s', tostring(config.sharedKey))
        ctx.section('validation')
        ctx.messages({
            warnings = {
                'Config.band is "ka"\n  Fix: nothing, this is fine.',
                -- Names a credential and does NOT contain its value: the
                -- validator masked it. Only the name rule can catch this, which
                -- is why tRadio's rule is kept alongside the value filter.
                'Config.adminPassword was written unquoted, so it read as 0.',
            },
            errors = { 'Config.authToken must be a string, got "super-secret-token-value"' },
        })
        ctx.line('console=%s src=%d', tostring(ctx.console), ctx.src)
    end,
})

must(commands.tprobe_diag ~= nil, 'the command was never registered')
must(commands.tprobe_diag.restricted == true,
    'the command was registered UNrestricted -- any player could run it')

-- From the console.
printed = {}
clientEvents = {}
local lines = commands.tprobe_diag.fn(0)
local text = table.concat(lines, '\n')
local consoleText = table.concat(printed, '\n')

must(#printed == #lines, 'the console copy did not get every line')
must(text:find('tProbe diagnostics', 1, true), 'the title was not printed')
must(text:find('tProbe 2.1.0', 1, true), 'the version line is missing')
must(text:find('tDB stopped', 1, true), 'a resource state was not reported')
must(text:find('oxmysql missing', 1, true),
    'an uninstalled dependency took the report down instead of reporting missing')
must(text:find('port set', 1, true) and text:find('public url not set', 1, true),
    'convar presence was not reported')
must(text:find('console=true src=0', 1, true), 'ctx.console was wrong for the console')
must(text:find('safe to paste', 1, true), 'the paste-safety footer is missing')

-- ── Layer 1: name-keyed, unconditional. `ctx.kv` through `describe`. ───────
--
-- This is the layer tDetector had and the four resources with "no redactor"
-- did not. It has no switch, because a key whose NAME reads like a credential
-- is never printable regardless of what the caller asked for.
must(consoleText:find('<redacted>', 1, true) ~= nil,
    'ctx.kv printed a credential value instead of <redacted>')

-- ── Layer 2: the value filter, which `redact` governs. ────────────────────
redactsValue(not consoleText:find('super-secret-token-value', 1, true),
    'the credential value appeared in a validation message')
redactsValue(not consoleText:find('correct-horse', 1, true),
    'adminPassword appeared in a raw report line')
redactsValue(not consoleText:find('bot-token-abcdef', 1, true),
    'a nested credential appeared in a raw report line')
redactsValue(not consoleText:find('shared-key-value-here', 1, true),
    'a credential declared only via `secrets` appeared in a raw report line')
must(consoleText:find('withheld', 1, true) ~= nil or CONTROL,
    'the withheld lines did not say they were withheld')

-- ── Layer 3: a message that NAMES a credential but has masked its value. ──
--
-- tRadio's rule. The value filter cannot see this one: the validator replaced
-- the value with 0, so nothing in the line matches a harvested secret.
redactsValue(not consoleText:find('read as 0', 1, true),
    'a validation message about a credential was echoed verbatim')
redactsValue(consoleText:find('a problem with adminPassword', 1, true) ~= nil,
    'the withheld validation message did not name the key it was about')

-- The presence line survives: `authToken set` is the answer to most tickets and
-- is not a disclosure. A blunter redactor would have clobbered it.
must(consoleText:find('authToken presence', 1, true), 'the presence line was lost')

-- Multi-line validation messages keep their Fix: paragraph rather than being
-- flattened -- that paragraph is the half an operator can act on.
must(text:find('Fix: nothing, this is fine.', 1, true),
    'a validation message lost its continuation lines')

-- Non-credential config values are still printed. A redactor that withheld
-- everything would pass every assertion above and be useless.
must(consoleText:find('"ka"', 1, true), 'a plain config value was withheld')
-- `hostServerUrl` is in the config and NOT in the spec, so it reaches the dump
-- only through configKeys' third pass -- the one a hand-written key list is
-- missing, and the one that answers "I set that and it had no effect".
must(consoleText:find('hostServerUrl', 1, true),
    'a config key the spec does not declare was not appended to the dump')

-- From a player: the console copy is unconditional AND the caller is told.
printed = {}
clientEvents = {}
commands.tprobe_diag.fn(7)
must(#printed > 0,
    'an in-game caller got no console copy -- that is the copy that survives them disconnecting')
must(#clientEvents > 0, 'the in-game caller was told nothing')
must(clientEvents[1].event == 'chat:addMessage' and clientEvents[1].target == 7,
    'the report did not reach the caller')

-- ── The pcall guard, and the partial report ────────────────────────────────

Diag.command({
    name = 'tprobe_broken',
    config = false,
    report = function(ctx)
        ctx.line('this line rendered')
        error('deliberate explosion')
    end,
})

printed = {}
local broken = table.concat(commands.tprobe_broken.fn(0), '\n')
must(broken:find('this line rendered', 1, true),
    'the report that died mid-way threw away the half that had rendered')
must(broken:find('failed partway through', 1, true),
    'a report that died said nothing about having died')
must(broken:find('deliberate explosion', 1, true),
    'the failure line did not name the error')
must(broken:find('everything after this point is missing', 1, true),
    'nothing told the operator the paste was a partial one')

-- ── diag.guard: the same property for a report that prints itself ──────────

local ran = false
Diag.guard('tprobe_guarded', function() ran = true; error('boom') end)
must(commands.tprobe_guarded ~= nil, 'guard did not register the command')
must(commands.tprobe_guarded.restricted == true, 'guard registered an unrestricted command')
printed = {}
commands.tprobe_guarded.fn(0)
must(ran, 'guard never called the body')
must(table.concat(printed, '\n'):find('failed partway through', 1, true),
    'guard swallowed the failure silently')

-- `command` and `guard` must not have disturbed the original block renderer.
printed = {}
Diag.reset()
Diag.warn('a plain block still works', { cause = 'because command is additive' })
must(#printed > 0 and table.concat(printed, '\n'):find('a plain block still works', 1, true),
    'adding command broke diag.warn')

-- ── Verdict ────────────────────────────────────────────────────────────────

print = realPrint

if CONTROL then
    -- The control is satisfied by EVERY value-redaction assertion flipping, not
    -- by some of them. A partial flip means part of the suite is asserting
    -- something the `redact` flag does not actually control -- which is how the
    -- first draft of this file came to "pass" its own control while three of
    -- its five redaction checks were measuring an unrelated layer.
    local expected = 6
    if flipped ~= expected or #failures > 0 then
        realPrint(('CONTROL FAILED: %d of %d value-redaction assertions flipped with redact=false.')
            :format(flipped, expected))
        realPrint('An assertion that still holds is not measuring the layer `redact` governs.')
        os.exit(1)
    end
    realPrint(('CONTROL OK: all %d value-redaction assertions flipped with redact=false, '):format(expected)
        .. 'so the gate above is capable of failing.')
    os.exit(1)
end

if #failures > 0 then
    realPrint(('\n%d assertion(s) failed'):format(#failures))
    os.exit(1)
end

realPrint('diag-command: ok')
