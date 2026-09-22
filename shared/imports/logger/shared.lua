--[[
    tLib/shared/imports/logger — levelled console logging for consumer resources.

    Usage in a consumer:
        local log = tlib.logger.create('tDetector')
        log('layout not installed, falling back', 3)   -- WARN
        log('armed', tlib.logger.DEBUG)

    Why this is not shared/lib/logger.lua
    ------------------------------------
    That file is tLib's own and binds `Platform.getSide()` at load time. A
    consumer VM has no such global: shared/imports/platform returns a *local* table and
    does not expose getSide, so loading shared/lib/logger.lua here errors. tLib
    also registers CreateLogger as an export from client.lua only, which leaves
    every server-side consumer with nothing.

    So this stands alone, on purpose, for the same reason imports.lua carries its
    own copy of parseVer: it runs in the consumer's VM, not tLib's. Keep the
    output format in step with shared/lib/logger.lua's `[scope][LEVEL] message`.
]]

local Logger = {}

Logger.DEBUG = 1
Logger.INFO  = 2
Logger.WARN  = 3
Logger.ERROR = 4

local _labels = { [1] = 'DEBUG', [2] = 'INFO', [3] = 'WARN', [4] = 'ERROR' }

-- FiveM console colour codes. WARN and ERROR are the only ones worth tinting —
-- colouring routine INFO lines makes a busy console harder to read, not easier.
local _colours = { [3] = '^3', [4] = '^1' }

local _minLevel = 2

--- Set the minimum level for every logger created in this VM.
function Logger.setLevel(level)
    assert(type(level) == 'number', '[tLib/logger] setLevel: level must be a number')
    _minLevel = level
end

function Logger.getLevel()
    return _minLevel
end

--- Format a line, or nil when it is filtered or empty.
---
--- Returned rather than printed so a caller can route it somewhere other than
--- the console, and so this is testable without capturing stdout.
function Logger.format(scope, args, n)
    local lvl = 2
    if n > 0 and type(args[n]) == 'number' then
        lvl = args[n]
        n   = n - 1
    end

    -- Filter before doing any string work.
    if lvl < _minLevel then return nil end

    local parts = {}
    for i = 1, n do
        parts[i] = tostring(args[i])
    end
    local text = table.concat(parts, ' ')

    -- A call carrying only a level, with no body: discard rather than emitting
    -- an empty labelled line.
    if text == '' then return nil end

    local colour = _colours[lvl]
    local line   = string.format('[%s][%s] %s', scope, _labels[lvl] or 'INFO', text)
    if colour then return colour .. line .. '^0' end
    return line
end

--- Returns a log function pinned to a scope, conventionally the resource name:
---   local log = tlib.logger.create('tDetector')
---   log('Bad value', val, tlib.logger.WARN)
---
--- Args are tostring'd and joined with spaces; a trailing number is the level.
function Logger.create(scope)
    assert(
        type(scope) == 'string' and scope ~= '',
        '[tLib/logger] create: scope must be a non-empty string'
    )
    return function(...)
        local args = { ... }
        local line = Logger.format(scope, args, select('#', ...))
        if line then print(line) end
    end
end

return Logger
