-- shared/lib/logger.lua: a trailing nil argument.
-- `#{...}` stops before one, so `log('name:', nil)` printed just `name:`.

Platform = { getSide = function() return 'server' end }

local realPrint = print

--- The lines one call produced. print is always restored, or a failing assertion
--- would lose its own traceback to the capture still being installed.
local function capture(fn)
    local lines = {}
    print = function(line) lines[#lines + 1] = line end
    local ok, err = pcall(fn)
    print = realPrint
    if not ok then error(err, 0) end
    return lines
end

dofile('shared/lib/logger.lua')
local log = Logger.create('tLib/probe')

local lines = capture(function() log('name:', nil) end)
assert(#lines == 1, 'a trailing nil still emits one line, got ' .. #lines)
assert(lines[1] == '[tLib/probe][INFO] name: nil',
    'a trailing nil is rendered rather than truncating the message, got: ' .. tostring(lines[1]))

lines = capture(function() log('a', nil, 3) end)
assert(#lines == 1, 'a trailing level after a nil still emits one line, got ' .. #lines)
assert(lines[1]:find('[WARN]', 1, true) ~= nil,
    'the trailing number is still consumed as the level, got: ' .. tostring(lines[1]))
assert(lines[1] == '[tLib/probe][WARN] a nil',
    'and the nil before it is part of the body, got: ' .. tostring(lines[1]))

lines = capture(function() Logger.log('name:', nil) end)
assert(lines[1] == '[server][INFO] name: nil',
    'the unpinned logger keeps the nil too, under the side label, got: ' .. tostring(lines[1]))

lines = capture(function() log('x', 1) end)
assert(#lines == 0, 'level 1 is below the default minimum of 2 and prints nothing')

print('PASS logger-trailing-nil')
