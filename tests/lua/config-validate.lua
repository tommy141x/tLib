-- tlib.config: startup validation of an owner-edited config.lua.
--
-- Every assertion here maps to a rule in
-- internal/reference/tscripts-config-standard.md §10, which in turn exists
-- because each rule maps to a support ticket the seven resources actually
-- generated: a typo'd key that silently did nothing, a quoted number, a
-- fallback that differed from the shipped default, an error that named the
-- wrong file.
--
-- The messages are asserted on their CONTENT, not their exact wording — a
-- message that fails to name the key or the fix is the bug, not a reworded one.

GetCurrentResourceName = function() return 'tExample' end

local config = dofile('shared/imports/config/shared.lua')

local function spec(over)
    local s = {
        file = 'shared/config.lua',
        keys = {
            detectionRangeMeters = { type = 'number', default = 500.0, min = 1, max = 2000 },
            speedUnit            = { type = 'string', default = 'kmh', oneOf = { 'kmh', 'mph' } },
            enableSiren          = { type = 'boolean', default = true },
            radarResources       = { type = 'list', default = {} },
            licenseKey           = { type = 'string', required = true },
        },
    }
    for k, v in pairs(over or {}) do s[k] = v end
    return s
end

local function contains(haystack, needle)
    return haystack:lower():find(needle:lower(), 1, true) ~= nil
end

local function firstMatching(list, needle)
    for _, msg in ipairs(list) do
        if contains(msg, needle) then return msg end
    end
    return nil
end

-- ── A valid config passes and reports nothing ───────────────────────────────

