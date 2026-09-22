-- shared/imports/logger: the consumer-side logger.
--
-- Pinned because five resources previously hand-rolled this, two of them with a
-- byte-identical one-line `log(msg, level)` that differed only by prefix, and
-- each had its own idea of what a level meant. The format is asserted here so
-- converging them cannot silently change what a server operator sees in console.
--
-- Note the inverted level convention those stubs used: `if (level or 3) <= 3`
-- printed *unless* the level was above 3. Here a higher level is more severe and
-- prints when it is >= the minimum, matching shared/lib/logger.lua.

local logger = dofile('shared/imports/logger/shared.lua')

local realPrint = print

-- Capture the lines one call produces, always restoring print before returning:
-- an override left in place swallows the assertion traceback and turns a failing
-- suite into a silent non-zero exit.
local function capture(fn)
    local lines = {}
    print = function(line) lines[#lines + 1] = line end
    local ok, err = pcall(fn)
    print = realPrint
    if not ok then error(err, 0) end
    return lines
end

local log = logger.create('tDetector')

local lines = capture(function() log('plain message') end)
assert(lines[1] == '[tDetector][INFO] plain message',
    'default level is INFO and the scope leads the line, got: ' .. tostring(lines[1]))

lines = capture(function() log('a value:', '42') end)
assert(lines[1] == '[tDetector][INFO] a value: 42',
    'args are tostring\'d and space-joined, got: ' .. tostring(lines[1]))

-- The sharp edge worth pinning: a TRAILING NUMBER is consumed as the level, so
-- log('count', 4) logs "count" at ERROR rather than logging "count 4".
lines = capture(function() log('count', 4) end)
assert(lines[1] == '^1[tDetector][ERROR] count^0',
    'a trailing number is the level, not an arg, got: ' .. tostring(lines[1]))

lines = capture(function() log('something looks off', logger.WARN) end)
assert(lines[1] == '^3[tDetector][WARN] something looks off^0',
    'WARN is tinted yellow and reset, got: ' .. tostring(lines[1]))

lines = capture(function() log('it broke', logger.ERROR) end)
assert(lines[1] == '^1[tDetector][ERROR] it broke^0',
    'ERROR is tinted red and reset, got: ' .. tostring(lines[1]))

-- DEBUG is below the default minimum of INFO, so it is filtered.
lines = capture(function() log('noisy internals', logger.DEBUG) end)
assert(#lines == 0, 'DEBUG is filtered at the default level')

logger.setLevel(logger.DEBUG)
lines = capture(function() log('noisy internals', logger.DEBUG) end)
assert(lines[1] == '[tDetector][DEBUG] noisy internals',
    'DEBUG prints once the minimum is lowered, got: ' .. tostring(lines[1]))

logger.setLevel(logger.ERROR)
lines = capture(function() log('warned', logger.WARN) end)
assert(#lines == 0, 'raising the minimum filters everything below it')
logger.setLevel(logger.INFO)

-- An empty body must not produce a bare labelled line.
lines = capture(function() log(logger.WARN) end)
assert(#lines == 0, 'a call carrying only a level emits nothing')

-- Two loggers in one VM share the level but not the scope.
local other = logger.create('tRadar')
lines = capture(function() other('from radar') end)
assert(lines[1] == '[tRadar][INFO] from radar',
    'scope is per-logger, got: ' .. tostring(lines[1]))

assert(not (pcall(logger.create, '')),
    'an empty scope is rejected rather than producing "[][INFO] ..."')
assert(not (pcall(logger.create, nil)), 'a nil scope is rejected')

print('PASS: consumer logger formats, tints, filters by level and pins its scope')
