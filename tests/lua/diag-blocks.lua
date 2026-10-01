-- shared/imports/diag: the console blocks every t* resource prints when something
-- an operator has to fix has gone wrong.
--
-- The module is pure rendering, so this suite is mostly about shape: the caller
-- writes prose, and the block that comes out has to be the same shape as the
-- hand-written ones it replaces -- because those are what operators already
-- recognise, and because a drifting shape is how these stop reading as one voice.

local realPrint = print
local printed = {}

GetCurrentResourceName = function() return 'tRadio' end

local diag = assert(loadfile('shared/imports/diag/shared.lua'))()

local function capture(fn)
    printed = {}
    print = function(...)
        local parts = {}
        for i = 1, select('#', ...) do parts[i] = tostring((select(i, ...))) end
        printed[#printed + 1] = table.concat(parts, ' ')
    end
    fn()
    print = realPrint
    return printed
end

local function joined() return table.concat(printed, '\n') end

local function contains(needle)
    return joined():find(needle, 1, true) ~= nil
end

-- ── wrap ────────────────────────────────────────────────────────────────────

local lines = diag.wrap('one two three four five six seven eight nine ten', 20)
for _, l in ipairs(lines) do
    assert(#l <= 20, 'no wrapped line exceeds the width: ' .. l)
end
assert(table.concat(lines, ' ') == 'one two three four five six seven eight nine ten',
    'and wrapping loses no words')

-- A path or a URL is the thing an operator copies out of the console. Splitting
-- one to respect the column would be a worse answer than an over-long line.
local url = 'https://docs.timmygstudios.com/docs/tRadio/configuration'
local whole = false
for _, l in ipairs(diag.wrap('see ' .. url .. ' now', 20)) do
    if l:find(url, 1, true) then whole = true end
end
assert(whole, 'a single over-long word is left whole rather than broken mid-URL')

local hung = diag.wrap('  - alpha beta gamma delta epsilon zeta', 16, '    ')
assert(hung[1]:sub(1, 4) == '  - ', 'a bulleted first line keeps its dash')
assert(hung[2]:sub(1, 4) == '    ', 'and the continuation hangs under the text, not the dash')

-- ── render ──────────────────────────────────────────────────────────────────

local block = diag.render('fatal', 'Config does not exist.', {
    cause  = 'config/config.lua failed to load.',
    fix    = 'Scroll up for the file and line.',
    detail = 'Everything after this is a consequence.',
})

assert(block[1] == block[#block], 'the block opens and closes with the same rule')
assert(block[1]:find('^1', 1, true), 'a fatal block is red')
assert(block[1]:find('[tRadio]', 1, true),
    'and is scoped to the calling resource, not to tLib')
assert(table.concat(block, '\n'):find('FATAL: Config does not exist.', 1, true),
    'fatal prefixes its title, so the severity is in the first line an operator reads')
assert(table.concat(block, '\n'):find('To fix:', 1, true), 'one fix reads as a singular instruction')

local several = table.concat(diag.render('warn', 'x', { fix = { 'a', 'b' } }), '\n')
assert(several:find('Fix it one of these ways:', 1, true),
    'and several read as a choice -- an operator must not think they need all of them')
assert(several:find('^3', 1, true), 'a warn block is yellow, not red')

-- Blank separator lines still carry the prefix. Without it FiveM trims the line
-- and the block loses its left edge halfway down, which looks like two blocks.
local blanks = 0
for _, l in ipairs(block) do
    if l:find('%[tRadio%] %s*%^7$') then blanks = blanks + 1 end
end
assert(blanks >= 3, 'cause, fix and detail are each separated by a prefixed blank line')

-- ── say and once ────────────────────────────────────────────────────────────

diag.reset()
capture(function()
    assert(diag.fatal('first', { once = 'boot' }) == true, 'the first call prints')
    assert(diag.fatal('second', { once = 'boot' }) == false, 'the second under the same key does not')
end)
assert(contains('first'), 'and it is the first message that survives')
assert(not contains('second'),
    'not the second -- a repeat on a busy server buries the message it is delivering')
assert(diag.said('boot'), 'said() reports the key without printing anything')

diag.reset()
capture(function() diag.fatal('again', { once = 'boot' }) end)
assert(contains('again'),
    'reset re-arms it, because a resource restart is exactly when an operator is looking')

diag.reset()
capture(function()
    diag.warn('a', { once = 'one' })
    diag.warn('b', { once = 'two' })
end)
assert(contains('a') and contains('b'), 'distinct keys are independent')

-- A caller with no `once` is saying "print this every time"; suppressing it
-- silently would be the module deciding something it has no business deciding.
diag.reset()
capture(function()
    diag.warn('repeated')
    diag.warn('repeated')
end)
local seen = 0
for _, l in ipairs(printed) do if l:find('repeated', 1, true) then seen = seen + 1 end end
assert(seen == 2, 'without a once key, nothing is suppressed')

-- ── scope ───────────────────────────────────────────────────────────────────

local scoped = diag.render('warn', 'x', { scope = 'tDetector' })
assert(scoped[1]:find('[tDetector]', 1, true),
    'an explicit scope wins, for a module printing on behalf of another resource')

print = realPrint
print('PASS diag-blocks')