local good = {
    detectionRangeMeters = 500.0,
    speedUnit            = 'mph',
    enableSiren          = false,
    radarResources       = { 'tRadar' },
    licenseKey           = 'abc123',
}
local r = config.validate(good, spec())
assert(r.ok, 'a valid config validates')
assert(#r.errors == 0, 'a valid config produces no errors')
assert(#r.warnings == 0, 'a valid config produces no warnings')
assert(good.speedUnit == 'mph', 'a value the owner set is never overwritten')

-- ── Defaults fill in, and are applied to the table ──────────────────────────

local sparse = { licenseKey = 'abc123' }
r = config.validate(sparse, spec())
assert(r.ok, 'omitting optional keys is valid')
assert(sparse.detectionRangeMeters == 500.0, 'a missing optional key takes its default')
assert(sparse.speedUnit == 'kmh', 'string defaults are applied too')
assert(sparse.enableSiren == true, 'boolean defaults survive (false vs nil is not confused)')

-- A `false` default must not be re-defaulted on the next pass.
local falseSpec = { file = 'c.lua', keys = { flag = { type = 'boolean', default = true } } }
local falsey = { flag = false }
config.validate(falsey, falseSpec)
assert(falsey.flag == false, 'an explicit false is not replaced by a true default')

-- ── Required keys are fatal ─────────────────────────────────────────────────

r = config.validate({}, spec())
assert(not r.ok, 'a missing required key fails validation')
local msg = firstMatching(r.errors, 'licenseKey')
assert(msg, 'the error names the missing key')
assert(contains(msg, 'shared/config.lua'), 'the error names the file')
assert(contains(msg, 'required'), 'the error says it is required')

-- ── Every problem is reported, not just the first ───────────────────────────

r = config.validate({
    detectionRangeMeters = 'far',
    speedUnit            = 'knots',
    enableSiren          = 'yes',
}, spec())
assert(not r.ok, 'multiple bad values fail')
assert(#r.errors >= 4,
    'all four problems are reported at once, got ' .. #r.errors)
assert(firstMatching(r.errors, 'detectionRangeMeters'), 'the bad number is reported')
assert(firstMatching(r.errors, 'speedUnit'), 'the bad enum is reported')
assert(firstMatching(r.errors, 'enableSiren'), 'the bad boolean is reported')
assert(firstMatching(r.errors, 'licenseKey'), 'the missing required key is still reported')

-- ── A message names expected, found and a fix ───────────────────────────────

r = config.validate({ detectionRangeMeters = 'far', licenseKey = 'k' }, spec())
msg = firstMatching(r.errors, 'detectionRangeMeters')
assert(contains(msg, 'number'), 'the message says what was expected')
assert(contains(msg, 'far'), 'the message quotes what was found')
assert(contains(msg, 'string'), 'the message names the type that was found')
assert(contains(msg, 'fix'), 'the message offers a fix')

-- The quoted-number case is common enough to earn its own advice.
r = config.validate({ detectionRangeMeters = '500', licenseKey = 'k' }, spec())
msg = firstMatching(r.errors, 'detectionRangeMeters')
assert(msg, 'a quoted number is still an error, not silently coerced')
assert(contains(msg, 'quote'), 'a numeric-looking string is told to drop the quotes')

-- ── Ranges and enums ────────────────────────────────────────────────────────

r = config.validate({ detectionRangeMeters = 9000, licenseKey = 'k' }, spec())
msg = firstMatching(r.errors, 'detectionRangeMeters')
assert(msg, 'an out-of-range number is an error')
assert(contains(msg, '2000'), 'the range message states the limit')
assert(contains(msg, '9000'), 'the range message states what was found')

r = config.validate({ speedUnit = 'knots', licenseKey = 'k' }, spec())
msg = firstMatching(r.errors, 'speedUnit')
assert(contains(msg, 'kmh') and contains(msg, 'mph'),
    'an enum error lists every valid value')

-- An out-of-range value must NOT be silently clamped to the default.
local ranged = { detectionRangeMeters = 9000, licenseKey = 'k' }
config.validate(ranged, spec())
assert(ranged.detectionRangeMeters == 9000,
    'a rejected value is left alone, never silently replaced by the default')

-- ── Unknown keys warn, and suggest the key that was meant ───────────────────

r = config.validate({ licenseKey = 'k', detectionRangeMeters = 500, speedUnit = 'kmh',
    detectionRnge = 400 }, spec())
assert(r.ok, 'an unknown key is a warning, not a failure')
msg = firstMatching(r.warnings, 'detectionRnge')
assert(msg, 'the unknown key is named')
assert(contains(msg, 'detectionRangeMeters'),
    'a near-miss suggests the key that was probably meant')

-- A key nothing resembles gets no bogus suggestion.
r = config.validate({ licenseKey = 'k', somethingEntirelyElse = 1 }, spec())
msg = firstMatching(r.warnings, 'somethingEntirelyElse')
assert(msg, 'a wholly unknown key is still reported')
assert(not contains(msg, 'did you mean'),
    'no suggestion is offered when nothing is close')

-- ── Deprecated keys keep working, and say so once ───────────────────────────

local depSpec = spec({
    deprecated = {
        detectionRange = { replacement = 'detectionRangeMeters', removeIn = '2.0.0' },
    },
})
local old = { detectionRange = 750, licenseKey = 'k' }
r = config.validate(old, depSpec)
assert(r.ok, 'a deprecated key still validates')
assert(old.detectionRangeMeters == 750, 'the old key\'s value is carried to the new key')
msg = firstMatching(r.warnings, 'detectionRange')
assert(msg, 'the deprecation is reported')
assert(contains(msg, 'detectionRangeMeters'), 'the warning names the replacement')
assert(contains(msg, '2.0.0'), 'the warning names the version it stops working in')
assert(not firstMatching(r.warnings, 'did you mean'),
    'a deprecated key is not also reported as an unknown key')

-- The new key wins when both are present.
local both = { detectionRange = 750, detectionRangeMeters = 300, licenseKey = 'k' }
r = config.validate(both, depSpec)
assert(both.detectionRangeMeters == 300, 'an explicit new key beats a deprecated old one')
assert(firstMatching(r.warnings, 'detectionRange'), 'the deprecated key is still flagged')

-- ── list type ───────────────────────────────────────────────────────────────

r = config.validate({ radarResources = 'tRadar', licenseKey = 'k' }, spec())
msg = firstMatching(r.errors, 'radarResources')
assert(msg, 'a scalar where a list belongs is an error')
assert(contains(msg, 'list') or contains(msg, 'table'), 'the message says a list was expected')
assert(contains(msg, '{'), 'the message shows the table syntax as the fix')

-- ── check() returns a boolean and never throws ──────────────────────────────

local ok = config.check({ licenseKey = 'k' }, spec())
assert(ok == true, 'check() returns true for a valid config')
ok = config.check({}, spec())
assert(ok == false, 'check() returns false for an invalid one')

print('PASS: tlib.config reports every problem, names file/key/expected/found/fix, ' ..
    'suggests typos, honours deprecations, and never silently substitutes')

-- ── configured(): the owner's value survives runtime mutation ───────────────
--
-- The case this exists for, found by the tRadar session: `Config.speedUnit` is
-- deliberately the client's LIVE value, rewritten when a player picks a unit.
-- A diagnostic printing the live table reports the player's pick as the owner's
-- setting — a support tool confidently stating something the owner never wrote.

local live = { speedUnit = 'mph', licenseKey = 'k' }
config.check(live, spec({ file = 'shared/radar-config.lua' }))

live.speedUnit = 'kmh'  -- the player picks kmh at runtime

local asConfigured = config.configured('shared/radar-config.lua')
assert(asConfigured, 'a validated config is recoverable afterwards')
assert(asConfigured.speedUnit == 'mph',
    'configured() reports what the owner wrote, not the live mutated value')
assert(live.speedUnit == 'kmh', 'the live table is left alone — it is not restored')

-- Defaults applied during validation are part of what was configured.
assert(asConfigured.detectionRangeMeters == 500.0,
    'an applied default is included in the snapshot')

-- The snapshot is a copy: mutating it must not corrupt the stored one.
asConfigured.speedUnit = 'tampered'
assert(config.configured('shared/radar-config.lua').speedUnit == 'mph',
    'configured() hands back a copy, so a caller cannot corrupt the snapshot')

-- An unknown file is nil, not a wrong answer from some other config.
assert(config.configured('shared/not-validated.lua') == nil,
    'an unvalidated file returns nil rather than another config\'s values')

-- A broken config is still snapshotted — that is exactly when a diagnostic
-- needs to show what the file said.
config.check({ detectionRangeMeters = 'far' }, spec({ file = 'shared/broken.lua' }))
local broken = config.configured('shared/broken.lua')
assert(broken and broken.detectionRangeMeters == 'far',
    'a failed validation still records what the owner wrote')

-- With more than one config validated, a bare configured() must refuse to guess.
assert(config.configured() == nil,
    'configured() with no file returns nil when several configs were validated')

print('PASS: tlib.config.configured preserves the owner\'s values against runtime mutation')
