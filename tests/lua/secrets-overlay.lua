-- Oracle for shared/imports/secrets/server.lua — the sidecar credential overlay.
--
-- The module's whole job is that a developer's real value lives OUTSIDE the
-- tracked config file, so what has to be proven here is both directions:
--
--   • the value in `config.local.lua` reaches `Config` at runtime, and
--   • `config.lua` itself is never written, never read for the value, and the
--     module is a no-op when the sidecar is absent (the customer's case, and
--     CI's).
--
-- NEGATIVE CONTROL: run with SECRETS_CONTROL=1 and `Secrets.read` is stubbed to
-- return nothing, as if the sidecar had been deleted. Every assertion that the
-- overlay APPLIED something must then flip. Without that, a suite in which the
-- stub host silently returns nil for every file would pass by asserting that
-- blank is blank — which is exactly what a working gate also reports.
--
--   SECRETS_CONTROL=1 bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/secrets-overlay.lua

local CONTROL = os.getenv('SECRETS_CONTROL') == '1'

local failures = 0
local flipped = 0
local realPrint = print

local function must(condition, message)
    if not condition then
        failures = failures + 1
        realPrint('FAIL: ' .. message)
    end
end

--- An assertion that the overlay DID something. Required to be true normally and
--- required to be FALSE under the control, counted either way.
local function mustApply(condition, message)
    if CONTROL then
        if condition then
            failures = failures + 1
            realPrint('CONTROL: still true with the sidecar removed — ' .. message)
        else
            flipped = flipped + 1
        end
    else
        must(condition, message)
    end
end

-- Host stubs

local FILES = {}
local resourceName = 'tProbe'
local convars = {}

function GetCurrentResourceName() return resourceName end
function LoadResourceFile(resource, file) return FILES[resource .. '/' .. file] end
function GetConvar(name, default)
    local value = convars[name]
    if value == nil or value == '' then return default end
    return value
end

-- `isSecretName` is the real one, from the real file: the convar half of the
-- overlay derives its key set from it, and stubbing it would make this suite
-- assert that a stub was told the right answer.
local Diag = dofile('shared/imports/diag/shared.lua')
tlib = { diag = Diag }

local Secrets = dofile('shared/imports/secrets/server.lua')

if CONTROL then
    -- The one substitution, in the module's own read path rather than in the
    -- host stub: a host that returned nil for everything would also make the
    -- `absent sidecar` cases below vacuous, and those must stay green.
    Secrets.read = function() return nil, nil end
end

-- A sidecar supplies what the tracked config leaves blank

local TRACKED = [[
Config = {
    authToken     = "",
    adminPassword = "",
    band          = "ka",
    discord       = { clientId = "1234", clientSecret = "", botToken = "" },
}
]]

local function freshConfig()
    local chunk = assert(load(TRACKED .. '\nreturn Config'))
    return chunk()
end

FILES['tProbe/config.local.lua'] = [[
return {
    authToken = 'synthetic-token-not-a-real-credential',
    discord = { botToken = 'synthetic-bot-token' },
}
]]

local config = freshConfig()
local result = Secrets.overlay(config, { quiet = true })

mustApply(config.authToken == 'synthetic-token-not-a-real-credential',
    'the sidecar authToken did not reach Config')
mustApply(config.discord.botToken == 'synthetic-bot-token',
    'a NESTED sidecar value did not reach Config')
mustApply(result.sidecar == true, 'the result did not report that a sidecar was read')
mustApply(#result.applied == 2, 'the applied list did not name both values')

-- The merge must not have flattened the sibling it did not touch. A whole-table
-- replace would have erased clientId, which is how a "working" overlay breaks
-- Discord auth while the credential it set looks correct.
must(config.discord.clientId == '1234', 'merging the discord block erased a sibling key')
must(config.discord.clientSecret == '', 'merging invented a value for an untouched key')
must(config.band == 'ka', 'the overlay touched a non-credential key it was not given')

-- And the TRACKED source is still blank. The sidecar is an overlay, not an edit:
-- nothing in this module writes a file, which is why a commit cannot pick the
-- value up and a `git pull` cannot destroy it.
must(TRACKED:find('authToken     = ""', 1, true) ~= nil,
    'the module mutated the tracked config source')

-- A convar beats the sidecar: production overrides the dev machine

convars['tprobe_authToken'] = 'from-the-host-secret-store'
local withConvar = freshConfig()
Secrets.overlay(withConvar, { quiet = true })
must(withConvar.authToken == 'from-the-host-secret-store',
    'a convar did not override the sidecar value')
-- The nested path is spelled with underscores, because a convar name cannot hold
-- a dot.
convars['tprobe_discord_botToken'] = 'convar-bot-token'
local nested = freshConfig()
Secrets.overlay(nested, { quiet = true })
must(nested.discord.botToken == 'convar-bot-token', 'a nested convar override did not apply')
-- A convar is looked up ONLY for a credential-shaped key. `band` is not one, and
-- making the overlay a general config-override surface by accident is a
-- different feature with different consequences.
convars['tprobe_band'] = 'x'
local plain = freshConfig()
Secrets.overlay(plain, { quiet = true })
must(plain.band == 'ka', 'a convar overrode a non-credential key')
convars = {}

-- No sidecar: the customer's case, and CI's

FILES['tProbe/config.local.lua'] = nil
local bare = freshConfig()
local bareResult = Secrets.overlay(bare, { quiet = true })
must(bare.authToken == '', 'an absent sidecar did not leave the config alone')
must(bareResult.sidecar == false, 'an absent sidecar was reported as read')
must(#bareResult.errors == 0, 'an absent sidecar was reported as an error')

-- A broken sidecar is an ERROR, never a silent blank

FILES['tProbe/config.local.lua'] = 'return { authToken = '
local broken = freshConfig()
local brokenResult = Secrets.overlay(broken, { quiet = true })
mustApply(#brokenResult.errors == 1, 'a syntactically broken sidecar was swallowed')
mustApply(#brokenResult.errors == 1
    and brokenResult.errors[1]:find('does not parse', 1, true) ~= nil,
    'the parse failure was not reported as one')

FILES['tProbe/config.local.lua'] = 'return 42'
local wrongType = freshConfig()
local wrongResult = Secrets.overlay(wrongType, { quiet = true })
mustApply(#wrongResult.errors == 1, 'a sidecar that returns a non-table was accepted')

-- The sidecar runs with an EMPTY environment: it is data. A file that reaches for
-- a global gets a nil, and calling one raises — which is caught and reported
-- rather than taking the resource down.
FILES['tProbe/config.local.lua'] = 'return { authToken = GetConvar("x", "y") }'
local sandboxed = freshConfig()
local sandboxResult = Secrets.overlay(sandboxed, { quiet = true })
mustApply(#sandboxResult.errors == 1, 'a sidecar calling a host global was not sandboxed')
must(sandboxed.authToken == '', 'a raising sidecar still wrote a value')

-- credentialPaths derives from SECRET_PATTERNS, not from a list

FILES['tProbe/config.local.lua'] = nil
local paths = Secrets.credentialPaths(freshConfig())
local found = {}
for _, p in ipairs(paths) do found[p] = true end
for _, expected in ipairs({ 'authToken', 'adminPassword', 'discord.clientSecret',
                           'discord.botToken' }) do
    must(found[expected], ('credentialPaths missed %s'):format(expected))
end
must(not found.band, 'credentialPaths claimed a plain setting was a credential')
must(not found['discord.clientId'], 'credentialPaths claimed clientId was a credential')

-- A key added later is covered with no edit here: that is the derivation working.
local future = freshConfig()
future.s3 = { AccessKey = '', SecretKey = '' }
local futurePaths = {}
for _, p in ipairs(Secrets.credentialPaths(future)) do futurePaths[p] = true end
must(futurePaths['s3.AccessKey'],
    'AccessKey — the key the old hand-written lists missed — is still not derived')

-- Verdict

if CONTROL then
    local expected = 8
    if flipped ~= expected or failures > 0 then
        realPrint(('CONTROL FAILED: %d of %d overlay assertions flipped with the sidecar '
            .. 'removed, %d other failure(s).'):format(flipped, expected, failures))
        os.exit(1)
    end
    realPrint(('CONTROL OK: all %d overlay assertions flipped with the sidecar removed, '
        .. 'so the gate above is capable of failing.'):format(expected))
    os.exit(0)
end

if failures > 0 then
    realPrint(('FAILED: %d assertion(s) in secrets-overlay'):format(failures))
    os.exit(1)
end
print('PASS: tlib.secrets sidecar overlay, convar precedence, sandbox and derivation')
