-- shared/imports/config: `tlib.config.generation`, the "your copy of a file we
-- ship is older than this build" check.
--
-- WHY IT EXISTS. Every t* resource ships files the operator is expected to merge
-- forward by hand. tRadio has had this on its SERVER config since v6.3.1 and
-- nothing on its client config, where the same drift has cost two runs of
-- tickets: `MakeAnimHandler` -> `RadioMakeAnimHandler`, then
-- `resolveSirenSystem` -> `RadioResolveSirenMode` / `_k9Hashes` ->
-- `RadioIsK9Ped`. The operator's hook calls a global that no longer exists, the
-- caller pcalls it, and the audio is silent with nothing in any console.
--
-- What is asserted here is the two-sided behaviour, not "it printed something":
-- a check that always warns is as useless as one that never does, and both pass
-- a one-sided suite.
--
-- NEGATIVE CONTROL: run with CONFIG_GEN_CONTROL=1 and the subject is replaced by
-- one that always reports ok and never prints -- the shape this would silently
-- degrade into if the comparison were dropped. Every assertion below that
-- depends on a stale copy being REPORTED then has to fail, and the suite exits
-- non-zero naming which.
--
--   bun run test:lua                                         # gate
--   CONFIG_GEN_CONTROL=1 bunx --bun --package fengari-node-cli fengari \
--       scripts/run-lua-suite.lua tests/lua/config-generation.lua   # must exit 1
--
-- Run from the tLib resource root.

local CONTROL = os.getenv('CONFIG_GEN_CONTROL') == '1'

GetCurrentResourceName = function() return 'tProbe' end

local printed = {}
local realPrint = print
local rawassert = assert
print = function(s) printed[#printed + 1] = tostring(s) end

local function fail(message)
    print = realPrint
    for _, line in ipairs(printed) do realPrint('  captured: ' .. line) end
    rawassert(false, message)
end

local function must(condition, message)
    if not condition then fail(message) end
end

--- An assertion the control has to INVERT. Everything that depends on a stale
--- copy actually being REPORTED goes through this one, so disabling the subject
--- cannot leave the suite green. An assertion that still holds with the subject
--- disabled is not measuring the subject, and the verdict at the bottom refuses
--- the run on the count rather than on "it printed CONTROL OK" -- an absence
--- assertion holds either way and belongs in `must`.
local flipped = 0

local function reports(condition, message)
    if CONTROL then
        if condition then
            fail('CONTROL: still holds with the comparison disabled, so this check is '
                .. 'not measuring it -- ' .. message)
        end
        flipped = flipped + 1
    elseif not condition then
        fail(message)
    end
end

local config = dofile('shared/imports/config/shared.lua')

if CONTROL then
    config.generation = function(opts)
        return { ok = true, declared = 0, expected = tonumber(opts.expected) or 0, lines = {} }
    end
end

local function run(over)
    printed = {}
    local opts = { file = 'config/cl_functions.lua', expected = 4 }
    for k, v in pairs(over or {}) do opts[k] = v end
    return config.generation(opts), table.concat(printed, '\n')
end

-- A copy that predates the constant entirely

-- The case that MUST report: every copy older than the mechanism has no constant
-- at all, so nil has to read as "old" rather than as "cannot tell".
local verdict, text = run({ declared = nil })
reports(verdict.ok == false, 'a copy with no generation constant must not read as current')
must(verdict.declared == 0, 'an absent constant reads as v0, got ' .. tostring(verdict.declared))
reports(text:find('config/cl_functions.lua', 1, true) ~= nil,
    'the report must name the file the operator has to re-merge')
reports(text:find('v0', 1, true) ~= nil and text:find('v4', 1, true) ~= nil,
    'the report must state both generations, or the operator cannot tell how far behind they are')
reports(text:find('[tProbe]', 1, true) ~= nil,
    'every line must carry the resource, or it is unattributable in a busy console')

-- Types an operator's file actually contains

-- Hand-edited to a string. tonumber(), not a type test, so this still compares.
verdict = run({ declared = '4' })
must(verdict.ok, 'a quoted number must compare as a number')

-- Garbage must degrade to "old", never throw: this runs in a startup path, and
-- a throw here takes the rest of the consumer's file with it.
for _, junk in ipairs({ 'abc', true, {} }) do
    local ok, result = pcall(config.generation,
        { file = 'config/cl_functions.lua', expected = 4, declared = junk })
    must(ok, 'a garbage constant must not throw, got: ' .. tostring(result))
    reports(result.ok == false, 'a garbage constant must read as old, not as current')
end

-- A consumer that passes no `expected` has a bug in ITSELF, and a comparison
-- against nil would quietly pass every copy. That one does throw.
reports(not pcall(config.generation, { file = 'x', declared = 4 }),
    'a missing `expected` must raise rather than pass everything')

-- Current, and newer

-- Silence is the whole point of the current case: a check that prints on a
-- correct install is a check an operator learns to scroll past.
verdict, text = run({ declared = 4 })
must(verdict.ok, 'a copy at the expected generation is current')
must(text == '', 'a current copy must print nothing, got: ' .. text)
must(#verdict.lines == 0, 'a current copy must report no lines')

-- Newer than the build: a real state (the resource was rolled back and config/
-- was not) with the OPPOSITE fix, so it must not be worded as a stale copy.
verdict, text = run({ declared = 9 })
must(verdict.ok, 'a newer copy is not an error')
reports(text:find('NEWER', 1, true) ~= nil, 'a newer copy must be reported as newer')
-- `must`, not `reports`: an assertion about text being ABSENT holds trivially
-- when nothing was printed at all, so it cannot flip and would make the control's
-- count a lie.
must(text:find('is older', 1, true) == nil,
    'a newer copy must not be described as older -- that sends the operator the wrong way')

-- The resource's own account of the bump

-- The generic half of the message is tLib's; what changed in THIS bump is the
-- resource's, and it is the only part that tells an operator what they lost.
verdict, text = run({ declared = 1, detail = 'v4 renamed the siren hooks.\nRadioResolveSirenMode, RadioIsK9Ped.' })
reports(text:find('RadioResolveSirenMode', 1, true) ~= nil, 'detail must reach the console')
reports(text:find('v4 renamed the siren hooks.', 1, true) ~= nil,
    'a multi-line detail must be carried line by line, not concatenated')

-- The returned lines are what a `<resource>_diag` reprints, so they have to be
-- the same text, without the colour codes and the prefix.
verdict = run({ declared = 1, detail = 'see the changelog' })
local joined = table.concat(verdict.lines, '\n')
reports(joined:find('see the changelog', 1, true) ~= nil,
    'the verdict must carry the lines, so a diagnostic can show them too')
must(joined:find('^3', 1, true) == nil, 'the returned lines must not carry console colour codes')

print = realPrint
if CONTROL then
    -- Counted, not merely reached. A stale counter is how a control comes to
    -- announce that it proved something it no longer measures: there are 12
    -- `reports` call sites in this file.
    local expected = 12
    if flipped ~= expected then
        realPrint(('CONTROL FAILED: %d of %d assertions flipped with the comparison disabled.')
            :format(flipped, expected))
        os.exit(1)
    end
    realPrint(('CONTROL OK: all %d assertions flipped, so the gate above can fail.'):format(expected))
    -- 0, following tests/lua/secrets-overlay.lua rather than diag-command.lua:
    -- a control that exits non-zero on success cannot be chained into a script,
    -- and an unwired control proves nothing. See `test:lua:control`.
    os.exit(0)
end
realPrint('config-generation: ok')
